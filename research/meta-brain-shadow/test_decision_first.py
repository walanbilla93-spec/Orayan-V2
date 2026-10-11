import hashlib,io,json,sqlite3,unittest,zipfile
from decision_store import CompactStore,WINDOW,boundaries,digest
from decision_learning import EpisodeConsumer,loss_attribution

class DecisionTests(unittest.TestCase):
    def setUp(self):self.db=sqlite3.connect(':memory:');self.s=CompactStore(self.db,'test-epoch');self.s.set_state('lineage',{'model':'frozen','config':'test'})
    def tearDown(self):self.db.close()
    def add(self,at,key='a'):
        self.s.add('meta_decision',key,'e',at,at,{'decision_ms':at,'action':'ABSTAIN','features':{'x':1.},'max_input_receipt_ms':at-1})
    def source(self,kind='candidate_birth',at=1000,event_id='source-1'):
        return {'eventId':event_id,'episodeId':'ep','kind':kind,'at':at,'capturedAt':at,'symbol':'BTCUSDT','side':'BUY','engine':'NEW_ORAYAN','btcRegime':'TREND'}
    def consumer(self):
        self.calls=[]
        def decide(symbol,now):
            self.calls.append((symbol,now));return {'decision_ms':now,'action':'ABSTAIN','max_input_receipt_ms':now-1,'frozen_estimates':{'volatility':42}}
        return EpisodeConsumer(self.s,decide)
    def test_no_orayan_signal_or_outcome_enters_independent_callback(self):
        c=self.consumer();source=self.source();c.ingest(source,1100,{'url':'readonly'})
        self.assertEqual(self.calls,[('BTCUSDT',1100)]);d=self.s.get_event('decision:source-1')
        self.assertFalse(d['orayan_inputs_used']);self.assertFalse(d['performance_summaries_used_by_model'])
        out=self.source('order_outcome',2000,'out');out.update(event='CLOSED',closedAt=1900,realisedRR=-1.)
        c.ingest(out,2200,{'url':'readonly'});self.assertEqual(d,self.s.get_event('decision:source-1'))
        self.assertTrue(self.s.get_event('orayan:out')['independent_comparison_valid'])
        self.assertEqual(self.s.get_event('loss:out')['loss_reason'][0]['category'],'unknown_ambiguous')
    def test_replay_and_restart_idempotency_and_collision(self):
        c=self.consumer();source=self.source();c.ingest(source,1100,{})
        restarted=EpisodeConsumer(self.s,c.decide);restarted.ingest(source,1200,{})
        self.assertEqual(len(self.calls),1);source['score']=999
        with self.assertRaises(ValueError):c.ingest(source,1300,{})
    def test_late_decision_is_not_counted_as_pre_outcome(self):
        c=self.consumer();c.ingest(self.source(),1100,{})
        out=self.source('order_outcome',2000,'out');out.update(event='CLOSED',closedAt=1050,realisedRR=-1.)
        c.ingest(out,2200,{})
        self.assertFalse(self.s.get_event('orayan:out')['independent_comparison_valid'])
    def test_old_candidate_and_orphan_outcome_are_censored(self):
        c=self.consumer();c.ingest(self.source(),100000,{})
        self.assertEqual(self.calls,[]);self.assertEqual(self.s.get_event('comparison:source-1')['state'],'orayan-only')
        out=self.source('forward_label',110000,'out');out['episodeId']='missing'
        c.ingest(out,110001,{})
        self.assertIn('CANONICAL_BIRTH_NOT_OBSERVED',self.s.get_event('orayan:out')['gaps_censors'])
    def test_known_outcome_prevents_even_forming_a_retroactive_decision(self):
        c=self.consumer();c.ingest(self.source(),1100,{},resolved_before_observation=True)
        self.assertEqual(self.calls,[]);self.assertEqual(self.s.get_event('comparison:source-1')['state'],'orayan-only')
    def test_material_versions_join_exact_candidate_not_latest_episode_update(self):
        c=self.consumer();birth=self.source();birth['candidateId']='birth';c.ingest(birth,1100,{})
        update=self.source('candidate_update',1200,'source-2');update['candidateId']='update';c.ingest(update,1300,{})
        out=self.source('order_outcome',2000,'out');out.update(candidateId='birth',event='CLOSED',closedAt=1900,realisedRR=-1.)
        c.ingest(out,2200,{});self.assertEqual(self.s.get_event('orayan:out')['decision_id'],'decision:source-1')
    def test_multi_reason_clocks_and_unknown_certainty(self):
        out={'realisedRR':-1,'failureEvidence':[{'category':'adverse_gap_slippage','observedAt':20,'evidence':{'gap_bps':45},'confidence':.6},
            {'category':'execution_cost_funding','observedAt':21,'evidence':{'paid_fees':5}},
            {'category':'bad_direction_regime_misread','observedAt':99,'evidence':'future'}]}
        result=loss_attribution(out,None,30);self.assertEqual(len(result['loss_reason']),2)
        out['sameMinuteAmbiguity']=True;self.assertEqual(loss_attribution(out,None,30)['loss_reason'][-1]['category'],'unknown_ambiguous')
    def test_exact_trade_version_remains_joinable_after_later_candidates_and_hot_eviction(self):
        c=self.consumer();birth=self.source();birth['candidateId']='birth';c.ingest(birth,1100,{})
        update=self.source('candidate_update',1200,'admitted');update['candidateId']='admitted';c.ingest(update,1300,{})
        opened=self.source('order_outcome',1500,'opened');opened.update(event='OPEN',tradeId='trade',decisionReference='admitted')
        c.ingest(opened,1600,{})
        for n in range(12):
            row=self.source('candidate_update',1700+n,'update-'+str(n));row['candidateId']='later-'+str(n);c.ingest(row,1800+n,{})
        self.s.execute("DELETE FROM mb_events WHERE id IN ('orayan:admitted','decision:admitted','comparison:admitted')")
        out=self.source('order_outcome',3000,'closed');out.update(event='CLOSED',closedAt=3000,realizedR=-1.,tradeId='trade',decisionReference='admitted')
        c.ingest(out,3100,{})
        self.assertEqual(self.s.get_event('orayan:closed')['decision_id'],'decision:admitted')
        self.assertTrue(self.s.get_event('orayan:closed')['independent_comparison_valid'])
    def test_statistics_do_not_leak_future_or_unobserved_outcomes(self):
        self.s.learn('r','bucket',1000,1100,-1.)
        self.assertEqual(self.s.trust('bucket',1050)['count'],0)
        self.assertEqual(self.s.trust('bucket',1200)['count'],1)
        self.s.learn('r','bucket',1000,1150,-1.);self.assertEqual(self.s.trust('bucket',1200)['count'],1)
        with self.assertRaises(ValueError):self.s.learn('future','bucket',2000,1500,1.)
    def test_daily_colombo_boundary_and_current_exact_dedup(self):
        start,end=boundaries('2026-10-10');self.add(end-1,'before');self.add(end,'after')
        archive=self.s.publish_day('2026-10-10',end+1)
        self.assertEqual(archive['manifest']['event_count'],1)
        data,m=self.s.current_export(end+3600000);self.assertEqual(m['event_count'],2);self.s.verify_zip(data)
        with self.assertRaises(ValueError):self.s.publish_day('2026-10-11',end+1)
    def test_unpublished_rows_cannot_be_evicted(self):
        start,end=boundaries('2026-10-10');self.add(start)
        with self.assertRaises(RuntimeError):self.s.compact_current(end+WINDOW)
        self.assertIsNotNone(self.s.get_event('a'))
        self.s.publish_day('2026-10-10',end+WINDOW);self.s.compact_current(end+WINDOW)
        self.assertIsNone(self.s.get_event('a'))
    def test_seven_archives_require_matching_verified_external_copy(self):
        now=boundaries('2026-10-20')[0]
        for n in range(1,8):self.s.publish_day('2026-10-'+str(n).zfill(2),now)
        with self.assertRaises(RuntimeError):self.s.publish_day('2026-10-08',now)
        oldest=json.loads(self.s.execute('SELECT record FROM mb_archives ORDER BY date LIMIT 1').fetchone()[0])
        with self.assertRaises(ValueError):self.s.mark_external(oldest['date'],'wrong','external',now)
        self.s.mark_external(oldest['date'],oldest['sha256'],'external',now)
        self.s.publish_day('2026-10-08',now);self.assertEqual(self.s.status()['archive_count'],7)
    def test_transaction_failure_leaves_no_partial_episode(self):
        c=self.consumer()
        with self.assertRaises(RuntimeError):
            with self.s.transaction():c.ingest(self.source(),1100,{});raise RuntimeError('crash')
        self.assertIsNone(self.s.get_event('orayan:source-1'))
    def test_arbitrary_raw_stream_and_execution_are_prohibited(self):
        with self.assertRaises(ValueError):self.s.add('depth_1s','raw',None,1,1,{})
        with self.assertRaises(ValueError):self.s.add('meta_decision','trade',None,1,1,{'execution_enabled':True})

if __name__=='__main__':unittest.main()
