"""No keys/passwords: bootstrap OS roles, prove denial, then drop root forever.

10001 capture: owns input/candidate WAL, cannot read private outcomes.
10002 outcomes: reads capture, owns private outcome WAL and safe receipt WAL.
10003 status/supervisor: reads only published operational files.

Linux permissions are the seal. Windows/chmod-only substitutes are forbidden.
Root cloud administrators remain custodians; no unseal/research API exists.
"""
import argparse
import ctypes
import http.server
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import observer as o

CAPTURE=10001;OUTCOMES=10002;STATUS=10003

def drop(uid,groups):
    os.setgroups(groups);os.setgid(uid);os.setuid(uid);os.umask(0o027)
    if ctypes.CDLL(None,use_errno=True).prctl(38,1,0,0,0)!=0:raise RuntimeError('NO_NEW_PRIVILEGES_FAILED')

def child(uid,groups):return lambda:drop(uid,groups)

def own(path,uid,mode):
    path.mkdir(parents=True,exist_ok=True);os.chown(path,uid,uid);os.chmod(path,mode)
    for p in path.rglob('*'):
        if p.is_symlink():raise RuntimeError('SYMLINK_IN_CAPTURE_VOLUME_FORBIDDEN')
        os.chown(p,uid,uid);os.chmod(p,mode if p.is_dir() else (0o600 if mode==0o700 else 0o640 if mode==0o750 else 0o644))

def probe(root):
    """Execute real reads/writes under all three unprivileged identities."""
    checks={}
    code='''import pathlib,sys
path=pathlib.Path(sys.argv[1]);action=sys.argv[2];expect=sys.argv[3]
try:
 if action=='read':path.read_bytes()
 else:path.open('ab').close()
except PermissionError:
 sys.exit(0 if expect=='deny' else 2)
else:sys.exit(0 if expect=='allow' else 3)
'''
    tests=[('captureCannotReadOutcomes',CAPTURE,[],root/'outcomes/probe','read','deny'),
        ('statusCannotReadOutcomes',STATUS,[],root/'outcomes/probe','read','deny'),
        ('statusCannotReadCapture',STATUS,[],root/'capture/capture.sqlite','read','deny'),
        ('outcomesCannotWriteCapture',OUTCOMES,[CAPTURE],root/'capture/capture.sqlite','write','deny'),
        ('outcomesCanReadCapture',OUTCOMES,[CAPTURE],root/'capture/capture.sqlite','read','allow'),
        ('outcomesCanReadOwnArchive',OUTCOMES,[CAPTURE],root/'outcomes/probe','read','allow'),
        ('statusCannotWriteReceiptWAL',STATUS,[],root/'outcome_receipts/capture.sqlite','write','deny'),
        ('captureCannotWriteReceiptWAL',CAPTURE,[],root/'outcome_receipts/capture.sqlite','write','deny')]
    for name,uid,groups,path,action,expected in tests:
        r=subprocess.run([sys.executable,'-c',code,str(path),action,expected],preexec_fn=child(uid,groups),capture_output=True)
        checks[name]=r.returncode==0
    # SQLite is read-only at both the URI and OS layer, including live WAL access.
    ledger=o.Ledger(root/'capture');ledger.append('isolation:probe',{'recordType':'ISOLATION_PROBE'})
    for name in ['capture.sqlite-wal','capture.sqlite-shm']:
        path=root/'capture'/name
        if path.exists():os.chown(path,CAPTURE,CAPTURE);os.chmod(path,0o640)
    sql='import sqlite3,sys;c=sqlite3.connect(sys.argv[1]+"?mode=ro",uri=True);assert c.execute("select count(*) from records").fetchone()[0]>0'
    r=subprocess.run([sys.executable,'-c',sql,(root/'capture/capture.sqlite').resolve().as_uri()],preexec_fn=child(OUTCOMES,[CAPTURE]),capture_output=True)
    checks['outcomesReadLiveSQLiteWAL']=r.returncode==0;ledger.close()
    if not all(checks.values()):raise RuntimeError('OS_ISOLATION_PROBE_FAILED:'+json.dumps(checks))
    return {'status':'PASS','observerImplementationHash':o.implementation_hash(),'sealMode':o.SEAL_MODE,
        'captureUid':CAPTURE,'outcomeUid':OUTCOMES,'statusUid':STATUS,'checks':checks,
        'hypothesisResearcherRole':'status/capture; private outcomes inaccessible','noKeysOrPasswords':True,
        'cloudAdministratorCustody':True,'checkedAt':o.stamp()}

