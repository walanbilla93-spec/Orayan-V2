"""Outcome UID only: read capture, append private outcomes, publish safe receipts."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import time
import observer as o

class NoAdapter:
    def evaluate(self,*args):raise RuntimeError('OUTCOME_WORKER_CANNOT_EVALUATE_CANDIDATES')
    def close(self):pass

def run(root):
    root=Path(root);capture=o.ReadOnlyLedger(root/'capture')
    store=o.OutcomeStore(capture,root/'outcomes',root/'outcome_receipts')
    observer=o.Observer(capture,store,NoAdapter())
    try:
        while True:
            observer.outcomes()
            yesterday=str(dt.datetime.now(dt.timezone.utc).date()-dt.timedelta(days=1))
            private=o.daily_snapshot(store.private,yesterday)
            public=o.daily_snapshot(store.receipts,yesterday)
            checks={'status':'PASS','observerImplementationHash':observer.hash,'sealMode':o.SEAL_MODE,
                'privateWAL':store.private.verify(),'publicReceiptWAL':store.receipts.verify(),
                'privateSnapshot':private,'receiptSnapshot':public,
                'attempted':sum(x['attempted'] for x in store.private.count()),
                'accepted':sum(x['accepted'] for x in store.private.count()),'skipped':0,'checkedAt':o.stamp()}
            target=root/'outcome_receipts/worker_status.json';temp=target.with_suffix('.tmp')
            temp.write_bytes(o.canonical(checks));os.chmod(temp,0o644);temp.replace(target)
            time.sleep(30)
    finally:store.close();capture.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);x=p.parse_args();run(x.root)
