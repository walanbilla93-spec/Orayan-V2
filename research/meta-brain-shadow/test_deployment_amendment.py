import asyncio,io,json,sqlite3,unittest
from deployment_amendment import validate,apply
from decision_store import CompactStore,digest
from decision_learning import EpisodeConsumer
from orayan_feed import ingest_export_async
from test_orayan_feed import fixture,FeedTests

class AmendmentTests(unittest.TestCase):
    def test_only_explicit_source_changes_preserve_immutable_reset_and_rows(self):
        c=sqlite3.connect(':memory:');s=CompactStore(c,'e');s.set_state('lineage',{'old':True})
        s.add('integrity','keep',None,1,1,{'original':True});s.conn.commit()
        receipt={'receipt_sha256':'reset','boot':{'epoch_id':'e','build_files_sha256':{'decision_runtime.py':'old','model.joblib':'same'}}}
        spec={'service':'meta-brain-shadow-v1','epoch':'e','previous_reset_receipt_sha256':'reset','execution_enabled':False,
              'research_rows_deleted':0,'files':{'decision_runtime.py':'new','model.joblib':'same','deployment_amendment.py':'helper'}}
        before=digest(receipt);r=apply(s,receipt,spec,'a'*40)
        self.assertEqual(s.get_event('keep')['original'],True);self.assertEqual(digest(receipt),before)
        self.assertEqual(apply(s,receipt,spec,'a'*40),r);self.assertEqual(s.status()['events'],2)
        with self.assertRaises(RuntimeError):validate(receipt,{**spec,'files':{**spec['files'],'model.joblib':'changed'}})
        c.close()

class AsyncFeedTests(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_in_later_batch_prevents_earlier_retrospective_prediction_and_yields(self):
        rows=FeedTests().rows();birth=rows[0];closed={**rows[1],'sequence':1000}
        fillers=[{**rows[2],'eventId':'f:'+str(n),'sequence':n+10} for n in range(100)]
        c=sqlite3.connect(':memory:');s=CompactStore(c,'test');calls=[];ticks=[]
        async def heartbeat():
            for n in range(4):ticks.append(n);await asyncio.sleep(0)
        task=asyncio.create_task(heartbeat())
        await ingest_export_async(s,EpisodeConsumer(s,lambda symbol,at:calls.append(at)),fixture([birth,*fillers,closed]),3000)
        self.assertTrue(ticks);self.assertEqual(calls,[])
        count=s.status()['events'];await task
        await ingest_export_async(s,EpisodeConsumer(s,lambda symbol,at:calls.append(at)),fixture([birth,*fillers,closed]),4000)
        self.assertEqual(s.status()['events'],count);c.close()

if __name__=='__main__':unittest.main()
