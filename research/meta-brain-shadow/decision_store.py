"""Compact canonical evidence, bounded runtime state, and verified day retention.

No exchange execution interfaces or Orayan database access exist in this module.
SQLite is the local qualification adapter; production uses dedicated PostgreSQL.
"""
import base64
import hashlib
import io
import json
import math
import os
import sqlite3
import time
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=5,minutes=30))
WINDOW = 30*3600000
SCHEMA = 'meta-brain-decision-first-2.0'
STREAMS = frozenset(('definitions','orayan_signal_observed','meta_decision','decision_comparison',
                     'lifecycle_outcome','loss_attribution','lesson','integrity','registered_experiment'))

def packed(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)
def digest(value):return hashlib.sha256(packed(value).encode()).hexdigest()
def day(at):return datetime.fromtimestamp(at/1000,TZ).date().isoformat()
def boundaries(date):
    start=datetime.fromisoformat(date).replace(tzinfo=TZ)
    return int(start.timestamp()*1000),int((start+timedelta(days=1)).timestamp()*1000)

class CompactStore:
    def __init__(self,connection,epoch,postgres=False,temporary=False,commit_initialization=True):
        self.conn=connection;self.epoch=epoch;self.postgres=postgres
        for sql in (
            'CREATE TABLE IF NOT EXISTS mb_events(id TEXT PRIMARY KEY,stream TEXT NOT NULL,episode_id TEXT,event_ms BIGINT NOT NULL,observed_ms BIGINT NOT NULL,record TEXT NOT NULL,sha256 TEXT NOT NULL)',
            'CREATE INDEX IF NOT EXISTS mb_events_clock ON mb_events(observed_ms)',
            'CREATE INDEX IF NOT EXISTS mb_events_episode ON mb_events(episode_id,stream)',
            'CREATE TABLE IF NOT EXISTS mb_state(key TEXT PRIMARY KEY,record TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS mb_archives(date TEXT PRIMARY KEY,record TEXT NOT NULL,payload BYTEA NOT NULL)',
            'CREATE TABLE IF NOT EXISTS mb_external(date TEXT PRIMARY KEY,record TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS mb_performance(bucket TEXT PRIMARY KEY,record TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS mb_resolved(id TEXT PRIMARY KEY,at BIGINT NOT NULL,bucket TEXT NOT NULL)',
            'CREATE TABLE IF NOT EXISTS mb_pending(episode_id TEXT PRIMARY KEY,record TEXT NOT NULL)'):
            self.execute(sql.replace('CREATE TABLE','CREATE TEMP TABLE') if temporary else sql)
        if postgres:
            function=('pg_temp.' if temporary else '')+'mb_forbid_update'
            self.execute("CREATE OR REPLACE FUNCTION "+function+"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable research evidence'; END $$")
            for table in ('mb_events','mb_archives','mb_external'):
                self.execute('DROP TRIGGER IF EXISTS mb_immutable_update ON '+table)
                self.execute('CREATE TRIGGER mb_immutable_update BEFORE UPDATE ON '+table+' FOR EACH ROW EXECUTE FUNCTION '+function+'()')
        else:
            for table in ('mb_events','mb_archives','mb_external'):
                self.execute("CREATE TRIGGER IF NOT EXISTS "+table+"_immutable BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT,'Immutable research evidence'); END")
        if commit_initialization:self.conn.commit()
        prior=self.state('epoch')
        if prior and prior['id']!=epoch:raise RuntimeError('Epoch mismatch')
        self.set_state('epoch',prior or {'id':epoch,'schema':SCHEMA})
        if commit_initialization:self.conn.commit()

    @classmethod
    def production(cls,epoch):
        import psycopg
        c=psycopg.connect(host=os.environ['PGHOST'],port=os.environ.get('PGPORT','5432'),dbname=os.environ['PGDATABASE'],
            user=os.environ['PGUSER'],password=os.environ['PGPASSWORD'],sslmode=os.environ.get('PGSSLMODE','require'),connect_timeout=15)
        c.execute('SET synchronous_commit=on')
        if not c.execute('SELECT pg_try_advisory_lock(31062026)').fetchone()[0]:raise RuntimeError('Another Meta Brain writer exists')
        # Refuse startup while the legacy epoch still exists; reset is an explicit separate gate.
        if c.execute("SELECT to_regclass('public.capture_chunks')").fetchone()[0]:raise RuntimeError('LEGACY_RESET_NOT_VERIFIED')
        return cls(c,epoch,True)

    def execute(self,sql,args=()):return self.conn.execute(sql.replace('?', '%s') if self.postgres else sql,args)
    @contextmanager
    def transaction(self):
        try:yield;self.conn.commit()
        except BaseException:self.conn.rollback();raise
    def state(self,key):
        r=self.execute('SELECT record FROM mb_state WHERE key=?',(key,)).fetchone();return json.loads(r[0]) if r else None
    def set_state(self,key,value):
        self.execute('INSERT INTO mb_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET record=excluded.record',(key,packed(value)))
    def add(self,stream,event_id,episode,event_ms,observed_ms,record):
        if stream not in STREAMS:raise ValueError('Unregistered compact stream')
        if record.get('schema',SCHEMA)!=SCHEMA or record.get('epoch',self.epoch)!=self.epoch:raise ValueError('Canonical lineage mismatch')
        if int(event_ms)>int(observed_ms):raise ValueError('Future event clock')
        envelope={'schema':SCHEMA,'epoch':self.epoch,'shadow_only':True,'execution_enabled':False,**record}
        if envelope.get('execution_enabled') is not False or envelope.get('shadow_only') is not True:raise ValueError('Execution prohibited')
        data=packed(envelope)
        if len(data.encode())>128*1024:raise ValueError('Evidence row exceeds compact bound')
        checksum=hashlib.sha256(data.encode()).hexdigest()
        prior=self.execute('SELECT sha256 FROM mb_events WHERE id=?',(event_id,)).fetchone()
        if prior:
            if prior[0]!=checksum:raise ValueError('Immutable event ID collision')
            return False
        self.execute('INSERT INTO mb_events VALUES(?,?,?,?,?,?,?)',(event_id,stream,episode,int(event_ms),int(observed_ms),data,checksum));return True
    def events(self,start,end):
        query='SELECT id,stream,episode_id,event_ms,observed_ms,record,sha256 FROM mb_events WHERE observed_ms>=? AND observed_ms<? ORDER BY observed_ms,id'
        keys=('id','stream','episode_id','event_ms','observed_ms','record','sha256')
        if self.postgres:
            # A normal libpq cursor buffers every row. Named cursors keep both
            # daily and current exports bounded independently of the day size.
            with self.conn.cursor(name='compact_export_'+uuid.uuid4().hex) as cursor:
                cursor.itersize=128;cursor.execute(query.replace('?','%s'),(start,end))
                for row in cursor:
                    value=dict(zip(keys,row));value['record']=json.loads(value['record']);yield value
        else:
            for row in self.execute(query,(start,end)):
                value=dict(zip(keys,row));value['record']=json.loads(value['record']);yield value
    def get_event(self,event_id):
        row=self.execute('SELECT record FROM mb_events WHERE id=?',(event_id,)).fetchone();return json.loads(row[0]) if row else None
    def pending(self,episode):
        row=self.execute('SELECT record FROM mb_pending WHERE episode_id=?',(episode,)).fetchone();return json.loads(row[0]) if row else None
    def set_pending(self,episode,record):
        data=packed(record)
        if len(data.encode())>512*1024:raise RuntimeError('PENDING_EPISODE_SIZE_PRESSURE')
        if not self.pending(episode) and self.execute('SELECT count(*) FROM mb_pending').fetchone()[0]>=2000:
            raise RuntimeError('PENDING_EPISODE_POPULATION_PRESSURE')
        self.execute('INSERT INTO mb_pending VALUES(?,?) ON CONFLICT(episode_id) DO UPDATE SET record=excluded.record',(episode,data))

    def compact_pending(self,now):
        # Working episode state is not a second permanent event archive. Keep
        # unresolved joins up to seven days; an explicit censor records expiry.
        for episode,text in self.execute('SELECT episode_id,record FROM mb_pending'):
            row=json.loads(text)
            if row.get('resolved') and row.get('resolved_ms',now)<now-WINDOW:
                self.execute('DELETE FROM mb_pending WHERE episode_id=?',(episode,))
            elif row.get('observed_ms',now)<now-7*86400000:
                self.add('integrity','pending-expired:'+episode,episode,now,now,
                    {'kind':'UNRESOLVED_JOIN_RETENTION_CENSOR','birth_observed_ms':row.get('observed_ms'),
                     'source_refs':[{'event_id':row.get('candidate_event_id'),'owner_date':day(row['observed_ms'])}],
                     'future_endpoint_join_not_assumed':True})
                self.execute('DELETE FROM mb_pending WHERE episode_id=?',(episode,))
        self.execute('DELETE FROM mb_resolved WHERE at<?',(now-7*86400000,))

    def trust(self,bucket,cutoff):
        row=self.execute('SELECT record FROM mb_performance WHERE bucket=?',(bucket,)).fetchone()
        result=json.loads(row[0]) if row else {'bucket':bucket,'count':0,'wins':0,'losses':0,'sum_r':0.,'max_resolved_ms':0,'max_observed_ms':0}
        # A cutoff before the aggregate's last inclusion cannot use that version.
        if result['max_resolved_ms']>=cutoff or result['max_observed_ms']>=cutoff:return {'status':'CUTOFF_BEFORE_SUMMARY','count':0,'version':None}
        return {**result,'version':digest(result),'evaluation_cutoff_ms':cutoff,'status':'BOUNDED_HISTORICAL_STATISTICS_ONLY'}
    def learn(self,resolution_id,bucket,resolved_ms,observed_ms,realized_r):
        if not isinstance(realized_r,(int,float)) or not math.isfinite(realized_r):return
        if resolved_ms>observed_ms:raise ValueError('Future outcome')
        if self.execute('SELECT 1 FROM mb_resolved WHERE id=?',(resolution_id,)).fetchone():return
        row=self.execute('SELECT record FROM mb_performance WHERE bucket=?',(bucket,)).fetchone()
        stats=json.loads(row[0]) if row else {'bucket':bucket,'count':0,'wins':0,'losses':0,'sum_r':0.,'max_resolved_ms':0,'max_observed_ms':0}
        stats['count']+=1;stats['wins']+=int(realized_r>0);stats['losses']+=int(realized_r<0)
        stats['sum_r']+=max(-10.,min(10.,float(realized_r)))
        stats['max_resolved_ms']=max(stats['max_resolved_ms'],resolved_ms);stats['max_observed_ms']=max(stats['max_observed_ms'],observed_ms)
        self.execute('INSERT INTO mb_resolved VALUES(?,?,?)',(resolution_id,observed_ms,bucket))
        self.execute('INSERT INTO mb_performance VALUES(?,?) ON CONFLICT(bucket) DO UPDATE SET record=excluded.record',(bucket,packed(stats)))

    def zip_events(self,rows,kind,coverage):
        output=io.BytesIO();counts={};h=hashlib.sha256();size=0;dependencies={};ids={}
        # Daily datasets have a deliberate safety bound; pressure pauses instead of consuming 512MB.
        with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
            with z.open('events.ndjson','w') as f:
                for row in rows:
                    if row['id'] in ids:
                        if ids[row['id']]!=digest(row):raise RuntimeError('Archive/live event identity conflict')
                        continue
                    ids[row['id']]=digest(row);line=(packed(row)+'\n').encode();size+=len(line)
                    if size>128*1024*1024:raise RuntimeError('COMPACT_ARCHIVE_SIZE_PRESSURE')
                    f.write(line);h.update(line);counts[row['stream']]=counts.get(row['stream'],0)+1
                    for ref in row['record'].get('source_refs',[]):
                        if isinstance(ref,dict) and ref.get('event_id'):dependencies[ref['event_id']]=ref
            manifest={'schema':SCHEMA,'epoch':self.epoch,'kind':kind,'partition_timezone':'Asia/Colombo','coverage':coverage,
                'complete':True,'counts':counts,'event_count':len(ids),'dependencies':dependencies,
                'files':{'events.ndjson':{'bytes':size,'sha256':h.hexdigest(),'rows':len(ids)}},
                'source_clock':'observed_ms; outcomes are appended at actual observation, never backdated into decisions',
                'lineage':self.state('lineage'),'gaps_censors':'integrity and lifecycle_outcome events; no market-completeness claim',
                'archive_sha256':'downloaded ZIP checksum supplied separately'}
            z.writestr('manifest.json',packed(manifest))
        payload=output.getvalue();self.verify_zip(payload);return payload,manifest

    @staticmethod
    def verify_zip(payload):
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            if z.testzip() is not None:raise RuntimeError('Archive CRC failure')
            manifest=json.loads(z.read('manifest.json'))
            expected=manifest['files']['events.ndjson']
            ids=set();counts={};h=hashlib.sha256();size=0
            with z.open('events.ndjson') as f:
                for line in f:
                    h.update(line);size+=len(line);row=json.loads(line)
                    if row['id'] in ids or digest(row['record'])!=row['sha256']:raise RuntimeError('Archive event identity mismatch')
                    if row['record']['schema']!=manifest['schema'] or row['record']['epoch']!=manifest['epoch']:raise RuntimeError('Archive lineage mismatch')
                    ids.add(row['id']);counts[row['stream']]=counts.get(row['stream'],0)+1
            if h.hexdigest()!=expected['sha256'] or size!=expected['bytes']:raise RuntimeError('Archive manifest mismatch')
            if len(ids)!=manifest['event_count'] or counts!=manifest['counts']:raise RuntimeError('Archive population mismatch')
        return manifest

    def publish_day(self,date,now):
        start,end=boundaries(date)
        if end>now:raise ValueError('Open Colombo day is not immutable')
        prior=self.execute('SELECT record,payload FROM mb_archives WHERE date=?',(date,)).fetchone()
        if prior:return json.loads(prior[0])
        # Never retain an eighth completed day without first safely externalizing the oldest.
        self.retire_archives(now,make_room=True)
        payload,manifest=self.zip_events(self.events(start,end),'completed_day',{'date':date,'start_ms':start,'end_ms_exclusive':end})
        info={'date':date,'sha256':hashlib.sha256(payload).hexdigest(),'bytes':len(payload),'manifest':manifest,'verified':True,'published_at_ms':now}
        self.execute('INSERT INTO mb_archives VALUES(?,?,?)',(date,packed(info),payload));return info
    def mark_external(self,date,checksum,location,verified_at):
        row=self.execute('SELECT record FROM mb_archives WHERE date=?',(date,)).fetchone()
        if not row or json.loads(row[0])['sha256']!=checksum:raise ValueError('External copy does not match published archive')
        if not location:raise ValueError('External location required')
        receipt={'date':date,'sha256':checksum,'external_location':location,'verified_at_ms':verified_at,'verification':'CRC_MANIFEST_HASH_COUNTS_PASS'}
        existing=self.execute('SELECT record FROM mb_external WHERE date=?',(date,)).fetchone()
        if existing and json.loads(existing[0])['sha256']!=checksum:raise ValueError('Immutable externalization receipt mismatch')
        self.execute('INSERT INTO mb_external VALUES(?,?) ON CONFLICT(date) DO NOTHING',(date,packed(receipt)))
    def retire_archives(self,now,make_room=False):
        rows=self.execute('SELECT date,record FROM mb_archives ORDER BY date').fetchall();maximum=6 if make_room else 7
        earliest=day(boundaries(day(now))[0]-7*86400000) if self.state('epoch').get('started_ms') is not None else None
        while rows and (len(rows)>maximum or earliest is not None and rows[0][0]<earliest):
            date,raw=rows[0];info=json.loads(raw);receipt=self.execute('SELECT record FROM mb_external WHERE date=?',(date,)).fetchone()
            if not receipt or json.loads(receipt[0])['sha256']!=info['sha256']:raise RuntimeError('RETENTION_WAITING_FOR_VERIFIED_EXTERNAL_COPY')
            self.execute('DELETE FROM mb_archives WHERE date=?',(date,));rows.pop(0)
    def compact_current(self,now):
        cutoff=now-WINDOW
        for owner in set(day(t) for (t,) in self.execute('SELECT observed_ms FROM mb_events WHERE observed_ms<?',(cutoff,))):
            published=self.execute('SELECT record FROM mb_archives WHERE date=?',(owner,)).fetchone()
            if not published or not json.loads(published[0])['verified']:raise RuntimeError('HOT_COMPACTION_WAITING_FOR_DAILY_ARCHIVE')
        # Every removed event is already in a fully verified, downloadable immutable daily ZIP.
        self.execute('DELETE FROM mb_events WHERE observed_ms<?',(cutoff,))
        self.set_state('hot_compaction',{'through_ms':cutoff,'at_ms':now})
    def current_export(self,now):
        start=now-WINDOW
        epoch=self.state('epoch') or {}
        compacted=(self.state('hot_compaction') or {}).get('through_ms',0)
        # If a previous eviction crossed this window, its closed-day material
        # must still be present. Missing day archives can never claim completeness.
        owner=day(max(start,epoch.get('started_ms',start)))
        while boundaries(owner)[0]<min(compacted,now):
            if boundaries(owner)[1]>start and not self.execute('SELECT 1 FROM mb_archives WHERE date=?',(owner,)).fetchone():
                raise RuntimeError('CURRENT_EXPORT_MISSING_ARCHIVE_COVERAGE')
            owner=day(boundaries(owner)[1])
        def selected():
            yield from self.events(start,now+1)
            for date,payload in self.execute('SELECT date,payload FROM mb_archives WHERE date>=? AND date<=? ORDER BY date',(day(start),day(now))):
                lo,hi=boundaries(date)
                if hi<=start or lo>now:continue
                with zipfile.ZipFile(io.BytesIO(bytes(payload))) as z:
                    with z.open('events.ndjson') as f:
                        for line in f:
                            row=json.loads(line)
                            if start<=row['observed_ms']<=now:yield row
        return self.zip_events(selected(),'current_30h',{'start_ms':start,'end_ms_inclusive':now,'hours':30})

    def status(self):
        count,size=self.execute('SELECT count(*),coalesce(sum(length(record)),0) FROM mb_events').fetchone()
        archives=[json.loads(r[0]) for r in self.execute('SELECT record FROM mb_archives ORDER BY date')]
        return {'schema':SCHEMA,'epoch':self.epoch,'events':count,'event_json_bytes':size,
                'archive_count':len(archives),'archive_bytes':sum(r['bytes'] for r in archives),
                'archives':[{k:r[k] for k in ('date','bytes','sha256','verified')} for r in archives],
                'shadow_only':True,'execution_enabled':False,'streams':sorted(STREAMS),'current_hours':30,'completed_archive_maximum':7}
