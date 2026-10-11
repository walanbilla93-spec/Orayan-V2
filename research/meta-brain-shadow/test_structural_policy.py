import copy,unittest
from structural_policy import decide_structure,mature_structure

class StructureTests(unittest.TestCase):
    def context(self):return {'status':'AVAILABLE','events':[{'event_id':'own-BOS','eventType':'BOS','direction':1,'knownAt':60000,'level_knownAt':30000}],
        'max_input_receipt_ms':60001,'reference_close':100.,'atr15':1.}
    def decision(self):return decide_structure(self.context(),120000,True)
    def path(self):return {t:{'timestamp_ms':t,'cohort':'prospective','receipt_ms':t+60000,'open':100.,'high':100.5,'low':99.5,'close':100.25}
        for t in range(180000,3780000,60000)}
    def test_independent_confirmed_direction_has_no_calibrated_confidence(self):
        x=self.decision();self.assertEqual(x['action'],'LONG');self.assertIsNone(x['confidence']);self.assertTrue(x['experimental'])
        self.assertEqual(x['reference_geometry']['stop'],99.);self.assertEqual(x['reference_geometry']['target'],102.)
    def test_future_stale_or_conflicting_structure_abstains(self):
        x=self.context();x['events'][0]['knownAt']=120001
        self.assertEqual(decide_structure(x,120000,True)['action'],'ABSTAIN')
        self.assertEqual(decide_structure(self.context(),120000,False)['action'],'ABSTAIN')
        x=self.context();other=copy.deepcopy(x['events'][0]);other['direction']=-1;x['events'].append(other)
        self.assertEqual(decide_structure(x,120000,True)['action'],'ABSTAIN')
    def test_counterfactual_cannot_mature_early_or_through_a_gap(self):
        self.assertIsNone(mature_structure(self.decision(),self.path(),200000))
        p=self.path();p.pop(180000);self.assertEqual(mature_structure(self.decision(),p,3780000)['status'],'CENSORED_INPUT_GAP_OR_RESTART')
    def test_both_touch_is_ambiguous_and_loss_cause_is_conservative(self):
        p=self.path();p[180000].update(high=102.5,low=98.5)
        x=mature_structure(self.decision(),p,3780000);self.assertIsNone(x['realizedR']);self.assertEqual(x['endpoint'],'AMBIGUOUS_BOTH_SAME_MINUTE')
        p=self.path();p[180000]['low']=98.5;x=mature_structure(self.decision(),p,3780000)
        self.assertEqual(x['realizedR'],-1.);self.assertEqual(x['loss_reason'][0]['category'],'unknown_ambiguous')
    def test_prospective_receipts_are_required(self):
        p=self.path();p[180000]['cohort']='historical_bootstrap'
        self.assertEqual(mature_structure(self.decision(),p,3780000)['status'],'CENSORED_INPUT_GAP_OR_RESTART')

if __name__=='__main__':unittest.main()
