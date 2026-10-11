import hashlib,io,json,os,sqlite3,time,unittest,zipfile
from unittest.mock import patch
from aiohttp.test_utils import TestClient,TestServer
from decision_store import CompactStore,boundaries,day
from decision_launcher import create_app

class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env=patch.dict(os.environ,{'RESEARCH_API_PUBLIC':'true','META_ARCHIVE_ACK_TOKEN':'synthetic-test-secret'});self.env.start()
        self.db=sqlite3.connect(':memory:');self.store=CompactStore(self.db,'api-test');now=int(time.time()*1000)
        self.date=day(now-86400000);lo,hi=boundaries(self.date)
        self.store.add('integrity','old',None,hi-1,hi-1,{'fixture':1});self.store.add('integrity','new',None,now,now,{'fixture':2})
        self.archive=self.store.publish_day(self.date,now);self.db.commit()
        self.client=TestClient(TestServer(create_app(self.store,self.store.status,lambda body:{'resumed':body['epoch']=='api-test'})))
        await self.client.start_server()
    async def asyncTearDown(self):await self.client.close();self.db.close();self.env.stop()
    async def test_daily_public_download_is_identical_and_checksum_matches(self):
        a=await self.client.get('/research/api/daily/'+self.date+'.zip');data=await a.read()
        b=await self.client.get('/research/api/daily/'+self.date+'.zip');self.assertEqual(data,await b.read())
        self.assertEqual(hashlib.sha256(data).hexdigest(),a.headers['X-Archive-SHA256']);self.store.verify_zip(data)
    async def test_current_export_deduplicates_archived_and_current_rows(self):
        r=await self.client.get('/research/api/current.zip');self.assertEqual(r.status,200)
        self.assertEqual(self.store.verify_zip(await r.read())['event_count'],2)
    async def test_external_ack_and_resume_are_never_public_mutation_paths(self):
        body={'date':self.date,'sha256':self.archive['sha256'],'external_location':'synthetic fixture','verification':'CRC_MANIFEST_HASH_COUNTS_PASS'}
        r=await self.client.post('/research/api/external-receipt',json=body);self.assertEqual(r.status,401)
        r=await self.client.post('/research/api/resume',json={'epoch':'api-test'});self.assertEqual(r.status,401)
        headers={'Authorization':'Bearer synthetic-test-secret'}
        wrong={**body,'sha256':'wrong'};r=await self.client.post('/research/api/external-receipt',json=wrong,headers=headers);self.assertEqual(r.status,400)
        self.assertIsNone(self.store.execute('SELECT record FROM mb_external').fetchone())
        r=await self.client.post('/research/api/external-receipt',json=body,headers=headers);self.assertEqual(r.status,200)
        r=await self.client.post('/research/api/resume',json={'epoch':'api-test'},headers=headers);self.assertEqual(r.status,200)

if __name__=='__main__':unittest.main()
