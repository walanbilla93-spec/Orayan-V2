"""Research-only, append-only capture. No trading API, strategy feedback, or activation.

All times are integer epoch milliseconds except explicitly named *Ns fields.
Receipts use the instant the entire response body has been read, before parsing.
Historical warmup is never a historical receipt or an eligible past decision.
"""
import argparse
import base64
import concurrent.futures
import csv
import datetime as dt
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import sqlite3
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT=Path(__file__).resolve().parent
SCHEMA='ORAYAN_PROSPECTIVE_OBSERVER_V1.0.0'
MINUTE=60000
SURFACE=900000
COHORT=json.loads((ROOT/'sources/prospective_cohort_manifest.json').read_text())
PREREG=json.loads((ROOT/'sources/validation_preregistration.json').read_text())
SYMBOLS=COHORT['eligible_active_symbols']
REGISTRATION=COHORT['registration_sha256']
UNIVERSE=COHORT['symbol_list_sha256']
PUBLIC_HOST='https://api.bybit.com'

def canonical(x):
    return json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False).encode()

def digest(x):
    return hashlib.sha256(x if isinstance(x,bytes) else canonical(x)).hexdigest()

def utc(ms):
    return dt.datetime.fromtimestamp(ms/1000,dt.timezone.utc).isoformat().replace('+00:00','Z')

def stamp():
    return time.time_ns()//1000000

def implementation_hash():
    names=['observer.py','adapter.js','observer_schema.json','candidate_schema.json',
           'outcome_schema.json','capture_ledger_schema.json','frozen_source_manifest.json','requirements.txt',
           'readiness_audit.py','Dockerfile.observer','status.html']
    return digest({n:digest((ROOT/n).read_bytes()) for n in names})

def immutable(path,data):
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    if os.name!='nt':
        fd=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)

