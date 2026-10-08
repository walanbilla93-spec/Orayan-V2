"""Offline HTTP and export contract tests; live PostgreSQL checks are separate."""
import asyncio
import csv
import gzip
import hashlib
import io
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from multidict import MultiDict
import research_api as api

TOKEN = 'test-only-abcdefghijklmnopqrstuvwxyz-0123456789ABCDEFG'
QUERY = {'dataset':'predictions','start':'2026-10-07T10:00:00Z','end':'2026-10-07T10:05:00Z'}


class FakeDB:
    def __init__(self):
        self.rows = [('event-1','2026-10-07T10:01:00+00:00','BTCUSDT',
                      json.dumps({'feature_snapshot':{'volume_raw':'0.0000100'},'prediction':0.123456789,'execution_enabled':False}))]
        self.calls = 0
        self.error = False

    async def metadata(self):
        self.calls += 1
        return {'database_bytes':1000000,'tables':{},'streams':[]}

    async def estimate(self, selection):
        self.calls += 1
        if self.error:
            raise api.GuardError('This range is too large.')
        return {'estimated_rows':len(self.rows)}

    async def records(self, selection):
        for row in self.rows:
            yield row
            await asyncio.sleep(0)


class PureTests(unittest.TestCase):
    def test_parameterized_allowlists_and_time_bounds(self):
        for field,value in [('dataset','predictions; DROP TABLE labels'),('symbol',"BTCUSDT' OR 1=1 --"),
                            ('stream','unknown'),('start','2026-10-07T10:00:00'),('end','2026-10-08T10:00:00Z'),('format','zip')]:
            q = {**QUERY,field:value}
            if field=='stream':q['dataset']='capture'
            with self.subTest(field=field), self.assertRaises(api.GuardError):
                api.Selection.parse(MultiDict(q))
        s=api.Selection.parse(MultiDict({**QUERY,'symbol':'BTCUSDT'}))
        sql,args=s.sql()
        self.assertNotIn('BTCUSDT',sql)
        self.assertIn('BTCUSDT',args)

    def test_repeated_filter_rejected(self):
        q=MultiDict(QUERY);q.add('dataset','labels')
        with self.assertRaises(api.GuardError):api.Selection.parse(q)

    def test_labels_use_prediction_event_clock(self):
        s=api.Selection.parse(MultiDict({**QUERY,'dataset':'labels','symbol':'ETHUSDT'}))
        q,args=s.sql()
        self.assertIn('JOIN public.predictions',q)
        self.assertIn('p.event_ms',q)
        self.assertEqual(args[-1],'ETHUSDT')

    def test_long_chunk_overlap_not_silently_excluded(self):
        s=api.Selection.parse(MultiDict({**QUERY,'dataset':'capture','stream':'raw_trades'}))
        q,args=s.sql()
        self.assertIn('last_ms >= %s AND first_ms < %s',q)
        self.assertNotIn('last_ms <',q)

    def test_gzip_chunk_integrity_and_exact_nested_decimals(self):
        text=json.dumps({'receipt_ms':123,'payload':{'p':'0.00100'},'symbol':'BTCUSDT'})
        payload=gzip.compress((text+'\n').encode())
        sha=hashlib.sha256(payload).hexdigest()
        self.assertEqual(list(api.unpack_lines(payload,sha)),[text])
        with self.assertRaises(api.GuardError):list(api.unpack_lines(payload,'bad'))
        self.assertEqual(api.receipt({'window_end_ms':456}),456)
        with self.assertRaises(api.GuardError):api.receipt({'receipt_ms':None})

    def test_zip_bomb_and_long_line_guard(self):
        payload=gzip.compress(b'a'*(api.MAX_LINE+1))
        with self.assertRaises(api.GuardError):list(api.unpack_lines(payload,hashlib.sha256(payload).hexdigest()))
        with patch.object(api,'MAX_DECODED_CHUNK',4):
            payload=gzip.compress(b'a\na\na\n')
            with self.assertRaises(api.GuardError):list(api.unpack_lines(payload,hashlib.sha256(payload).hexdigest()))

    def test_cookie_tamper_expiry_rotation(self):
        auth=api.Access(TOKEN);cookie=auth.cookie()
        self.assertTrue(auth.valid(cookie))
        self.assertFalse(auth.valid(cookie+'x'))
        self.assertFalse(api.Access(TOKEN+'x').valid(cookie))
        with patch.object(api.time,'time',return_value=100):
            auth=api.Access(TOKEN);cookie=auth.cookie()
        with patch.object(api.time,'time',return_value=30000):self.assertFalse(auth.valid(cookie))
        with self.assertRaises(RuntimeError):api.Access('weak')

    def test_static_assets_no_credentials_or_inline_scripts(self):
        for p in api.ROOT.glob('*'):
            text=p.read_text()
            self.assertNotIn(TOKEN,text)
            self.assertNotIn('PGPASSWORD',text)
            self.assertNotIn('postgresql://',text)
        self.assertIn('history.replaceState', (api.ROOT/'app.js').read_text())

    def test_frozen_observer_and_model_files_unchanged(self):
        root=Path(__file__).parent
        lock=json.loads((root/'research_overlay_lock.json').read_text())
        for name,sha in lock['observer_files'].items():
            self.assertEqual(hashlib.sha256((root/name).read_bytes()).hexdigest(),sha,name)
        recipe=(root/'research.Dockerfile').read_text()
        self.assertIn('LABEL org.opencontainers.image.revision=${RESEARCH_REVISION}',recipe)
        self.assertIn('GIT_COMMIT='+lock['observer_commit'],recipe)


class HTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db=FakeDB()
        self.client=TestClient(TestServer(api.create_app(db=self.db,token=TOKEN)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    def cookie(self):
        return {'Cookie':'research_session='+api.Access(TOKEN).cookie()}

    async def test_public_blocked_no_database_query(self):
        for route in ('status','estimate','download'):
            r=await self.client.get('/research/api/'+route,params=QUERY)
            self.assertEqual(r.status,401)
        self.assertEqual(self.db.calls,0)
        r=await self.client.get('/research/')
        self.assertEqual(r.status,200)
        self.assertEqual(r.headers['Cache-Control'],'no-store')
        self.assertIn("script-src 'self'",r.headers['Content-Security-Policy'])

    async def test_same_origin_login_and_cookie_security(self):
        r=await self.client.post('/research/session',json={'token':TOKEN})
        self.assertEqual(r.status,403)
        origin='https://'+self.client.make_url('/').host+':'+str(self.client.make_url('/').port)
        r=await self.client.post('/research/session',headers={'Origin':origin},json={'token':TOKEN})
        self.assertEqual(r.status,200)
        self.assertIn('HttpOnly',r.headers['Set-Cookie'])
        self.assertIn('Secure',r.headers['Set-Cookie'])
        self.assertIn('SameSite=Strict',r.headers['Set-Cookie'])
        r=await self.client.post('/research/session',headers={'Origin':'https://attacker.example'},json={'token':TOKEN})
        self.assertEqual(r.status,403)

    async def test_metadata_and_no_mutation_controls(self):
        r=await self.client.get('/research/api/status',headers=self.cookie())
        self.assertEqual(r.status,200)
        self.assertEqual((await r.json())['database_bytes'],1000000)
        for method,route in [('DELETE','/research/api/status'),('POST','/research/api/reset'),('PUT','/research/api/download')]:
            r=await self.client.request(method,route,headers=self.cookie())
            self.assertIn(r.status,(404,405))

    async def test_csv_and_gzip_export_correctness(self):
        for fmt in ['csv','csv.gz']:
            r=await self.client.get('/research/api/download',headers=self.cookie(),params={**QUERY,'format':fmt})
            self.assertEqual(r.status,200)
            data=await r.read()
            if fmt=='csv.gz':data=gzip.decompress(data)
            rows=list(csv.reader(io.StringIO(data.decode())))
            self.assertEqual(rows[0],['id','event_at_utc','symbol','record_json'])
            obj=json.loads(rows[1][3])
            self.assertEqual(obj['feature_snapshot']['volume_raw'],'0.0000100')
            self.assertEqual(obj['prediction'],0.123456789)
            self.assertEqual(len(rows),2)

    async def test_large_export_rejected_before_success_headers(self):
        self.db.error=True
        r=await self.client.get('/research/api/download',params=QUERY,headers=self.cookie())
        self.assertEqual(r.status,400)
        self.assertNotIn('Content-Disposition',r.headers)

    async def test_unknown_schema_fails_closed(self):
        class Cursor:
            async def fetchall(self):return [('predictions','id','text')]
        class Conn:
            async def execute(self,*args):return Cursor()
        with self.assertRaises(api.GuardError):await api.ResearchDB().validate(Conn())

    async def test_database_readonly_options_and_cleanup(self):
        class Conn:
            def __init__(self):self.commands=[];self.closed=False;self.rolled=False
            async def execute(self,q):self.commands.append(q)
            async def rollback(self):self.rolled=True
            async def close(self):self.closed=True
        c=Conn();settings={}
        async def connect(**kwargs):settings.update(kwargs);return c
        import psycopg
        env={'PGHOST':'test','PGDATABASE':'test','PGUSER':'test','PGPASSWORD':'not-real'}
        with patch.dict(os.environ,env),patch.object(psycopg.AsyncConnection,'connect',connect):
            async with api.connect_readonly() as conn:self.assertIs(conn,c)
        self.assertIn('default_transaction_read_only=on',settings['options'])
        self.assertIn('SET TRANSACTION READ ONLY',c.commands)
        self.assertTrue(c.closed and c.rolled)

    async def test_streaming_output_is_not_accumulated(self):
        import tracemalloc,zlib
        class LargeDB(FakeDB):
            async def estimate(self,selection):return {'estimated_rows':10000}
            async def records(self,selection):
                for i in range(10000):
                    yield (str(i),'2026-10-07T10:01:00Z','BTCUSDT',json.dumps({'data':'x'*1000,'sequence':i}))
                    if i%100==0:await asyncio.sleep(0)
        await self.client.close()
        self.client=TestClient(TestServer(api.create_app(db=LargeDB(),token=TOKEN)))
        await self.client.start_server()
        tracemalloc.start()
        r=await self.client.get('/research/api/download',params=QUERY,headers=self.cookie())
        decoder=zlib.decompressobj(31);newlines=0
        async for chunk in r.content.iter_chunked(4096):
            newlines+=decoder.decompress(chunk).count(b'\n')
        newlines+=decoder.flush().count(b'\n')
        _,peak=tracemalloc.get_traced_memory();tracemalloc.stop()
        self.assertTrue(decoder.eof)
        self.assertEqual(newlines,10001)
        self.assertLess(peak,16*1024**2)

    async def test_row_guard_aborts_incomplete_gzip(self):
        import aiohttp,zlib
        self.db.rows=self.db.rows*2
        with patch.object(api,'MAX_ROWS',1):
            r=await self.client.get('/research/api/download',params=QUERY,headers=self.cookie())
            try:
                data=await r.read()
            except aiohttp.ClientError:
                return  # browser receives failed transfer
            decoder=zlib.decompressobj(31)
            decoder.decompress(data)
            self.assertFalse(decoder.eof)

    async def test_global_query_gate_protects_observer(self):
        started=asyncio.Event();finish=asyncio.Event()
        class SlowDB(FakeDB):
            async def estimate(self,selection):
                started.set();await finish.wait();return {}
        await self.client.close()
        self.client=TestClient(TestServer(api.create_app(db=SlowDB(),token=TOKEN)))
        await self.client.start_server()
        running=asyncio.create_task(self.client.get('/research/api/estimate',params=QUERY,headers=self.cookie()))
        await started.wait()
        r=await self.client.get('/research/api/status',headers=self.cookie())
        self.assertEqual(r.status,429)
        finish.set();r=await running
        self.assertEqual(r.status,200)


if __name__=='__main__':unittest.main()
