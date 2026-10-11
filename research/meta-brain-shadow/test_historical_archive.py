import base64
import gzip
import hashlib
import io
import json
import unittest
import zipfile
from contextlib import asynccontextmanager
from unittest.mock import patch
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import historical_archive as a

class Cursor:
    def __init__(self, db): self.db=db; self.rows=[]
    async def __aenter__(self): return self
    async def __aexit__(self,*args): pass
    async def execute(self,sql,args):
        table=sql.split('FROM public.')[1].split()[0]
        self.rows=list(self.db.rows[table]);self.description=[type('Column',(),{'name':key}) for key in self.rows[0]] if self.rows else []
    async def fetchmany(self,n): out=self.rows[:n];self.rows=self.rows[n:];return [tuple(r.values()) for r in out]

class DB:
    def __init__(self, rows):self.rows=rows
    def cursor(self,**kw):return Cursor(self)
    async def execute(self,sql,args):
        table=sql.split('FROM public.')[1].split()[0]
        return type('Count',(),{'fetchone':lambda s: self.count(table)})()
    async def count(self,t):return (len(self.rows[t]),)

class ArchiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.date='2026-10-10';t=1791563400000
        blob=gzip.compress((a.canonical({'receipt_ms':t,'payload':{'price':'123.00000001'}})+'\n').encode(),mtime=0)
        self.db=DB({name:[] for name in a.TABLES})
        self.db.rows['capture_chunks']=[{'id':'original','stream':'raw_trades','symbol':'BTCUSDT','first_ms':t,'last_ms':t+1,'rows':1,'sha256':hashlib.sha256(blob).hexdigest(),'payload':blob}]
        self.info={'dates':[self.date],'watermark_sha256':'frozen','watermark':{'counts':{n:len(v) for n,v in self.db.rows.items()}}}
        async def inv(conn):return self.info
        @asynccontextmanager
        async def ro():yield self.db
        self.patchers=[patch.object(a,'inventory',inv),patch.object(a,'readonly',ro)]
        for p in self.patchers:p.start()
        app=web.Application();status,download=a.make_handlers();app.router.add_get('/status',status);app.router.add_get('/{date}.zip',download)
        self.client=TestClient(TestServer(app));await self.client.start_server()
    async def asyncTearDown(self):
        await self.client.close()
        for p in self.patchers:p.stop()
    async def test_lossless_chunk_manifest_and_crc(self):
        r=await self.client.get('/'+self.date+'.zip?watermark=frozen');self.assertEqual(r.status,200)
        with zipfile.ZipFile(io.BytesIO(await r.read())) as z:
            self.assertIsNone(z.testzip());m=json.loads(z.read('manifest.json'))
            self.assertEqual(set(z.namelist()),set(m['files'])|{'manifest.json'})
            for name,record in m['files'].items():
                data=z.read(name);self.assertEqual(hashlib.sha256(data).hexdigest(),record['sha256']);self.assertEqual(len(data),record['bytes'])
            row=json.loads(z.read('capture_chunks.ndjson'));self.assertEqual(base64.b64decode(row['payload']),self.db.rows['capture_chunks'][0]['payload'])
            self.assertTrue(m['complete']);self.assertEqual(m['stream_counts']['raw_trades']['events'],1)
    async def test_watermark_gate(self):
        r=await self.client.get('/'+self.date+'.zip?watermark=changed');self.assertEqual(r.status,409)
    async def test_day_gate(self):
        r=await self.client.get('/2026-10-09.zip?watermark=frozen');self.assertEqual(r.status,404)
    def test_colombo_midnight(self):
        from datetime import datetime,timezone
        midnight=int(datetime(2026,10,10,18,30,tzinfo=timezone.utc).timestamp()*1000)
        self.assertEqual(a.day(midnight-1),'2026-10-10');self.assertEqual(a.day(midnight),'2026-10-11')
    def test_sink_bounded_drain(self):
        s=a.Sink();s.write(b'abc');self.assertEqual(s.tell(),3);self.assertEqual(s.drain(),b'abc');self.assertEqual(s.drain(),b'')

if __name__=='__main__':unittest.main()
