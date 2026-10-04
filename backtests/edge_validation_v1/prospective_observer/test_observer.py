import base64
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import observer as o
import readiness_audit as ra

def bar(at,close=100,interval=o.MINUTE,receipt=None,version=1):
    received=(at+interval)*1000000 if receipt is None else receipt
    return {'ts':at,'intervalMs':interval,'open':close,'high':close+1,'low':close-1,'close':close,
      'volume':1,'turnover':100,'inputVersionId':version,'responseHash':'a'*64,
      'responseReceivedAt':received//1000000,'responseReceivedAtNs':received,
      'monotonicReceiptTick':received,'exchangeEnvelopeTime':at+interval,'utcReceiptUpperNs':received,
      'clockEvidenceVersion':1,'utcClockOffsetNs':0,'utcClockUncertaintyNs':0}

class StubAdapter:
    def evaluate(self,x):raise AssertionError('LATE_INPUT_MUST_NOT_INVOKE_ADAPTER')

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.ledger=o.Ledger(self.tmp.name)
    def tearDown(self):
        self.ledger.close();self.tmp.cleanup()
    def receipt(self,b,source='ohlcv',symbol='AAAUSDT'):
        raw=o.canonical({'data':b});e={k:v for k,v in b.items() if k not in ['ts','intervalMs','open','high','low','close','volume','turnover']}
        e['responseReceivedAt']=b['responseReceivedAt'];return self.ledger.receipt(source,symbol,b['intervalMs'],raw,e,[b])

    def test_exact_nanosecond_deadline_and_forming_bar(self):
        d=900001;b=bar(0,interval=o.SURFACE,receipt=d*1000000)
        self.assertTrue(o.available(b,d));b['utcReceiptUpperNs']+=1
        self.assertFalse(o.available(b,d));b['utcReceiptUpperNs']-=2;b['exchangeEnvelopeTime']-=1
        self.assertFalse(o.available(b,d))

    def test_unknown_clock_is_unavailable(self):
        b=bar(0);b['utcReceiptUpperNs']=None
        self.assertFalse(o.available(b,60001))

    def test_restart_recovers_intent_and_exact_dedup(self):
        p={'recordType':'EDGE_CANDIDATE','engine':'V2','symbol':'AAAUSDT','barCloseAt':900000}
        with self.assertRaisesRegex(RuntimeError,'INJECTED_CRASH'):self.ledger.append('a',p,True)
        self.assertEqual(self.ledger.count()[0]['pending'],1)
        self.ledger.close();self.ledger=o.Ledger(self.tmp.name)
        self.assertEqual(self.ledger.recovery['pendingRecovered'],1)
        self.ledger.append('a',p);self.assertEqual(len(self.ledger.rows()),1)
        self.assertEqual(self.ledger.count()[0]['attempted'],1)
        with self.assertRaisesRegex(RuntimeError,'IDEMPOTENCY'):self.ledger.append('a',{**p,'symbol':'OTHER'})

    def test_append_only_tables_reject_mutation(self):
        self.ledger.append('a',{'recordType':'TEST'})
        for table in ['intents','records']:
            with self.assertRaisesRegex(sqlite3.IntegrityError,'APPEND_ONLY'):self.ledger.db.execute('DELETE FROM '+table)

    def test_late_snapshot_never_rewritten_or_backfilled(self):
        obs=o.Observer(self.ledger,adapter=StubAdapter());close=200*o.SURFACE
        obs.surface('AAAUSDT',close)
        original=self.ledger.get('snapshot:AAAUSDT:'+str(close))
        for i in range(200):self.receipt(bar(i*o.SURFACE,interval=o.SURFACE,receipt=(close+2)*1000000))
        obs.surface('AAAUSDT',close)
        self.assertEqual(original,self.ledger.get('snapshot:AAAUSDT:'+str(close)))
        self.assertEqual(len(self.ledger.rows('EDGE_CANDIDATE')),2)
        self.assertTrue(all(c['attemptKind']=='UNAVAILABLE' for c in self.ledger.rows('EDGE_CANDIDATE')))
        self.assertEqual(self.ledger.verify()['unresolvedRefs'],0)
        self.assertEqual(len(self.ledger.rows('SCAN_ACK')),1)

    def test_retries_are_new_versions_and_first_eligible_retained(self):
        a=bar(0,close=100);self.receipt(a)
        self.receipt(bar(0,close=900,receipt=61002000000))
        selected=self.ledger.select('ohlcv','AAAUSDT',o.MINUTE,0,60000,60001)
        self.assertEqual(selected[0]['close'],100);self.assertEqual(self.ledger.watermark(),2)

    def test_premium_previous_1440_ddof_one_current_excluded(self):
        cut=1442*o.MINUTE
        prem=[bar(i*o.MINUTE,close=(i%13)/10000) for i in range(1441)]
        snap={'decisionAt':cut+1,'symbolMinutes':[],'btcMinutes':[],'premiumMinutes':prem}
        f=o.feature_bundle(snap);values=[x['close'] for x in prem[:-1]]
        mean=sum(values)/len(values);sd=(sum((v-mean)**2 for v in values)/(len(values)-1))**.5
        self.assertAlmostEqual(f['premiumZ'],(prem[-1]['close']-mean)/sd,places=12)
        self.assertEqual(f['premiumBaselineCount'],1440)
        prem[-1]['close']=100
        f2=o.feature_bundle(snap)
        self.assertEqual(f['premiumBaselineMean'],f2['premiumBaselineMean'])
        self.assertEqual(f['premiumBaselineHash'],f2['premiumBaselineHash'])

    def test_premium_zero_variance_and_short_baseline_unavailable(self):
        snap={'decisionAt':500*o.MINUTE+1,'symbolMinutes':[],'btcMinutes':[],
            'premiumMinutes':[bar(i*o.MINUTE,close=.1) for i in range(500)]}
        self.assertIsNone(o.feature_bundle(snap)['premiumZ'])
        snap['premiumMinutes']=snap['premiumMinutes'][-20:]
        self.assertIsNone(o.feature_bundle(snap)['premiumZ'])

    def test_rs60_exact_four_closes_no_signed_or_percent_substitution(self):
        cut=100*o.MINUTE
        s=[bar(cut-61*o.MINUTE,50),bar(cut-o.MINUTE,55)]
        b=[bar(cut-61*o.MINUTE,100),bar(cut-o.MINUTE,105)]
        f=o.feature_bundle({'decisionAt':cut+1,'symbolMinutes':s,'btcMinutes':b,'premiumMinutes':[]})
        self.assertAlmostEqual(f['relativeStrength60'],.05)
        s[0]['ts']+=o.MINUTE
        self.assertIsNone(o.feature_bundle({'decisionAt':cut+1,'symbolMinutes':s,'btcMinutes':b,'premiumMinutes':[]})['relativeStrength60'])

    def test_encryption_private_key_forbidden_and_roundtrip_custodian_only(self):
        from cryptography.hazmat.primitives.asymmetric import rsa,padding
        from cryptography.hazmat.primitives import serialization,hashes
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
        public=key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo)
        private=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
        with self.assertRaisesRegex(RuntimeError,'PRIVATE_KEY_FORBIDDEN'):o.Sealer(private)
        seal=o.Sealer(public);p={'candidateId':'a','horizonMin':15,'endAt':100,'computedAt':200,'pathComplete':True,'censorReason':None,'invertedDirectionalBps':12.3456}
        e=seal.encrypt(p);self.assertNotIn('invertedDirectionalBps',e)
        aes=key.decrypt(base64.b64decode(e['wrappedKey']),padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
        result=json.loads(AESGCM(aes).decrypt(base64.b64decode(e['nonce']),base64.b64decode(e['ciphertext']),base64.b64decode(e['aad'])))
        self.assertEqual(result,p)

    def test_outcomes_only_after_endpoint_complete_and_received(self):
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives import serialization
        key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
        pub=key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo)
        obs=o.Observer(self.ledger,o.Sealer(pub),StubAdapter())
        c={'recordType':'EDGE_CANDIDATE','candidateId':'c','prequoteEligible':True,'decisionAt':900001,'originalSide':'BUY','symbol':'AAAUSDT'}
        self.ledger.append('c',c);entry=16*o.MINUTE
        for i in range(16):self.receipt(bar(entry+i*o.MINUTE,100+i,receipt=(entry+17*o.MINUTE)*1000000))
        obs.outcomes(entry+16*o.MINUTE)
        self.assertEqual(len(self.ledger.rows('SEALED_OUTCOME')),0)
        obs.outcomes(entry+17*o.MINUTE)
        self.assertEqual(len(self.ledger.rows('SEALED_OUTCOME')),1)
        obs.outcomes(entry+17*o.MINUTE);self.assertEqual(len(self.ledger.rows('SEALED_OUTCOME')),1)
        self.assertNotIn('invertedDirectionalBps',self.ledger.rows('SEALED_OUTCOME')[0])

    def test_snapshot_lossless_parquet_and_reference_reconciliation(self):
        b=bar(0);v=self.receipt(b)
        self.ledger.append('x',{'recordType':'TEST','payloadRefs':[v],'unicode':'Σ','null':None,'number':.001})
        today=o.dt.datetime.now(o.dt.timezone.utc).date()
        with patch.object(o,'stamp',return_value=int(o.dt.datetime.combine(today+o.dt.timedelta(days=1),o.dt.time(),o.dt.timezone.utc).timestamp()*1000)+1):
            result=o.daily_snapshot(self.ledger,str(today))
            self.assertEqual(result['status'],'PASS');self.assertEqual(result['records'],1);self.assertEqual(result['responses'],1)
            self.assertEqual(result,o.daily_snapshot(self.ledger,str(today)))
        folder=Path(self.tmp.name)/'daily'/str(today)
        with (folder/'records.parquet').open('ab') as f:f.write(b'corrupt')
        with self.assertRaisesRegex(RuntimeError,'FILE_HASH'):o.verify_snapshot(folder)

    def test_zero_hours_never_creates_readiness_or_activation_receipt(self):
        obs=o.Observer(self.ledger,adapter=StubAdapter())
        report=o.emit_report(obs,Path(self.tmp.name)/'audit')
        self.assertEqual(report['status'],'INCOMPLETE');self.assertEqual(report['completedHours'],0)
        self.assertIsNone(report['actual_start_utc'])
        self.assertFalse((Path(self.tmp.name)/'audit/readiness_receipt.json').exists())
        self.assertFalse((Path(self.tmp.name)/'audit/activation_receipt.json').exists())

    def test_schema_full_required_candidate_fields_present_even_unavailable(self):
        obs=o.Observer(self.ledger,adapter=StubAdapter());obs.surface('AAAUSDT',900000)
        required=json.loads((o.ROOT/'candidate_schema.json').read_text())['required']
        for c in self.ledger.rows('EDGE_CANDIDATE'):self.assertEqual(set(required)-set(c),set())

    def test_full_elapsed_time_alone_and_untrusted_proof_cannot_pass(self):
        obs=o.Observer(self.ledger,adapter=StubAdapter())
        self.ledger.append('readiness:start',{'recordType':'READINESS_START','startAt':0,'implementationHash':obs.hash,'keyFingerprint':'x'})
        fake={k:{'status':'PASS','observerImplementationHash':obs.hash} for k in ['deployment','outcome_isolation','fixture_parity','wal_restart','snapshot']}
        r=ra.audit(obs,fake,now=86400000)
        self.assertNotEqual(r['status'],'PASS');self.assertEqual(r['accountedSurfaces'],0)
        self.assertIn('SCHEDULED_SYMBOL_SURFACE_COVERAGE_INCOMPLETE',r['blockers'])

    def test_activation_requires_pass_and_first_correct_midnight(self):
        obs=o.Observer(self.ledger,adapter=StubAdapter())
        with self.assertRaisesRegex(RuntimeError,'PASS_RECEIPT_REQUIRED'):o.validate_activation({},self.ledger,obs.hash,'key')
        receipt={'status':'PASS','receiptCommittedAt':int(o.dt.datetime(2026,10,6,12,tzinfo=o.dt.timezone.utc).timestamp()*1000),
            'observerImplementationHash':obs.hash,'schemaVersion':o.SCHEMA,'cohortId':o.COHORT['cohort_id']}
        self.ledger.append('readiness:pass',{'recordType':'READINESS_RECEIPT',**receipt})
        act={'actual_start_utc':'2026-10-09T00:00:00Z','registrationHash':o.REGISTRATION,'universeHash':o.UNIVERSE,
            'observerImplementationHash':obs.hash,'publicKeyFingerprint':'key','readinessReceiptHash':o.digest(receipt),
            'receiptCommittedAt':receipt['receiptCommittedAt']+1,'durationDays':60,'maximumDurationDays':120}
        self.assertEqual(o.validate_activation(act,self.ledger,obs.hash,'key'),int(o.dt.datetime(2026,10,9,tzinfo=o.dt.timezone.utc).timestamp()*1000))
        act['actual_start_utc']='2026-10-07T00:00:00Z'
        with self.assertRaisesRegex(RuntimeError,'48H_REQUIRED'):o.validate_activation(act,self.ledger,obs.hash,'key')

if __name__=='__main__':unittest.main(verbosity=2)
