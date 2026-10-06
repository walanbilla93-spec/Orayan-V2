import unittest, json, tempfile, os, sqlite3, gzip, hashlib, asyncio, ast
from pathlib import Path
from unittest.mock import patch
import pandas as pd,numpy as np
from storage import Store,digest
from flow import Flow,Book
from base import Base,LiveAux
from service import enforce,Observer,PUBLIC_GETS

ROOT=Path(__file__).resolve().parent
CONFIG=json.loads((ROOT/'config.json').read_text())
LOCK=Path(os.environ.get('PHASE3A_LOCK_ROOT',str(ROOT)))

class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.base=Base(ROOT,CONFIG)

    def test_execution_guards(self):
        for key,value in [('EXECUTION_ENABLED','true'),('SHADOW_ONLY','false')]:
            with patch.dict(os.environ,{key:value}):
                with self.assertRaises(RuntimeError):enforce(CONFIG)
        self.assertTrue(all(p.startswith('/v5/market/') for p in PUBLIC_GETS))
        self.assertNotIn('/v5/order/create',PUBLIC_GETS)

    def test_immutable_ledgers_and_boundary_restart(self):
        with tempfile.TemporaryDirectory() as d:
            s=Store(d,CONFIG);row={'observation_id':'a','event_clock_ms':1,'symbol':'BTCUSDT'};s.prediction(row)
            s.label('a',{'outcome':1});s.set_boundary({'prospective_start_at':'unchanged'})
            for table in ['predictions','labels','boundary']:
                with self.assertRaises(sqlite3.IntegrityError):s.db.execute(f'UPDATE {table} SET record=?',('{}',))
                with self.assertRaises(sqlite3.IntegrityError):s.db.execute(f'DELETE FROM {table}')
            with self.assertRaises(sqlite3.IntegrityError):s.prediction(row)
            s.close();s=Store(d,CONFIG);self.assertEqual(s.boundary()['prospective_start_at'],'unchanged');s.close()

    def test_raw_roundtrip_partition_hash_and_pressure(self):
        with tempfile.TemporaryDirectory() as d:
            s=Store(d,CONFIG)
            row={'p':'0.000000000123456789','i':'exact-trade-id','S':'Buy'}
            s.append('raw_trades','BTCUSDT',row,300001);s.finish(('raw_trades','BTCUSDT'))
            (record,)=s.db.execute('SELECT record FROM segments').fetchone();rec=json.loads(record);p=Path(d)/rec['path']
            self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(),rec['sha256'])
            with gzip.open(p,'rt') as f:self.assertEqual(json.loads(f.readline()),row)
            with patch.object(s,'capacity',return_value={'allowed':False}):
                with self.assertRaises(OSError):s.append('raw_trades','BTCUSDT',row,300002)
            self.assertTrue(p.exists());s.close()

    def test_flow_delta_cvd_dedupe_and_reconnect(self):
        f=Flow(['BTCUSDT']);f.reconnect(1000)
        a={'s':'BTCUSDT','p':'100','v':'2.5','S':'Buy','i':'1','T':1500,'seq':100}
        f.trade(a,1501);f.trade(a,1502);f.trade({**a,'i':'2','v':'1.25','S':'Sell','seq':110},1600)
        r=f.rollup('BTCUSDT',1700,1,{})
        self.assertEqual(r['delta'],'1.25');self.assertEqual(r['session_cvd'],'1.25');self.assertEqual(r['trade_count'],2)
        self.assertEqual(f.duplicates,1);old=f.epoch;f.reconnect(2000)
        self.assertNotEqual(old,f.epoch);self.assertEqual(f.cvd['BTCUSDT'],0)
        self.assertFalse(f.rollup('BTCUSDT',2500,60,{})['window_within_connection'])

    def test_book_snapshot_delta_delete_and_resync(self):
        b=Book();msg={'type':'snapshot','ts':1000,'data':{'u':50,'seq':500,'b':[['99','2'],['98','4']],'a':[['101','3']]}}
        b.apply(msg,1001)
        b.apply({'type':'delta','ts':1002,'data':{'u':55,'seq':510,'b':[['98','0'],['99','5']],'a':[]}},1003)
        r=b.summary(1004);self.assertEqual(r['best_bid'],'99');self.assertEqual(r['bid_depth_25bps'],'0')
        self.assertNotIn('98',b.bids)
        with self.assertRaises(ValueError):b.apply({'type':'delta','ts':1005,'data':{'u':54,'seq':509,'b':[],'a':[]}},1006)
        self.assertFalse(b.valid);b.apply(msg,1007);self.assertTrue(b.valid)
        self.assertFalse(b.summary(30000)['book_available'])

    def test_receipt_availability_and_first_publication(self):
        aux=LiveAux();aux.add('BTCUSDT','funding',{'timestamp_ms':100,'receipt_ms':200,'funding_rate':.001})
        aux.add('BTCUSDT','funding',{'timestamp_ms':100,'receipt_ms':300,'funding_rate':.5})
        aux.decision_ms=199;self.assertTrue(aux.load('live','BTCUSDT','funding',['timestamp_ms','funding_rate']).empty)
        aux.decision_ms=250;self.assertEqual(aux.load('live','BTCUSDT','funding',['timestamp_ms','funding_rate']).iloc[0].funding_rate,.001)

    def test_verbatim_feature_math(self):
        source=LOCK/'upstream/Phase1/scripts/build_dataset.py'
        if not source.exists():self.skipTest('requires upstream audit source')
        original=ast.parse(source.read_text());deployed=ast.parse((ROOT/'frozen_features.py').read_text())
        names=['asof','exact','historical','Minutes','causal_features']
        for name in names:
            a=next(n for n in original.body if getattr(n,'name',None)==name)
            b=next(n for n in deployed.body if getattr(n,'name',None)==name)
            self.assertEqual(ast.dump(a,include_attributes=False),ast.dump(b,include_attributes=False))

    def test_independent_locked_prediction_replay(self):
        if not (LOCK/'predictions/fold3_A_locked.parquet').exists():self.skipTest('requires upstream audit predictions')
        features=pd.read_csv(LOCK/'features_sample.csv')
        differences={}
        for h in ['A','B','C']:
            expected=pd.read_parquet(LOCK/f'predictions/fold3_{h}_locked.parquet',columns=['event_id','prediction'])
            joined=features.merge(expected,on='event_id',validate='one_to_one')
            self.assertGreater(len(joined),0)
            x=joined[self.base.lock['features']];obj=self.base.models[h]
            est=obj['calibrated_model'] if obj['calibrated_model'] is not None else obj['raw_model']
            actual=est.predict(x) if h=='A' else est.predict_proba(x)[:,1]
            differences[h]={'rows':len(joined),'max_abs_error':float(np.max(abs(actual-joined.prediction)))}
            self.assertLess(differences[h]['max_abs_error'],1e-10)
        output=os.environ.get('REPLAY_REPORT')
        if output:Path(output).write_text(json.dumps(differences,indent=2))

    def test_portable_frozen_fixture(self):
        rows=json.loads((ROOT/'model_replay_fixture.json').read_text())
        for row in rows:
            x=pd.DataFrame([row['features']],columns=self.base.lock['features'])
            for c in x.columns:
                if c not in ['x__event_type','x__oi_state']:x[c]=pd.to_numeric(x[c],errors='coerce')
            for h,obj in self.base.models.items():
                est=obj['calibrated_model'] if obj['calibrated_model'] is not None else obj['raw_model']
                actual=float(est.predict(x)[0] if h=='A' else est.predict_proba(x)[0,1])
                self.assertAlmostEqual(actual,row['predictions'][h],places=10)

    def test_complete_shadow_prediction_record(self):
        fixture=json.loads((ROOT/'model_replay_fixture.json').read_text())[0]
        event={'knownAt':60000000,'event_id':'fixture-only','symbol':'BTCUSDT','eventType':fixture['features']['x__event_type'],'atr':fixture['features']['x__atr15']}
        row=self.base.predict(fixture['features'],event,60001000,None,60000000,{})
        self.assertAlmostEqual(row['head_A_prediction'],fixture['predictions']['A'],places=10)
        self.assertAlmostEqual(row['head_B_probability'],fixture['predictions']['B'],places=10)
        self.assertEqual(row['cohort'],'historical_bootstrap');self.assertFalse(row['execution_enabled'])
        self.assertIn('activity_uncertainty',row['head_D']);self.assertFalse(row['flow_used_by_base'])

    def test_future_drift_rows_excluded(self):
        b=self.base;at=20*86400000;past={'cohort':'prospective','feature_snapshot':json.loads((ROOT/'model_replay_fixture.json').read_text())[0]['features']}
        with tempfile.TemporaryDirectory() as d:
            s=Store(d,CONFIG)
            row={**past,'observation_id':'past','event_clock_ms':at-86400000,'symbol':'BTCUSDT'};s.prediction(row)
            b.drift_day=None;b.update_drift(s.db,at);before=b.drift_score
            row={**past,'observation_id':'future','event_clock_ms':at+86400000,'symbol':'BTCUSDT'}
            row['feature_snapshot']={k:999999 if isinstance(v,(int,float)) else v for k,v in row['feature_snapshot'].items()};s.prediction(row)
            b.drift_day=None;b.update_drift(s.db,at);self.assertEqual(before,b.drift_score);s.close()

    def test_label_maturity_and_gap_censor(self):
        b=self.base;q=60000000;start=q+60000;data={}
        for t in range(start-60000,start+61*60000,60000):
            data[t]={'open':100,'close':100,'high':102,'low':98,'receipt_ms':t+60000,'cohort':'prospective'}
        old=b.minutes['BTCUSDT'];b.minutes['BTCUSDT']=data
        try:
            row={'symbol':'BTCUSDT','event_clock_ms':q,'frozen_atr':1,'observation_id':'id'}
            self.assertIsNone(b.mature_labels(row,start+60*60000))
            label=b.mature_labels(row,start+61*60000);self.assertEqual(label['head_A_realized_rv_bps'],0)
            self.assertEqual(label['head_B_realized_two_sided_1atr'],1)
            del data[start+60000];self.assertEqual(b.mature_labels(row,start+61*60000)['status'],'CENSORED_GAP_OR_BOOTSTRAP')
        finally:b.minutes['BTCUSDT']=old

    def test_no_prospective_boundary_in_qualification(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.dict(os.environ,{'DEPLOYMENT_ENV':'qualification'}):
                o=Observer(CONFIG,d);self.assertEqual(o.cohort(9999999999999,9999999999999),'qualification_only');self.assertIsNone(o.boundary);o.store.close()

if __name__=='__main__':unittest.main(verbosity=2)