def setup(root):
    if os.name!='posix' or not hasattr(os,'setuid') or os.geteuid()!=0:
        raise RuntimeError('LINUX_ROOT_BOOTSTRAP_REQUIRED; no chmod-only fallback')
    root=Path(root).resolve();root.mkdir(parents=True,exist_ok=True);os.chmod(root,0o755)
    for name,uid,mode in [('capture',CAPTURE,0o750),('outcomes',OUTCOMES,0o700),
                          ('outcome_receipts',OUTCOMES,0o755),('status',CAPTURE,0o755)]:
        directory=root/name;directory.mkdir(exist_ok=True)
        if name!='status':ledger=o.Ledger(directory);ledger.close()
        own(directory,uid,mode)
    secret=root/'outcomes/probe'
    if not secret.exists():o.immutable(secret,b'OS access separation probe; no market outcome')
    os.chown(secret,OUTCOMES,OUTCOMES);os.chmod(secret,0o600)
    proof=probe(root)
    target=root/'status/isolation_proof.json';temp=target.with_suffix('.tmp')
    temp.write_bytes(o.canonical(proof));os.chmod(temp,0o444);os.replace(temp,target)
    return proof

def serve(root,port):
    page=(o.ROOT/'status.html').read_bytes()
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path in ['/','/status.html']:data=page;kind='text/html'
            elif self.path=='/status':
                try:data=(root/'status/operational_status.json').read_bytes()
                except FileNotFoundError:data=o.canonical({'observerStatus':'WARMING_UP','readinessState':'INCOMPLETE',
                    'completedReadinessHours':0,'outcomeSealStatus':o.SEAL_MODE,'actualCohortStart':None,
                    'executionAllowed':False,'mode':'PAPER_RESEARCH_ONLY','observerImplementationHash':o.implementation_hash(),
                    'preregistrationHash':o.REGISTRATION,'universeHash':o.UNIVERSE})
                kind='application/json'
            elif self.path=='/health':data=b'{"researchOnly":true,"executionAllowed":false}';kind='application/json'
            else:self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
        def do_POST(self):self.send_error(405)
        def log_message(self,*args):pass
    import threading
    server=http.server.ThreadingHTTPServer(('0.0.0.0',port),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start();return server

def run(root,port,self_test=False):
    root=Path(root).resolve();proof=setup(root);print(json.dumps({'outcomeIsolation':proof}),flush=True)
    if self_test:return
    # Only a real mounted persistent volume may start a lossless readiness audit.
    if not os.path.ismount(root):raise RuntimeError('DEDICATED_DURABLE_VOLUME_REQUIRED_AT:'+str(root))
    # Capacity is qualified conservatively. Never share/prune the trading volume.
    import shutil
    capacity=shutil.disk_usage(root)
    if capacity.free<32*1024**3:raise RuntimeError('READINESS_STORAGE_QUALIFICATION_REQUIRES_32_GIB_FREE')
    processes=[subprocess.Popen([sys.executable,'-u',str(o.ROOT/'observer.py'),'run','--data',str(root/'capture'),'--port',str(port)],preexec_fn=child(CAPTURE,[])),
        subprocess.Popen([sys.executable,'-u',str(o.ROOT/'outcome_worker.py'),'--root',str(root)],preexec_fn=child(OUTCOMES,[CAPTURE]))]
    drop(STATUS,[]);server=serve(root,port)
    def stop(*args):
        # Sibling UIDs cannot signal each other: cloud termination signals each
        # process/container. Unexpected exit stops supervision and fails readiness.
        server.shutdown();sys.exit(1)
    signal.signal(signal.SIGTERM,stop)
    while True:
        for p in processes:
            if p.poll() is not None:raise RuntimeError('ISOLATED_WORKER_EXITED:'+str(p.returncode))
        time.sleep(2)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',default=os.getenv('OBSERVER_VOLUME_ROOT','/capture'))
    p.add_argument('--port',type=int,default=int(os.getenv('PORT','8080')));p.add_argument('--self-test',action='store_true')
    args=p.parse_args()
    if args.self_test:
        with tempfile.TemporaryDirectory() as temp:run(temp,args.port,True)
    else:run(args.root,args.port)
