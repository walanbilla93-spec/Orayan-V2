"""Single-writer storage. Predictions and labels have no update/delete API."""
import os, json, sqlite3, gzip, time, hashlib, shutil, uuid
from pathlib import Path
from datetime import datetime, timezone

def utc(ms=None):
    return datetime.fromtimestamp((ms if ms is not None else time.time()*1000)/1000,timezone.utc).isoformat()

def clean(x):
    if isinstance(x,dict): return {str(k):clean(v) for k,v in x.items()}
    if isinstance(x,(list,tuple)): return [clean(v) for v in x]
    if hasattr(x,'item'): return clean(x.item())
    if isinstance(x,float) and not __import__('math').isfinite(x): return None
    return x

def packed(x): return json.dumps(clean(x),sort_keys=True,separators=(',',':'),allow_nan=False)
def digest(x): return hashlib.sha256(packed(x).encode()).hexdigest()

class Store:
    def __init__(self,root,config):
        self.root=Path(root); self.root.mkdir(parents=True,exist_ok=True); self.config=config
        self.db=sqlite3.connect(self.root/'ledger.sqlite3')
        self.db.execute('PRAGMA journal_mode=WAL'); self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS predictions(id TEXT PRIMARY KEY, event_ms INTEGER, symbol TEXT, record TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS labels(id TEXT PRIMARY KEY REFERENCES predictions(id),record TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS boundary(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS segments(path TEXT PRIMARY KEY,record TEXT NOT NULL);
        ''')
        for table in ['predictions','labels','boundary','segments']:
            for action in ['UPDATE','DELETE']:
                self.db.execute(f"CREATE TRIGGER IF NOT EXISTS immutable_{table}_{action} BEFORE {action} ON {table} BEGIN SELECT RAISE(ABORT,'immutable ledger'); END")
        self.db.commit(); self.writers={}; self.bytes=0; self.rows=0; self.write_errors=0
        # An interrupted open segment remains available for forensic recovery, never erased.
        for p in self.root.rglob('*.open.gz'):
            target=p.with_suffix('.partial.gz'); p.rename(target)
            self.status('interrupted_segment',{'path':str(target.relative_to(self.root)),'complete':False})

    def status(self,kind,details):
        line=packed({'at':utc(),'kind':kind,**details})+'\n'
        with (self.root/'status.jsonl').open('a',encoding='utf8') as f:
            f.write(line); f.flush(); os.fsync(f.fileno())

    def capacity(self):
        disk=shutil.disk_usage(self.root)
        return {'total_bytes':disk.total,'free_bytes':disk.free,'used_fraction':1-disk.free/disk.total,
                'allowed':disk.free>=self.config['minimum_free_bytes'] and 1-disk.free/disk.total<self.config['disk_stop_fraction']}

    def append(self,stream,symbol,row,receipt_ms):
        try:return self._append(stream,symbol,row,receipt_ms)
        except OSError:
            self.write_errors+=1
            raise

    def _append(self,stream,symbol,row,receipt_ms):
        if not self.capacity()['allowed']: raise OSError('CAPTURE_PAUSED_STORAGE_PRESSURE')
        bucket=receipt_ms//300000
        key=(stream,symbol)
        if key in self.writers and self.writers[key]['bucket']!=bucket: self.finish(key)
        if key not in self.writers:
            stamp=datetime.fromtimestamp(receipt_ms/1000,timezone.utc)
            folder=self.root/stream/symbol/stamp.strftime('%Y-%m-%d/%H'); folder.mkdir(parents=True,exist_ok=True)
            path=folder/(str(bucket)+'-'+uuid.uuid4().hex+'.open.gz')
            f=path.open('xb'); gz=gzip.GzipFile(fileobj=f,mode='wb',compresslevel=6,mtime=0)
            self.writers[key]={'bucket':bucket,'path':path,'f':f,'gz':gz,'rows':0,'first_ms':receipt_ms,'last_ms':receipt_ms,'last_sync':0}
        w=self.writers[key]; data=(packed(row)+'\n').encode(); w['gz'].write(data)
        w['rows']+=1; w['last_ms']=receipt_ms; self.bytes+=len(data); self.rows+=1
        if receipt_ms-w['last_sync']>=1000:
            w['gz'].flush(); w['f'].flush(); os.fsync(w['f'].fileno()); w['last_sync']=receipt_ms
        if w['f'].tell()>=128*1024*1024: self.finish(key)

    def finish(self,key):
        w=self.writers.pop(key); w['gz'].close(); w['f'].flush(); os.fsync(w['f'].fileno()); w['f'].close()
        p=w['path']; final=p.with_name(p.name.replace('.open.gz','.jsonl.gz')); p.rename(final)
        path=str(final.relative_to(self.root)); h=hashlib.sha256(final.read_bytes()).hexdigest()
        rec={'path':path,'sha256':h,'rows':w['rows'],'bytes':final.stat().st_size,'first_receipt_ms':w['first_ms'],'last_receipt_ms':w['last_ms'],'complete':True}
        self.db.execute('INSERT INTO segments VALUES(?,?)',(path,packed(rec))); self.db.commit()

    def prediction(self,row):
        self.db.execute('INSERT INTO predictions VALUES(?,?,?,?)',(row['observation_id'],row['event_clock_ms'],row['symbol'],packed(row))); self.db.commit()

    def label(self,observation_id,row):
        self.db.execute('INSERT INTO labels VALUES(?,?)',(observation_id,packed(row))); self.db.commit()

    def boundary(self):
        r=self.db.execute('SELECT record FROM boundary WHERE id=1').fetchone()
        return json.loads(r[0]) if r else None

    def set_boundary(self,row):
        self.db.execute('INSERT INTO boundary VALUES(1,?)',(packed(row),)); self.db.commit()
        self.export_boundary()

    def export_boundary(self):
        # DB is authoritative; reconstruct exact immutable projection after an interrupted write.
        row=self.boundary()
        if row:
            temp=self.root/'prospective_start_manifest.tmp'
            with temp.open('w',encoding='utf8') as f:
                f.write(packed(row)+'\n');f.flush();os.fsync(f.fileno())
            os.replace(temp,self.root/'prospective_start_manifest.json')

    def close(self):
        for key in list(self.writers): self.finish(key)
        self.db.close()