class Ledger:
    """SQLite WAL FULL; intents and acceptances immutable, never updated or deleted.

    Intent first: a failed record append remains replayable after a crash. A scan is
    acknowledged only after all required records and SCAN_ACK have committed.
    """
    def __init__(self,folder):
        self.folder=Path(folder)
        self.folder.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock()
        self.db=sqlite3.connect(self.folder/'capture.sqlite',check_same_thread=False,isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA busy_timeout=30000')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, type TEXT NOT NULL,
            engine TEXT, symbol TEXT, bar INTEGER, attempted_at INTEGER NOT NULL,
            payload TEXT NOT NULL, hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE NOT NULL REFERENCES intents(id), committed_at INTEGER NOT NULL,
            payload TEXT NOT NULL, previous_hash TEXT NOT NULL, chain_hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS responses(version INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL, symbol TEXT, interval_ms INTEGER, raw BLOB NOT NULL,
            raw_hash TEXT NOT NULL, evidence TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS bars(version INTEGER NOT NULL REFERENCES responses(version),
            open_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(version,open_at));
          CREATE INDEX IF NOT EXISTS source_index ON responses(source,symbol,interval_ms);
          CREATE INDEX IF NOT EXISTS bars_index ON bars(open_at,version);
          CREATE INDEX IF NOT EXISTS intent_surface_index ON intents(type,engine,symbol,bar);
        ''')
        for table in ['intents','records','responses','bars']:
            for action in ['UPDATE','DELETE']:
                self.db.execute(f"CREATE TRIGGER IF NOT EXISTS {table}_{action} BEFORE {action} ON {table} BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END")
        self.recovery=self.recover()

    def close(self):
        self.db.close()

    def get(self,id):
        with self.lock:
            row=self.db.execute('SELECT payload FROM records WHERE id=?',(id,)).fetchone()
            return json.loads(row[0]) if row else None

    def append(self,id,payload,fail_after_intent=False):
        payload={'cohortId':COHORT['cohort_id'],**payload}
        data=canonical(payload).decode()
        h=digest(data.encode())
        with self.lock:
            old=self.db.execute('SELECT hash FROM intents WHERE id=?',(id,)).fetchone()
            if old and old[0]!=h:raise RuntimeError('IDEMPOTENCY_PAYLOAD_CONFLICT:'+id)
            if not old:
                self.db.execute('INSERT INTO intents VALUES(?,?,?,?,?,?,?,?)',
                    (id,payload['recordType'],payload.get('engine'),payload.get('symbol'),
                     payload.get('barCloseAt'),stamp(),data,h))
            if fail_after_intent:raise RuntimeError('INJECTED_CRASH_AFTER_DURABLE_INTENT')
            self._accept(id)
            return self.get(id)

    def _accept(self,id):
        if self.db.execute('SELECT 1 FROM records WHERE id=?',(id,)).fetchone():return
        self.db.execute('BEGIN IMMEDIATE')
        try:
            data=self.db.execute('SELECT payload FROM intents WHERE id=?',(id,)).fetchone()[0]
            prev=self.db.execute('SELECT chain_hash FROM records ORDER BY seq DESC LIMIT 1').fetchone()
            prev=prev[0] if prev else '0'*64
            at=stamp()
            data=canonical({**json.loads(data),'committedAt':at}).decode()
            h=digest([prev,id,at,json.loads(data)])
            self.db.execute('INSERT INTO records(id,committed_at,payload,previous_hash,chain_hash) VALUES(?,?,?,?,?)',(id,at,data,prev,h))
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def recover(self):
        with self.lock:
            if self.db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('WAL_INTEGRITY_FAILED')
            pending=self.db.execute('SELECT i.id FROM intents i LEFT JOIN records r ON i.id=r.id WHERE r.id IS NULL ORDER BY i.rowid').fetchall()
            for (id,) in pending:self._accept(id)
            check=self.verify()
            if check['chainFailures'] or check['unresolvedRefs']:raise RuntimeError('CAPTURE_RECOVERY_VERIFICATION_FAILED')
            return {'pendingRecovered':len(pending),'integrity':'ok',**check}

    def rows(self,type=None):
        with self.lock:
            q='SELECT r.payload,r.committed_at FROM records r JOIN intents i ON i.id=r.id'
            args=()
            if type:q+=' WHERE i.type=?';args=(type,)
            return [{**json.loads(p),'committedAt':at} for p,at in self.db.execute(q+' ORDER BY r.seq',args)]

    def count(self,start=None,end=None):
        where='';args=[]
        if start is not None:where=' WHERE i.attempted_at>=? AND i.attempted_at<?';args=[start,end]
        with self.lock:
            rows=self.db.execute("SELECT json_extract(i.payload,'$.cohortId'),i.type,i.engine,i.bar,COUNT(*),COUNT(r.id) FROM intents i LEFT JOIN records r ON i.id=r.id"+where+' GROUP BY 1,i.type,i.engine,i.bar',args).fetchall()
            failures={}
            for cohort,typ,engine,bar,field,n in self.db.execute("SELECT json_extract(i.payload,'$.cohortId'),i.type,i.engine,i.bar,j.value,COUNT(*) FROM intents i JOIN json_each(i.payload,'$.requiredInputFailures') j"+where+' GROUP BY 1,i.type,i.engine,i.bar,j.value',args):
                failures.setdefault((cohort,typ,engine,bar),{})[field]=n
        return [{'cohortId':cohort,'recordType':t,'engine':e,'barCloseAt':b,'attempted':a,'accepted':n,'pending':a-n,'skipped':0,
                 'fieldFailureCounts':failures.get((cohort,t,e,b),{})} for cohort,t,e,b,a,n in rows]

    def receipt(self,source,symbol,interval,raw,evidence,bars):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                cur=self.db.execute('INSERT INTO responses(source,symbol,interval_ms,raw,raw_hash,evidence) VALUES(?,?,?,?,?,?)',
                    (source,symbol,interval,raw,digest(raw),canonical(evidence).decode()))
                version=cur.lastrowid
                for bar in bars:
                    native={k:bar[k] for k in ['ts','intervalMs','source','symbol','open','high','low','close','volume','turnover'] if k in bar}
                    self.db.execute('INSERT INTO bars VALUES(?,?,?)',(version,bar['ts'],canonical(native).decode()))
                self.db.execute('COMMIT')
            except BaseException:
                self.db.execute('ROLLBACK');raise
        return version

    def select(self,source,symbol,interval,lo,hi,decision=None,watermark=None):
        with self.lock:
            rows=self.db.execute('''SELECT b.payload,r.version,r.raw_hash,r.evidence FROM bars b JOIN responses r ON b.version=r.version
              WHERE r.source=? AND r.symbol=? AND r.interval_ms=? AND b.open_at>=? AND b.open_at<?
              AND b.version<=? ORDER BY b.open_at,b.version''',
              (source,symbol,interval,lo,hi,watermark or 2**63-1)).fetchall()
        result={}
        for p,version,h,evidence in rows:
            b={**json.loads(p),**json.loads(evidence),'inputVersionId':version,'responseHash':h}
            # Prefer the first eligible receipt. Revisions append; they never rewrite a seal.
            if decision is not None and not available(b,decision):continue
            if b['exchangeEnvelopeTime']<b['ts']+interval:continue
            result.setdefault(b['ts'],b)
        return [result[k] for k in sorted(result)]

    def watermark(self):
        with self.lock:return self.db.execute('SELECT COALESCE(MAX(version),0) FROM responses').fetchone()[0]

    def bar(self,ref):
        with self.lock:
            row=self.db.execute('SELECT b.payload,r.raw_hash,r.evidence FROM bars b JOIN responses r ON r.version=b.version WHERE b.version=? AND b.open_at=?',
                (ref['inputVersionId'],ref['barOpenAt'])).fetchone()
        if not row:raise RuntimeError('UNRESOLVED_BAR_REFERENCE')
        return {**json.loads(row[0]),**json.loads(row[2]),'inputVersionId':ref['inputVersionId'],'responseHash':row[1]}

    def verify(self):
        with self.lock:
            prev='0'*64;bad=0;refs=0
            for id,at,p,prior,h in self.db.execute('SELECT id,committed_at,payload,previous_hash,chain_hash FROM records ORDER BY seq'):
                if prior!=prev or digest([prev,id,at,json.loads(p)])!=h:bad+=1
                prev=h
                for v in json.loads(p).get('payloadRefs',[]):
                    if not self.db.execute('SELECT 1 FROM responses WHERE version=?',(v,)).fetchone():refs+=1
                for group in json.loads(p).get('inputBarRefs',{}).values():
                    for b in group:
                        if not self.db.execute('SELECT 1 FROM bars WHERE version=? AND open_at=?',(b['inputVersionId'],b['barOpenAt'])).fetchone():refs+=1
            rawbad=sum(digest(bytes(raw))!=h for raw,h in self.db.execute('SELECT raw,raw_hash FROM responses'))
            return {'chainFailures':bad,'unresolvedRefs':refs,'rawHashFailures':rawbad,'chainHead':prev}

def available(bar,decision):
    # Clock interval upper bound prevents uncertain receipts being called on-time.
    return (bar['ts']+bar['intervalMs']<=decision and
            bar['exchangeEnvelopeTime']>=bar['ts']+bar['intervalMs'] and
            bar.get('utcReceiptUpperNs') is not None and bar['utcReceiptUpperNs']<=decision*1000000)

class Feed:
    PATHS={'ohlcv':'/v5/market/kline','mark':'/v5/market/mark-price-kline','premium':'/v5/market/premium-index-kline','clock':'/v5/market/time'}
    def __init__(self,ledger):
        self.ledger=ledger;self.clock=None;self.rate=threading.Lock();self.next=0;self.clock_lock=threading.Lock()
        self.clock_refresh_lock=threading.Lock()

    def request(self,source,query):
        if source not in self.PATHS:raise RuntimeError('READ_ONLY_PUBLIC_ENDPOINT_REQUIRED')
        if source!='clock':
            # Warmup can span several minutes: refresh independently of the
            # collection cycle so old clock evidence never poisons warmup bars.
            with self.clock_refresh_lock:
                with self.clock_lock:clock=self.clock
                if not clock or time.monotonic_ns()-clock['monotonicReceiptTick']>30000000000:
                    self.calibrate()
        with self.rate:
            time.sleep(max(0,self.next-time.monotonic()))
            self.next=time.monotonic()+0.125
        url=PUBLIC_HOST+self.PATHS[source]+'?'+urllib.parse.urlencode(query)
        start_ns=time.time_ns();start_tick=time.monotonic_ns();status=None
        try:
            with urllib.request.urlopen(url,timeout=15) as response:
                status=response.status;raw=response.read()
        except urllib.error.HTTPError as e:
            status=e.code;raw=e.read()
        received_tick=time.monotonic_ns();received_ns=time.time_ns()
        try:data=json.loads(raw)
        except (ValueError,UnicodeError):data={}
        evidence={'schemaVersion':SCHEMA,'requestUrl':url,'requestStartedAtNs':start_ns,
          'requestStartedMonotonicNs':start_tick,'responseReceivedAtNs':received_ns,
          'responseReceivedAt':received_ns//1000000,'monotonicReceiptTick':received_tick,
          'httpStatus':status,'exchangeEnvelopeTime':data.get('time',0),
          'clockEvidenceVersion':None,'utcClockOffsetNs':None,'utcClockUncertaintyNs':None,
          'utcReceiptUpperNs':None,'classification':'LIVE_RECEIPT'}
        if source=='clock' and status==200 and data.get('retCode')==0:
            server=int(data['result']['timeNano']);mid=(start_ns+received_ns)//2
            uncertainty=max((received_ns-start_ns)//2,abs((received_ns-start_ns)-(received_tick-start_tick)))
            evidence.update(utcClockOffsetNs=server-mid,utcClockUncertaintyNs=uncertainty,utcReceiptUpperNs=received_ns+server-mid+uncertainty)
        else:
            with self.clock_lock:clock=self.clock
            if clock and received_tick-clock['monotonicReceiptTick']<=120000000000:
                drift=abs((received_ns-clock['responseReceivedAtNs'])-(received_tick-clock['monotonicReceiptTick']))
                uncertainty=clock['utcClockUncertaintyNs']+drift
                evidence.update(clockEvidenceVersion=clock['version'],utcClockOffsetNs=clock['utcClockOffsetNs'],
                    utcClockUncertaintyNs=uncertainty,utcReceiptUpperNs=received_ns+clock['utcClockOffsetNs']+uncertainty)
        return raw,data,evidence

    def calibrate(self):
        raw,data,e=self.request('clock',{})
        version=self.ledger.receipt('clock',None,None,raw,e,[])
        if e['utcClockOffsetNs'] is None:raise RuntimeError('UTC_CLOCK_EVIDENCE_UNAVAILABLE')
        with self.clock_lock:self.clock={**e,'version':version}
        return version

    def capture(self,source,symbol,interval,start,end,warmup=False):
        cursor=end-1
        while cursor>=start:
            raw,data,e=self.request(source,{'category':'linear','symbol':symbol,'interval':str(interval//MINUTE),'start':start,'end':cursor,'limit':1000})
            e['classification']='WARMUP_ONLY' if warmup else 'LIVE_RECEIPT'
            bars=[]
            if e['httpStatus']==200 and data.get('retCode')==0:
                for row in data['result']['list']:
                    b={'ts':int(row[0]),'intervalMs':interval,'source':source,'symbol':symbol,
                        'open':float(row[1]),'high':float(row[2]),'low':float(row[3]),'close':float(row[4]),
                        'volume':float(row[5]) if len(row)>5 else 0,'turnover':float(row[6]) if len(row)>6 else None}
                    if start<=b['ts']<end and b['ts']+interval<=e['exchangeEnvelopeTime']:bars.append(b)
            v=self.ledger.receipt(source,symbol,interval,raw,e,bars)
            if e['httpStatus']!=200 or data.get('retCode')!=0:
                self.ledger.append('feed-error:'+str(v),{'recordType':'FEED_ERROR','schemaVersion':SCHEMA,'symbol':symbol,'source':source,'payloadRefs':[v],'error':data.get('retMsg',f'HTTP_{e["httpStatus"]}')})
                return
            if not bars:return
            earliest=min(b['ts'] for b in bars)
            if earliest<=start:return
            cursor=earliest-1

def complete(bars,start,count,interval):
    return len(bars)==count and all(b['ts']==start+i*interval for i,b in enumerate(bars))

def references(*groups):
    return sorted({b['inputVersionId'] for g in groups for b in g})

def bar_refs(bars):
    return [{'inputVersionId':b['inputVersionId'],'barOpenAt':b['ts'],'responseReceivedAt':b['responseReceivedAt']} for b in bars]

def feature_bundle(snapshot):
    d=snapshot['decisionAt'];cut=d//MINUTE*MINUTE
    s=snapshot['symbolMinutes'];btc=snapshot['btcMinutes'];prem=snapshot['premiumMinutes']
    by={b['ts']:b for b in s};bb={b['ts']:b for b in btc}
    out={'premium':None,'premiumZ':None,'premiumBarOpenAt':None,'premiumBarCloseAt':None,
      'premiumReceivedAt':None,'premiumBaselineCount':0,'premiumBaselineMean':None,
      'premiumBaselineSampleStd':None,'premiumBaselineHash':None,'premiumBaselineReceipts':[],
      'premiumSourceReceipt':None,'premiumCutBoundary':cut,'premiumDerivationHash':None,
      'relativeStrength60':None,'relativeStrength60Bars':{},'relativeStrength60DerivationHash':None,
      'preMove15':None,'preMove60':None,'featureValidity':{},'featureGapReasons':{}}
    if prem:
        current=prem[-1];base=prem[:-1][-1440:];values=[b['close'] for b in base]
        mean=statistics.mean(values) if values else None
        sd=statistics.stdev(values) if len(values)>=2 else None
        out.update(premium=current['close'],premiumBarOpenAt=current['ts'],premiumBarCloseAt=current['ts']+MINUTE,
          premiumReceivedAt=current['responseReceivedAt'],premiumBaselineCount=len(base),premiumBaselineMean=mean,
          premiumBaselineSampleStd=sd,premiumBaselineHash=digest(base),premiumBaselineReceipts=bar_refs(base),premiumSourceReceipt=current)
        if len(base)>=360 and sd and sd>0 and d-current['ts']-MINUTE<=120000:out['premiumZ']=(current['close']-mean)/sd
        else:out['featureGapReasons']['premiumZ']='INSUFFICIENT_BASELINE_ZERO_VARIANCE_OR_STALE'
        out['premiumDerivationHash']=digest({'current':current,'baseline':base,'ddof':1,'maxCount':1440,'minimumCount':360})
    else:out['featureGapReasons']['premiumZ']='NO_COMPLETED_PREMIUM_RECEIVED_BY_DECISION'
    four=[by.get(cut-MINUTE),by.get(cut-61*MINUTE),bb.get(cut-MINUTE),bb.get(cut-61*MINUTE)]
    names=['symbolCloseCurrent','symbolClose60Prior','btcCloseCurrent','btcClose60Prior']
    for name,b in zip(names,four):
        out[name]=b['close'] if b else None
        out[name+'BarOpenAt']=b['ts'] if b else None
        out[name+'BarCloseAt']=b['ts']+MINUTE if b else None
        out[name+'ReceivedAt']=b['responseReceivedAt'] if b else None
        out['relativeStrength60Bars'][name]=b
    if all(four) and four[1]['close']>0 and four[3]['close']>0:
        out['relativeStrength60']=four[0]['close']/four[1]['close']-four[2]['close']/four[3]['close']
        out['relativeStrength60DerivationHash']=digest(four)
    else:out['featureGapReasons']['relativeStrength60']='EXACT_REFERENCE_CLOSE_OR_RECEIPT_UNAVAILABLE'
    for h in [15,60]:
        first=by.get(cut-(h+1)*MINUTE);last=by.get(cut-MINUTE)
        if first and last and first['close']>0:out['preMove'+str(h)]=last['close']/first['close']-1
    out['featureValidity']={k:out[k] is not None for k in ['premiumZ','relativeStrength60','preMove15','preMove60']}
    return out

class Adapter:
    def __init__(self):
        self.p=subprocess.Popen(['node',str(ROOT/'adapter.js')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,encoding='utf-8')
    def evaluate(self,x):
        self.p.stdin.write(canonical(x).decode()+'\n');self.p.stdin.flush()
        response=json.loads(self.p.stdout.readline())
        if not response['ok']:raise RuntimeError(response['error'])
        return response['result']
    def close(self):
        self.p.terminate();self.p.wait(timeout=10)

class Sealer:
    def __init__(self,pem):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
        if b'PRIVATE KEY' in pem:raise RuntimeError('PRIVATE_KEY_FORBIDDEN_IN_OBSERVER')
        self.key=serialization.load_pem_public_key(pem)
        if not isinstance(self.key,RSAPublicKey) or self.key.key_size<3072:raise RuntimeError('RSA_PUBLIC_KEY_MINIMUM_3072')
        self.fingerprint=digest(pem)
    def encrypt(self,outcome):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        key=AESGCM.generate_key(bit_length=256);nonce=os.urandom(12)
        context=canonical({'schemaVersion':SCHEMA,'candidateId':outcome['candidateId'],'horizonMin':outcome['horizonMin']})
        ciphertext=AESGCM(key).encrypt(nonce,canonical(outcome),context)
        wrapped=self.key.encrypt(key,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
        # No plaintext outcome or return statistic is persisted anywhere else.
        return {'recordType':'SEALED_OUTCOME','schemaVersion':SCHEMA,'candidateId':outcome['candidateId'],
            'horizonMin':outcome['horizonMin'],'endAt':outcome['endAt'],'computedAt':outcome['computedAt'],
            'pathComplete':outcome['pathComplete'],'censorReason':outcome['censorReason'],
            'keyFingerprint':self.fingerprint,'algorithm':'RSA-OAEP-SHA256/AES-256-GCM',
            'nonce':base64.b64encode(nonce).decode(),'wrappedKey':base64.b64encode(wrapped).decode(),
            'ciphertext':base64.b64encode(ciphertext).decode(),'aad':base64.b64encode(context).decode()}

class Observer:
    def __init__(self,ledger,sealer=None,adapter=None):
        self.ledger=ledger;self.sealer=sealer;self.adapter=adapter or Adapter()
        self.hash=implementation_hash();self.frozen=json.loads((ROOT/'frozen_source_manifest.json').read_text())
        self.active_start=None

    def classification(self,bar_close):
        return 'PROSPECTIVE_COHORT' if self.active_start is not None and bar_close>=self.active_start else 'READINESS_ONLY'

    def snapshot(self,symbol,bar_close):
        id=f'snapshot:{symbol}:{bar_close}'
        existing=self.ledger.get(id)
        if existing:return self.materialize(existing)
        d=bar_close+1;wm=self.ledger.watermark()
        def get(source,sym,interval,lo,hi):return self.ledger.select(source,sym,interval,lo,hi,d,wm)
        s15=get('ohlcv',symbol,SURFACE,bar_close-200*SURFACE,bar_close)
        b15=get('ohlcv','BTCUSDT',SURFACE,bar_close-200*SURFACE,bar_close)
        sm=get('ohlcv',symbol,MINUTE,bar_close-1440*MINUTE,bar_close)
        bm=get('ohlcv','BTCUSDT',MINUTE,bar_close-61*MINUTE,bar_close)
        mark=get('mark',symbol,MINUTE,bar_close-MINUTE,bar_close)
        # Observed premium closes, max1440 before current; 72h raw preload retained.
        premium=get('premium',symbol,MINUTE,bar_close-72*60*MINUTE,bar_close)[-1441:]
        failures=[]
        for field,ok in [('symbol200Bars',complete(s15,bar_close-200*SURFACE,200,SURFACE)),
                         ('btc200Bars',complete(b15,bar_close-200*SURFACE,200,SURFACE)),
                         ('turnover1440Minutes',complete(sm,bar_close-1440*MINUTE,1440,MINUTE)),
                         ('markReference',complete(mark,bar_close-MINUTE,1,MINUTE))]:
            if not ok:failures.append(field)
        groups=[s15,b15,sm,bm,mark,premium]
        snapshot={'recordType':'INPUT_SNAPSHOT','schemaVersion':SCHEMA,'cohortId':COHORT['cohort_id'],
          'registrationHash':REGISTRATION,'universeHash':UNIVERSE,'symbol':symbol,'barCloseAt':bar_close,
          'decisionAt':d,'computedAt':stamp(),'inputWatermark':wm,'inputSnapshotId':id,
          'symbolBars':s15,'btcBars':b15,'symbolMinutes':sm,'btcMinutes':bm,
          'markBars':mark,'premiumMinutes':premium,'unavailableFields':failures,
          'payloadRefs':references(*groups),'snapshotHash':digest(groups),
          'strictAvailabilityFailed':bool(failures),'classification':self.classification(bar_close),
          'scheduledDeadlineNs':d*1000000}
        snapshot['inputBarRefs']={name:bar_refs(snapshot[name]) for name in ['symbolBars','btcBars','symbolMinutes','btcMinutes','markBars','premiumMinutes']}
        compact={k:v for k,v in snapshot.items() if k not in snapshot['inputBarRefs']}
        return self.materialize(self.ledger.append(id,compact))

    def materialize(self,snapshot):
        return {**snapshot,**{name:[self.ledger.bar(r) for r in refs] for name,refs in snapshot['inputBarRefs'].items()}}

    def surface(self,symbol,bar_close):
        ackid=f'ack:{symbol}:{bar_close}'
        if self.ledger.get(ackid):return
        snap=self.snapshot(symbol,bar_close)  # Sealed BEFORE any candidate adapter.
        f=feature_bundle(snap);d=snap['decisionAt'];result=None;error=None
        if not snap['unavailableFields']:
            try:
                result=self.adapter.evaluate({'symbol':symbol,'decisionAt':d,'candles':snap['symbolBars'],
                  'btc':snap['btcBars'],'ticker':{'markPrice':snap['markBars'][0]['close'],
                  'turnover24h':sum(b['turnover'] for b in snap['symbolMinutes']),'spreadPct':None}})
            except Exception as e:error=str(e)
        for engine in ['V2','V3']:
            rid=f'candidate:{engine}:{symbol}:{bar_close}'
            if self.ledger.get(rid):continue
            r=result[engine.lower()] if result else {}
            eligible=bool(r.get('eligible') if engine=='V2' else r.get('prequote'))
            side=r.get('signal',{}).get('side') if engine=='V2' else r.get('side')
            reaction=r.get('reaction') or {};ep=self.episode(symbol,(result or {}).get('v3',{}).get('side'),d)
            row={'recordType':'EDGE_CANDIDATE','schemaVersion':SCHEMA,'cohortId':COHORT['cohort_id'],
              'registrationHash':REGISTRATION,'universeHash':UNIVERSE,'engine':engine,
              'sourcePopulation':'V2_FROZEN_LAYER1_PREQUOTE' if engine=='V2' else 'V3_FROZEN_QUALIFYING_REACTION_PREGEOMETRY',
              'candidateId':digest([COHORT['cohort_id'],engine,symbol,bar_close-SURFACE,d,side]),
              'episodeId':ep,'symbol':symbol,'originalSide':side,'orientation':'INVERTED_DIAGNOSTIC',
              'barOpenAt':bar_close-SURFACE,'barCloseAt':bar_close,'decisionAt':d,'computedAt':stamp(),
              'sourceHash':digest({k:v for k,v in self.frozen.items() if k.startswith('frozen/')}),
              'adapterHash':digest((ROOT/'adapter.js').read_bytes()),'configHash':self.frozen['sources/frozen_config.json'],
              'observerImplementationHash':self.hash,'prequoteEligible':eligible,
              'attemptKind':'CANDIDATE' if eligible else 'UNAVAILABLE' if snap['unavailableFields'] or error else 'REJECTED',
              'reactionType':(reaction.get('reaction',{}).get('state') or 'NO_REACTION') if engine=='V3' and eligible else None,
              'levelId':reaction.get('id'),'levelKnownAt':reaction.get('knownAt'),
              'levelSourceReceiptMax':max((b['responseReceivedAt'] for b in snap['symbolBars']),default=None),
              'utcHour':dt.datetime.fromtimestamp(d/1000,dt.timezone.utc).hour,
              'btcRegime':(result or {}).get('btc'),'btcRegimeDerivationAt':d,
              'btcRegimeReceipts':bar_refs(snap['btcBars']),'markReference':snap['markBars'][0]['close'] if snap['markBars'] else None,
              'markReferenceReceipt':snap['markBars'][0] if snap['markBars'] else None,
              'turnover24h':sum(b['turnover'] for b in snap['symbolMinutes']) if len(snap['symbolMinutes'])==1440 else None,
              'turnoverReceiptSet':bar_refs(snap['symbolMinutes']),'trendExtension':(result or {}).get('trendExtension'),
              'inputSnapshotId':snap['inputSnapshotId'],'payloadRefs':snap['payloadRefs'],
              'nativeReasonList':[r['reason']] if r.get('reason') else [],'nativeGateChecks':r.get('checks',[]),
              'adapterFailure':error,'requiredInputFailures':snap['unavailableFields'],
              'optionalContext':{'OI':None,'funding':None,'reason':'OPTIONAL_NOT_REQUESTED'},
              'classification':self.classification(bar_close),**f}
            row['hypothesisEligibility']={'H1':eligible and engine=='V3' and row['reactionType']=='RECLAIM',
              'H2':eligible and engine=='V3' and side=='SELL',
              'H3':eligible and engine=='V3' and f['premiumZ'] is not None and f['premiumZ']<=PREREG['hypotheses'][2]['cut_values'][0],
              'H4':eligible and engine=='V2' and row['utcHour']==22,
              'H5':eligible and engine=='V2' and f['relativeStrength60'] is not None and f['relativeStrength60']>PREREG['hypotheses'][4]['cut_values'][-1]}
            self.ledger.append(rid,row)
        self.ledger.append(ackid,{'recordType':'SCAN_ACK','schemaVersion':SCHEMA,'symbol':symbol,
            'barCloseAt':bar_close,'decisionAt':d,'candidateRecordIds':[f'candidate:{e}:{symbol}:{bar_close}' for e in ['V2','V3']],
            'inputSnapshotId':snap['inputSnapshotId'],'acknowledgedAt':stamp()})

    def episode(self,symbol,side,d):
        key=side or 'WATCH'
        with self.ledger.lock:
            old=[json.loads(row[0]) for row in self.ledger.db.execute('''SELECT r.payload FROM records r JOIN intents i ON r.id=i.id
                WHERE i.type='EDGE_CANDIDATE' AND i.engine='V3' AND i.symbol=? AND i.bar<? ORDER BY i.bar DESC LIMIT 3''',(symbol,d-1))]
        old=[x for x in old if (x['originalSide'] or 'WATCH')==key]
        old.sort(key=lambda x:x['decisionAt'])
        if old and d-old[-1]['decisionAt']<=1800000:return old[-1]['episodeId']
        return digest([symbol,key,d])[:24]

    def outcomes(self,now=None):
        now=now or stamp()
        if not self.sealer:raise RuntimeError('OUTCOME_SEAL_REQUIRED')
        for c in self.ledger.rows('EDGE_CANDIDATE'):
            if not c['prequoteEligible']:continue
            entry=math.ceil(c['decisionAt']/MINUTE)*MINUTE
            for h in [15,30,60,120]:
                end=entry+h*MINUTE;id=f'outcome:{c["candidateId"]}:{h}'
                if self.ledger.get(id) or now<end+MINUTE:continue
                path=self.ledger.select('ohlcv',c['symbol'],MINUTE,entry,end+MINUTE)
                good=complete(path,entry,h+1,MINUTE)
                # Endpoints complete + physically received; no forming-bar return ever written.
                if good:
                    if any(b.get('utcReceiptUpperNs') is None for b in path):continue
                    known=max(end+MINUTE,max((b['utcReceiptUpperNs']+999999)//1000000 for b in path))
                    if known>now:continue
                    first,last=path[0],path[-1]
                    inv=-(1 if c['originalSide']=='BUY' else -1)*(last['open']/first['open']-1)*10000
                else:
                    # Allow operational retries, never backfill eligibility. Censor after2h.
                    if now<end+MINUTE+120*MINUTE:continue
                    known=now;first=last=None;inv=None
                outcome={'recordType':'OUTCOME','schemaVersion':SCHEMA,'candidateId':c['candidateId'],
                  'entryAt':entry,'entryOpenRaw':first['open'] if first else None,'entryResponseReceipt':first,
                  'horizonMin':h,'endAt':end,'endOpenRaw':last['open'] if last else None,'endResponseReceipt':last,
                  'allInterveningSourceBarHashes':[b['responseHash'] for b in path],
                  'pathReceipts':path,'pathComplete':good,'outcomeKnownAt':known,'computedAt':now,
                  'invertedDirectionalBps':inv,'censorReason':None if good else 'MISSING_CONTIGUOUS_MINUTE_PATH'}
                sealed=self.sealer.encrypt(outcome)
                sealed['payloadRefs']=references(path)
                self.ledger.append(id,sealed)

    def status(self):
        snaps=self.ledger.rows('INPUT_SNAPSHOT');candidates=self.ledger.rows('EDGE_CANDIDATE')
        counts=self.ledger.count();now=stamp();start=self.ledger.get('readiness:start')
        late=sum(s['strictAvailabilityFailed'] for s in snaps)
        completed=self.completed_hours(start['startAt'] if start else None,now)
        check=self.ledger.verify()
        return {'observerStatus':'RESEARCH_ONLY','schemaVersion':SCHEMA,'cohortId':COHORT['cohort_id'],
          'preregistrationHash':REGISTRATION,'universeHash':UNIVERSE,'observerImplementationHash':self.hash,
          'readinessState':'INCOMPLETE','completedReadinessHours':len(completed),'requiredReadinessHours':24,
          'attemptedRequiredRecords':sum(x['attempted'] for x in counts),'acceptedRequiredRecords':sum(x['accepted'] for x in counts),
          'skippedRequiredRecords':0,'pendingRequiredRecords':sum(x['pending'] for x in counts),
          'strictUnavailableSurfaces':late,'totalSurfaces':len(snaps),'strictUnavailableSurfaceRate':late/len(snaps) if snaps else None,
          'eligibleCandidates':sum(c['prequoteEligible'] for c in candidates),'unresolvedRefs':check['unresolvedRefs'],
          'outcomeSealStatus':'RSA_PUBLIC_KEY_ONLY' if self.sealer else 'BLOCKED_CUSTODIAN_PUBLIC_KEY_MISSING',
          'actualCohortStart':utc(self.active_start) if self.active_start is not None else None,'executionAllowed':False,'mode':'PAPER_RESEARCH_ONLY',
          'completedUtcHours':completed,'currentUtcHour':utc(now//3600000*3600000),
          'currentHourAccounting':self.ledger.count(now//3600000*3600000,(now//3600000+1)*3600000),
          'fieldFailures':{k:sum(k in c['requiredInputFailures'] for c in candidates) for k in ['symbol200Bars','btc200Bars','turnover1440Minutes','markReference']},
          'hypothesisCounts':{h:sum(c['hypothesisEligibility'][h] for c in candidates) for h in ['H1','H2','H3','H4','H5']},
          **check}

    def completed_hours(self,start,now):
        if start is None:return []
        out=[]
        for hour in range(start//3600000*3600000,now//3600000*3600000,3600000):
            if hour<start:continue
            required=[hour+i*SURFACE for i in range(4)]
            if all(self.ledger.get(f'ack:{symbol}:{b}') for symbol in SYMBOLS for b in required):out.append(utc(hour))
        return out

def daily_snapshot(ledger,day):
    """Immutable directory published only after all Parquet/raw hashes reconcile.

    The generic Parquet payload is canonical JSON, preserving every schema field
    without lossy inferred nested types. Raw response bytes remain exact binary.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq
    start=int(dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp()*1000)
    end=start+86400000
    if stamp()<end:raise RuntimeError('CANNOT_SEAL_INCOMPLETE_UTC_DAY')
    final=ledger.folder/'daily'/day
    if final.exists():return verify_snapshot(final)
    temp=ledger.folder/'daily'/f'.{day}-{time.monotonic_ns()}'
    temp.mkdir(parents=True)
    with ledger.lock:
        records=ledger.db.execute('SELECT seq,id,committed_at,payload,previous_hash,chain_hash FROM records WHERE committed_at>=? AND committed_at<? ORDER BY seq',(start,end)).fetchall()
        # References may point to earlier warmup days. Copy their raw payloads too.
        refs={v for r in records for v in json.loads(r[3]).get('payloadRefs',[])}
        raws=[]
        for row in ledger.db.execute('SELECT version,source,symbol,interval_ms,raw,raw_hash,evidence FROM responses'):
            e=json.loads(row[-1]);at=e['responseReceivedAt']
            if start<=at<end or row[0] in refs:raws.append(row)
        check=ledger.verify()
        ledger_count=ledger.count(start,end)
    rs=pa.schema([('seq',pa.int64()),('id',pa.string()),('committedAt',pa.int64()),('payload',pa.string()),('previousHash',pa.string()),('chainHash',pa.string())])
    bs=pa.schema([('inputVersionId',pa.int64()),('source',pa.string()),('symbol',pa.string()),('intervalMs',pa.int64()),('raw',pa.binary()),('rawHash',pa.string()),('evidence',pa.string())])
    for file,data,schema in [('records.parquet',records,rs),('responses.parquet',raws,bs)]:
        table=pa.Table.from_pylist([dict(zip(schema.names,r)) for r in data],schema=schema)
        pq.write_table(table,temp/file,compression='zstd')
        with (temp/file).open('r+b') as f:os.fsync(f.fileno())
    manifest={'schemaVersion':SCHEMA,'day':day,'createdAt':stamp(),'recordCount':len(records),'responseCount':len(raws),
      'firstSequence':records[0][0] if records else None,'lastSequence':records[-1][0] if records else None,
      'recordLogicalHash':digest([list(r) for r in records]),'rawLogicalHash':digest([(r[0],r[5]) for r in raws]),
      'files':{f:digest((temp/f).read_bytes()) for f in ['records.parquet','responses.parquet']},
      'captureLedger':ledger_count,'verification':check,'retention':'LOSSLESS_ENTIRE_COHORT_PLUS_ANALYSIS_NO_PRUNE'}
    immutable(temp/'manifest.json',canonical(manifest))
    verify_snapshot(temp)
    temp.rename(final)
    if os.name!='nt':
        fd=os.open(final.parent,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    return verify_snapshot(final)

def verify_snapshot(folder):
    import pyarrow.parquet as pq
    folder=Path(folder);m=json.loads((folder/'manifest.json').read_text())
    for f,h in m['files'].items():
        if digest((folder/f).read_bytes())!=h:raise RuntimeError('SNAPSHOT_FILE_HASH_MISMATCH')
    records=pq.read_table(folder/'records.parquet').to_pylist()
    responses=pq.read_table(folder/'responses.parquet').to_pylist()
    if len(records)!=m['recordCount'] or len(responses)!=m['responseCount']:raise RuntimeError('SNAPSHOT_COUNT_MISMATCH')
    if digest([list(r.values()) for r in records])!=m['recordLogicalHash']:raise RuntimeError('SNAPSHOT_LOGICAL_MISMATCH')
    if digest([(r['inputVersionId'],r['rawHash']) for r in responses])!=m['rawLogicalHash']:raise RuntimeError('SNAPSHOT_RAW_LOGICAL_MISMATCH')
    versions={r['inputVersionId'] for r in responses}
    for r in responses:
        if digest(r['raw'])!=r['rawHash']:raise RuntimeError('SNAPSHOT_RAW_HASH_MISMATCH')
    for r in records:
        if any(v not in versions for v in json.loads(r['payload']).get('payloadRefs',[])):raise RuntimeError('SNAPSHOT_UNRESOLVED_REFERENCE')
    return {'status':'PASS','day':m['day'],'records':len(records),'responses':len(responses),'manifestHash':digest((folder/'manifest.json').read_bytes())}

def emit_report(observer,folder):
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    s=observer.status();(folder/'operational_status.json').write_bytes(canonical(s))
    start=observer.ledger.get('readiness:start');now=stamp()
    fields=['utc_hour','state','scheduled_surfaces','acknowledged_surfaces','attempted','accepted','skipped','strict_unavailable_surfaces']
    with (folder/'readiness_hourly.csv').open('w',newline='') as f:
        writer=csv.DictWriter(f,fields);writer.writeheader()
        if start:
            first=start['startAt']//3600000*3600000
            for hour in range(first,now//3600000*3600000+1,3600000):
                end=hour+3600000
                ss=[x for x in observer.ledger.rows('INPUT_SNAPSHOT') if hour<=x['barCloseAt']<end]
                cs=observer.ledger.count(hour,end)
                writer.writerow({'utc_hour':utc(hour),'state':'CURRENT_PARTIAL' if end>now else 'COMPLETED_ACCOUNTED' if utc(hour) in s['completedUtcHours'] else 'INCOMPLETE',
                  'scheduled_surfaces':len(SYMBOLS)*4,'acknowledged_surfaces':sum(bool(observer.ledger.get(f'ack:{x["symbol"]}:{x["barCloseAt"]}')) for x in ss),
                  'attempted':sum(x['attempted'] for x in cs),'accepted':sum(x['accepted'] for x in cs),'skipped':0,
                  'strict_unavailable_surfaces':sum(x['strictAvailabilityFailed'] for x in ss)})
    with (folder/'late_input_analysis.csv').open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['symbol','bar_close_utc','decision_at_utc','field','required_latest_bar','first_physical_receipt_ns','deadline_delta_ms','unavailable_at_decision'])
        for x in observer.ledger.rows('INPUT_SNAPSHOT'):
            for source,symbol,interval,field in [('ohlcv',x['symbol'],SURFACE,'symbol200Bars'),('ohlcv','BTCUSDT',SURFACE,'btc200Bars'),('ohlcv',x['symbol'],MINUTE,'turnover1440Minutes'),('mark',x['symbol'],MINUTE,'markReference')]:
                bs=observer.ledger.select(source,symbol,interval,x['barCloseAt']-interval,x['barCloseAt'])
                b=bs[0] if bs else None
                ns=b.get('utcReceiptUpperNs') if b else None
                w.writerow([x['symbol'],utc(x['barCloseAt']),utc(x['decisionAt']),field,utc(x['barCloseAt']-interval),
                  ns,(ns-x['decisionAt']*1000000)/1000000 if ns else '',field in x['unavailableFields']])
    # Runtime cannot mint PASS: independent deployment, isolation, parity and 24h
    # evidence must all be supplied and audited. No activation command exists.
    blockers=[]
    if s['completedReadinessHours']<24:blockers.append('FULL_24H_ACCOUNTING_NOT_COMPLETE')
    if not observer.sealer:blockers.append('OUTCOME_CUSTODIAN_PUBLIC_KEY_MISSING')
    if s['strictUnavailableSurfaces']:blockers.append('STRICT_PLUS_1MS_SURFACE_INPUT_UNAVAILABLE')
    report={'status':'INCOMPLETE','completedHours':s['completedReadinessHours'],'blockers':blockers,
      'operationalStatus':s,'actual_start_utc':None,'readiness_receipt':None,'activation_receipt':None}
    (folder/'readiness_state.json').write_bytes(canonical(report))
    return report

def serve(observer,port):
    page=(ROOT/'status.html').read_bytes()
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path in ['/','/status.html']:data=page;kind='text/html'
            elif self.path=='/status':data=canonical(observer.status());kind='application/json'
            elif self.path=='/health':data=b'{"researchOnly":true}';kind='application/json'
            else:self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
        def do_POST(self):self.send_error(405)
        def log_message(self,*args):pass
    server=http.server.ThreadingHTTPServer(('0.0.0.0',port),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    return server

def validate_activation(receipt,ledger,hash,key_fingerprint):
    ready=ledger.get('readiness:pass')
    if not ready or ready['status']!='PASS':raise RuntimeError('READINESS_PASS_RECEIPT_REQUIRED')
    ready_at=ready['receiptCommittedAt']
    registered=int(dt.datetime.fromisoformat(COHORT['registered_at_utc']).timestamp()*1000)
    earliest=math.ceil((max(ready_at,registered)+48*3600000)/86400000)*86400000
    start=int(dt.datetime.fromisoformat(receipt['actual_start_utc'].replace('Z','+00:00')).timestamp()*1000)
    if start!=earliest:raise RuntimeError('FIRST_MIDNIGHT_AFTER_BOTH_PLUS_48H_REQUIRED')
    for k,expected in [('registrationHash',REGISTRATION),('universeHash',UNIVERSE),('observerImplementationHash',hash),('publicKeyFingerprint',key_fingerprint)]:
        if receipt.get(k)!=expected:raise RuntimeError('ACTIVATION_HASH_MISMATCH:'+k)
    if receipt.get('readinessReceiptHash')!=digest({k:v for k,v in ready.items() if k not in ['recordType','committedAt']}):raise RuntimeError('ACTIVATION_READINESS_RECEIPT_HASH_MISMATCH')
    if receipt['receiptCommittedAt']>=start:raise RuntimeError('ACTIVATION_MUST_BE_COMMITTED_BEFORE_START')
    if receipt.get('durationDays')!=60 or receipt.get('maximumDurationDays')!=120:raise RuntimeError('FROZEN_END_RULE_REQUIRED')
    return start

def first_unacknowledged_surface(ledger,start,end):
    with ledger.lock:
        rows=ledger.db.execute("SELECT i.bar,COUNT(DISTINCT i.symbol) FROM intents i JOIN records r ON i.id=r.id WHERE i.type='SCAN_ACK' AND i.bar>=? AND i.bar<? GROUP BY i.bar",(start,end)).fetchall()
    counts=dict(rows)
    for bar in range(start,end,SURFACE):
        if counts.get(bar,0)!=len(SYMBOLS):return bar
    return end

def run(folder,key,port,activation=None):
    if not key:raise RuntimeError('BLOCKED: OUTCOME_PUBLIC_KEY_PATH_REQUIRED; do not start readiness without outcome seal')
    ledger=Ledger(folder);sealer=Sealer(Path(key).read_bytes());observer=Observer(ledger,sealer);feed=Feed(ledger)
    start=ledger.get('readiness:start')
    if start and (start['implementationHash']!=observer.hash or start['keyFingerprint']!=sealer.fingerprint):raise RuntimeError('READINESS_IMPLEMENTATION_OR_SEAL_CHANGED_NEW_AUDIT_REQUIRED')
    activated=None
    if activation:
        receipt=json.loads(Path(activation).read_text())
        activated=validate_activation(receipt,ledger,observer.hash,sealer.fingerprint)
        if stamp()>activated and not ledger.get('activation:receipt'):raise RuntimeError('NO_RETROSPECTIVE_COHORT_ACTIVATION')
        ledger.append('activation:receipt',{'recordType':'ACTIVATION_RECEIPT',**receipt})
        observer.active_start=activated
    stop=threading.Event();failure=[];feed_ready=threading.Event()
    def collect():
        try:
            feed.calibrate();cut=stamp()//MINUTE*MINUTE
            # 72h warmup, received NOW and explicitly labeled; can only support future decisions.
            jobs=[(source,symbol,interval) for symbol in sorted(set(SYMBOLS+['BTCUSDT']))
                  for source,interval in [('ohlcv',MINUTE),('ohlcv',SURFACE),('mark',MINUTE),('premium',MINUTE)]]
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                futures=[pool.submit(feed.capture,src,sym,it,cut-72*60*MINUTE,cut,True) for src,sym,it in jobs]
                for future in futures:future.result()
            feed_ready.set();last=cut
            while not stop.is_set():
                feed.calibrate();cut=stamp()//MINUTE*MINUTE
                if cut>last:
                    lo=max(last-2*MINUTE,cut-15*MINUTE)
                    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                        futures=[pool.submit(feed.capture,src,sym,it,lo if it==MINUTE else cut-2*SURFACE,cut) for src,sym,it in jobs if it==MINUTE or cut//SURFACE>last//SURFACE]
                        for future in futures:future.result()
                    last=cut
                stop.wait(1)
        except BaseException as e:
            failure.append(str(e));stop.set()
    threading.Thread(target=collect,daemon=True).start();server=serve(observer,port)
    try:
        while not feed_ready.wait(1):
            if stop.is_set():raise RuntimeError('FEED_WARMUP_FAILED:'+str(failure))
        if not start:
            # Full UTC day gives an immutable daily snapshot at end of dry run.
            first=(stamp()//86400000+1)*86400000
            start=ledger.append('readiness:start',{'recordType':'READINESS_START','startAt':first,'schemaVersion':SCHEMA,
                'implementationHash':observer.hash,'keyFingerprint':sealer.fingerprint,'cohortId':COHORT['cohort_id'],
                'registrationHash':REGISTRATION,'universeHash':UNIVERSE,'classification':'READINESS_ONLY'})
        capture_start=activated if activated is not None else start['startAt']
        capture_end=capture_start+(60*86400000 if activated is not None else 86400000)
        next_bar=first_unacknowledged_surface(ledger,capture_start,capture_end)
        while not stop.is_set():
            now=stamp()
            if now>=next_bar+1 and next_bar<capture_end:
                for symbol in SYMBOLS:observer.surface(symbol,next_bar)
                next_bar+=SURFACE
            observer.outcomes(now)
            if now//60000!=locals().get('last_report_minute'):
                emit_report(observer,ledger.folder/'audit');last_report_minute=now//60000
            yesterday=dt.datetime.now(dt.timezone.utc).date()-dt.timedelta(days=1)
            if now>=start['startAt']+86400000 or (ledger.folder/'daily'/str(yesterday)).exists():
                daily_snapshot(ledger,str(yesterday))
            if activated is not None and now>=capture_end:
                # Stop without unblinding at day60. An extension requires a
                # separately committed counts-only receipt; never infer one.
                ledger.append('cohort:day60-counts',{'recordType':'COUNTS_ONLY_STOP','cohortId':COHORT['cohort_id'],
                    'at':capture_end,'extensionAllowedDays':60,'outcomesRemainSealed':True})
                if now>=capture_end+240*MINUTE:
                    emit_report(observer,ledger.folder/'audit');return
            if next_bar>=capture_end and now>=capture_end+240*MINUTE:
                emit_report(observer,ledger.folder/'audit');return
            stop.wait(1)
        raise RuntimeError('CAPTURE_STOPPED:'+str(failure))
    finally:
        stop.set();server.shutdown();observer.adapter.close();ledger.close()

def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=['run','report','snapshot']);p.add_argument('--data',default=os.getenv('OBSERVER_DATA_DIR','runtime'))
    p.add_argument('--activation-receipt')
    p.add_argument('--public-key',default=os.getenv('OUTCOME_PUBLIC_KEY_PATH'));p.add_argument('--port',type=int,default=int(os.getenv('PORT','8080')));p.add_argument('--day')
    args=p.parse_args()
    if args.command=='run':run(args.data,args.public_key,args.port,args.activation_receipt)
    elif args.command=='snapshot':
        ledger=Ledger(args.data)
        try:print(json.dumps(daily_snapshot(ledger,args.day)))
        finally:ledger.close()
    else:
        ledger=Ledger(args.data);observer=Observer(ledger)
        try:print(json.dumps(emit_report(observer,ledger.folder/'audit')))
        finally:observer.adapter.close();ledger.close()

if __name__=='__main__':main()
