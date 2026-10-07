"""Durable gzip partitions and immutable ledgers in the included private PostgreSQL addon."""
import os,json,time,gzip,hashlib,uuid
from pathlib import Path
from storage import packed,utc

class QueryAdapter:
    def __init__(self,connection):self.connection=connection
    def execute(self,sql,args=()):return self.connection.execute(sql.replace('?', '%s'),args)
    def commit(self):self.connection.commit()

class PgStore:
    def __init__(self,root,config):
        import psycopg
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True);self.config=config
        # Only dedicated DB credentials are read; exchange credentials never enter this module.
        self.connection=psycopg.connect(host=os.environ['PGHOST'],port=os.environ.get('PGPORT','5432'),
          dbname=os.environ['PGDATABASE'],user=os.environ['PGUSER'],password=os.environ['PGPASSWORD'],
          sslmode=os.environ.get('PGSSLMODE','require'),connect_timeout=15,autocommit=True)
        self.connection.execute('SET synchronous_commit=on')
        if not self.connection.execute('SELECT pg_try_advisory_lock(31062026)').fetchone()[0]:raise RuntimeError('another shadow writer owns the database')
        self.db=QueryAdapter(self.connection)
        self.connection.execute('''CREATE TABLE IF NOT EXISTS predictions(id TEXT PRIMARY KEY,event_ms BIGINT,symbol TEXT,record TEXT NOT NULL)''')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS labels(id TEXT PRIMARY KEY REFERENCES predictions(id),record TEXT NOT NULL)''')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS boundary(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL)''')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS capture_chunks(id TEXT PRIMARY KEY,stream TEXT,symbol TEXT,first_ms BIGINT,last_ms BIGINT,rows INTEGER,sha256 TEXT,payload BYTEA NOT NULL)''')
        self.connection.execute('''CREATE INDEX IF NOT EXISTS capture_lookup ON capture_chunks(stream,last_ms)''')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS capture_status(id BIGSERIAL PRIMARY KEY,at BIGINT,record TEXT NOT NULL)''')
        self.connection.execute('''CREATE OR REPLACE FUNCTION immutable_shadow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable shadow ledger'; END $$''')
        for table in ['predictions','labels','boundary','capture_chunks','capture_status']:
            # No drop/recreate of guards on restart. Install once if absent.
            exists=self.connection.execute('SELECT 1 FROM pg_trigger WHERE tgname=%s',(f'guard_{table}',)).fetchone()
            if not exists:self.connection.execute(f'CREATE TRIGGER guard_{table} BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION immutable_shadow()')
        self.buffers={};self.rows=0;self.bytes=0;self.write_errors=0;self.last_flush=time.monotonic()
        self.database_bytes=0;self.capacity_at=0
        self.status('storage_session_start',{'durability':'PostgreSQL synchronous commits','unflushed_tail_max_seconds':1,
            'restart_gap':True,'last_durable_receipt_ms':self.connection.execute('SELECT max(last_ms) FROM capture_chunks').fetchone()[0]})

    def capacity(self):
        if time.monotonic()-self.capacity_at>10:
            self.database_bytes=int(self.connection.execute('SELECT pg_database_size(current_database())').fetchone()[0]);self.capacity_at=time.monotonic()
        # Keep room for WAL, system tables and database overhead on a 6GB free disk.
        ceiling=3*1024**3
        return {'storage':'private_postgresql_6gb','database_bytes':self.database_bytes,'research_ceiling_bytes':ceiling,
          'allowed':self.database_bytes<ceiling,'retention':'no deletion; capture stops at ceiling','durable':True}

    def append(self,stream,symbol,row,receipt_ms):
        if not self.capacity()['allowed']:self.write_errors+=1;raise OSError('CAPTURE_PAUSED_DATABASE_PRESSURE')
        data=(packed(row)+'\n').encode();key=(stream,symbol,receipt_ms//3600000)
        b=self.buffers.setdefault(key,{'data':[],'bytes':0,'rows':0,'first_ms':receipt_ms,'last_ms':receipt_ms})
        b['data'].append(data);b['bytes']+=len(data);b['rows']+=1;b['last_ms']=receipt_ms;self.rows+=1;self.bytes+=len(data)
        if sum(v['bytes'] for v in self.buffers.values())>1024*1024 or time.monotonic()-self.last_flush>=1:self.flush()

    def flush(self):
        if not self.buffers:return
        try:
            # Chunk compression retains every original JSON row and decimal string.
            with self.connection.transaction():
                for (stream,symbol,hour),b in self.buffers.items():
                    payload=gzip.compress(b''.join(b['data']),compresslevel=6,mtime=0)
                    self.connection.execute('INSERT INTO capture_chunks VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                      (f'{hour}/{stream}/{symbol}/{uuid.uuid4().hex}',stream,symbol,b['first_ms'],b['last_ms'],b['rows'],hashlib.sha256(payload).hexdigest(),payload))
            self.buffers.clear();self.last_flush=time.monotonic()
        except Exception:
            self.write_errors+=1;raise OSError('durable database chunk write failed') from None

    def status(self,kind,details):
        self.connection.execute('INSERT INTO capture_status(at,record) VALUES(%s,%s)',(int(time.time()*1000),packed({'at':utc(),'kind':kind,**details})))

    def prediction(self,row):
        self.flush() # sources durable before the immutable decision is published
        self.db.execute('INSERT INTO predictions VALUES(?,?,?,?)',(row['observation_id'],row['event_clock_ms'],row['symbol'],packed(row)))

    def label(self,observation_id,row):
        self.flush();self.db.execute('INSERT INTO labels VALUES(?,?)',(observation_id,packed(row)))

    def boundary(self):
        row=self.db.execute('SELECT record FROM boundary WHERE id=1').fetchone()
        return json.loads(row[0]) if row else None

    def set_boundary(self,row):
        self.flush();self.db.execute('INSERT INTO boundary VALUES(1,?)',(packed(row),));self.export_boundary()

    def export_boundary(self):
        row=self.boundary()
        if row:(self.root/'prospective_start_manifest.json').write_text(packed(row)+'\n',encoding='utf8')

    def restored_minutes(self,since):
        rows=self.connection.execute("SELECT sha256,payload FROM capture_chunks WHERE stream='live_ohlc' AND last_ms>=%s ORDER BY first_ms",(since,))
        for sha,payload in rows:
            payload=bytes(payload)
            if hashlib.sha256(payload).hexdigest()!=sha:raise RuntimeError('capture partition hash mismatch')
            for line in gzip.decompress(payload).splitlines():yield json.loads(line)

    def audit(self):
        self.flush()
        counts={table:int(self.connection.execute(f'SELECT count(*) FROM {table}').fetchone()[0]) for table in ['predictions','labels','capture_chunks']}
        samples=[]
        for stream in ['raw_trades','depth_1s','derived_1s','raw_liquidations','feature_pipeline_status']:
            row=self.connection.execute('SELECT sha256,payload FROM capture_chunks WHERE stream=%s ORDER BY last_ms DESC LIMIT 1',(stream,)).fetchone()
            if row:
                sha,payload=row;payload=bytes(payload);assert hashlib.sha256(payload).hexdigest()==sha
                sample=json.loads(gzip.decompress(payload).splitlines()[-1]);samples.append({'stream':stream,'sha256':sha,'sample':sample})
        predictions=[json.loads(r[0]) for r in self.connection.execute('SELECT record FROM predictions ORDER BY event_ms DESC LIMIT 2')]
        return {'counts':counts,'boundary':self.boundary(),'samples':samples,'predictions':predictions,'capacity':self.capacity()}

    def close(self):self.flush();self.connection.close()
