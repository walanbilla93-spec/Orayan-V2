"""Offline pressure/recovery tests; no production credentials or network calls."""
import asyncio
from collections import Counter
from contextlib import contextmanager
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile
import tracemalloc
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from base import Base
from pg_storage import PgStore
from service import Observer

CONFIG=json.loads((Path(__file__).parent/'config.json').read_text())
NOW=1_800_000_000_000


class Warmup:
    def __init__(self,root,config):
        self.config=config;self.lock={'files':{}};self.minutes={s:{} for s in config['symbols']}
    def minute(self,s,row):Base.minute(self,s,row)


class Store:
    def __init__(self,root,config):
        self.root=Path(root);self.allowed=True;self.write_errors=0;self.events=[]
        self.durable=[];self.buffers=[];self.closed=False;self.restores=0
    def capacity(self):return {'allowed':self.allowed,'database_bytes':3*1024**3}
    def boundary(self):return None
    def export_boundary(self):pass
    def status(self,kind,record):
        if not self.allowed:raise AssertionError('status writes while pressured')
        self.events.append((kind,record))
    def append(self,stream,symbol,row,at):
        if not self.allowed:
            self.write_errors+=1;raise OSError('CAPTURE_PAUSED_DATABASE_PRESSURE')
        self.buffers.append((stream,symbol,row))
    def flush(self):self.durable.extend(self.buffers);self.buffers.clear()
    def close(self):self.flush();self.closed=True
    def restored_minutes(self,since):self.restores+=1;return iter(())
    def bootstrap_records(self,since,symbol):
        return (row for stream,s,row in self.durable if stream=='bootstrap_ohlc' and s==symbol)


class PauseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.patches=[patch('service.Store',Store),patch('service.Base',Warmup),
                      patch.dict(os.environ,{'DEPLOYMENT_ENV':'qualification','SHADOW_STORAGE':'filesystem','PORT':'0'})]
        for p in self.patches:p.start()
        self.o=Observer(CONFIG,self.tmp.name)
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()

    async def test_paused_startup_has_liveness_no_restoration_or_capture(self):
        o=self.o;o.store.allowed=False;o.bootstrap=AsyncMock()
        task=asyncio.create_task(o.run())
        try:
            for _ in range(100):
                await asyncio.sleep(.01)
                if o.capture_pause:break
            self.assertFalse(o.stopping)
            self.assertEqual(o.store.restores,0);o.bootstrap.assert_not_awaited()
            self.assertEqual(o.capture_pause['reason'],'CAPTURE_PAUSED_DATABASE_PRESSURE')
            self.assertEqual((await o.endpoint(SimpleNamespace(path='/livez'))).status,200)
            response=await o.endpoint(SimpleNamespace(path='/healthz'))
            self.assertEqual(response.status,503)
            health=json.loads(response.text)
            self.assertFalse(health['healthy']);self.assertFalse(health['execution_enabled'])
            self.assertEqual(o.store.durable,[])
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
        self.assertTrue(o.store.closed)

    async def test_backoff_bounded_heartbeat_no_status_spam_and_recovery(self):
        o=self.o;o.store.allowed=False;waits=[];polls=[]
        original=o.store.capacity
        def capacity():polls.append(len(waits));return original()
        o.store.capacity=capacity
        async def tick(seconds):
            waits.append(seconds)
            self.assertLess(o.at()-o.heartbeat_ms,1000)
            if len(waits)==130:o.store.allowed=True
        with patch('service.asyncio.sleep',tick):await o.wait_capacity()
        self.assertTrue(all(t==1 for t in waits))
        self.assertLessEqual(max(b-a for a,b in zip(polls,polls[1:])),30)
        self.assertIsNone(o.capture_pause);self.assertFalse(o.connected)
        self.assertEqual([k for k,_ in o.store.events].count('capture_pressure_gap'),1)
        self.assertTrue(o.capture_gap['gap'])

    async def test_live_task_pressure_recovers_without_rebootstrap(self):
        o=self.o;o.bootstrap=AsyncMock();starts=Counter()
        async def ws():
            starts['ws']+=1
            if starts['ws']==1:raise OSError('CAPTURE_PAUSED_DATABASE_PRESSURE')
            await asyncio.sleep(100)
        async def worker():starts['worker']+=1;await asyncio.sleep(100)
        o.ws_loop=ws;o.aux_loop=worker;o.clock_loop=worker;o.maintenance=worker
        await o.run(duration=3.1)
        self.assertEqual(starts['ws'],2);self.assertEqual(starts['worker'],6)
        o.bootstrap.assert_awaited_once();self.assertEqual(o.task_errors,[])
        self.assertTrue(o.capture_gap['gap']);self.assertFalse(o.connected)

    async def test_healthy_recovery_requires_fresh_feed_and_preserves_accepted_tail(self):
        o=self.o;o.at=lambda:NOW;o.heartbeat_ms=NOW
        row={'p':'0.000000000123456789'}
        o.store.append('raw_trades','BTCUSDT',row,NOW-1)
        o.store.allowed=False
        async def recover(seconds):o.store.allowed=True
        with patch('service.asyncio.sleep',recover):await o.wait_capacity()
        self.assertEqual(o.store.buffers,[('raw_trades','BTCUSDT',row)])
        self.assertFalse(o.healthy(NOW))
        o.connected=True;o.subscription_ok=True;o.lags.append(1)
        o.clock_offset_ms=0;o.clock_uncertainty_ms=1
        for s in CONFIG['symbols']:
            o.last['publicTrade.'+s]=NOW;o.flow.books[s].valid=True;o.flow.books[s].receipt_ms=NOW
        self.assertTrue(o.healthy(NOW));self.assertTrue(o.capture_gap['gap'])
        o.store.flush();self.assertEqual(o.store.durable,[('raw_trades','BTCUSDT',row)])

    async def test_unrelated_error_is_not_swallowed_as_pressure(self):
        o=self.o;o.bootstrap=AsyncMock()
        async def pressure():raise OSError('CAPTURE_PAUSED_DATABASE_PRESSURE')
        async def corruption():raise RuntimeError('capture partition hash mismatch')
        async def worker():await asyncio.sleep(100)
        o.ws_loop=pressure;o.aux_loop=corruption;o.clock_loop=worker;o.maintenance=worker
        with self.assertRaisesRegex(RuntimeError,'capture task terminated'):await o.run(duration=.1)
        self.assertEqual(o.task_errors,['RuntimeError']);self.assertIsNone(o.capture_pause)

    async def test_bootstrap_pressure_retains_page_then_durable_restart_reuses_it(self):
        o=self.o;o.config={**CONFIG,'symbols':['BTCUSDT']};o.at=lambda:NOW
        calls=[];pressured=False
        async def get(path,params):
            calls.append(params)
            low=int(params['start']);high=int(params['end'])//60000*60000
            rows=[[str(t),'100','102','98','101','1.000','100.000'] for t in range(high,low-1,-60000)]
            self.assertLessEqual(len(rows),1000)
            return {'result':{'list':rows}},NOW
        original=o.store.append
        def append(*args):
            nonlocal pressured
            if not pressured:pressured=True;o.store.allowed=False
            return original(*args)
        async def recover(seconds):o.store.allowed=True
        o.public_get=get;o.store.append=append
        with patch('service.asyncio.sleep',recover):await o.bootstrap()
        self.assertEqual(len(calls),6);self.assertEqual(len(o.store.durable),6)
        self.assertEqual(len(o.base.minutes['BTCUSDT']),6000)
        original_rows=dict(o.base.minutes['BTCUSDT'])
        o.base.minutes['BTCUSDT'].clear()
        with patch('service.asyncio.sleep',AsyncMock()):await o.bootstrap()
        self.assertEqual(len(calls),6);self.assertEqual(len(o.store.durable),6)
        self.assertEqual(o.base.minutes['BTCUSDT'],original_rows)

    async def test_bootstrap_partial_restart_only_fetches_missing_and_preserves_live(self):
        o=self.o;o.config={**CONFIG,'symbols':['BTCUSDT']};o.at=lambda:NOW
        end=NOW-60000;start=end-5999*60000
        rows=[[str(t),'1','2','0.5','1','1','1'] for t in range(start,start+1000*60000,60000)]
        o.store.durable=[('bootstrap_ohlc','BTCUSDT',{'payload':{'result':{'list':rows}},'receipt_ms':NOW-1})]
        live={'timestamp_ms':end,'close_raw':'77','cohort':'prospective','receipt_ms':NOW}
        o.base.minutes['BTCUSDT'][end]=live
        calls=[]
        async def get(path,params):
            calls.append(params);low=int(params['start']);high=int(params['end'])//60000*60000
            return {'result':{'list':[[str(t),'1','2','0.5','1','1','1'] for t in range(low,high+1,60000)]}},NOW
        o.public_get=get
        with patch('service.asyncio.sleep',AsyncMock()):await o.bootstrap()
        self.assertEqual(len(calls),5)
        self.assertEqual(sum(int(c['limit']) for c in calls),4999)
        self.assertIs(o.base.minutes['BTCUSDT'][end],live)
        self.assertEqual(len(o.base.minutes['BTCUSDT']),6000)


class Cursor:
    def __init__(self,sha=None,total=1):self.sha=sha;self.total=total;self.itersize=None;self.fetched=0
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def execute(self,sql,args):self.sql=sql;self.args=args
    def __iter__(self):
        for i in range(self.total):
            payload=gzip.compress((json.dumps({'i':i,'p':'0.000000000123456789'})+'\n').encode())
            self.fetched+=1;yield self.sha or hashlib.sha256(payload).hexdigest(),payload


class Connection:
    def __init__(self,cursor):self.rows=cursor
    @contextmanager
    def transaction(self):yield
    def cursor(self,name):self.name=name;return self.rows


class StorageTests(unittest.TestCase):
    def test_server_cursor_is_lazy_and_memory_does_not_scale_with_total_rows(self):
        rows=Cursor(total=20000);s=PgStore.__new__(PgStore);s.connection=Connection(rows)
        iterator=s.restored_minutes(123)
        tracemalloc.start()
        first=next(iterator);self.assertEqual(rows.fetched,1)
        self.assertEqual(rows.itersize,1);self.assertEqual(first['p'],'0.000000000123456789')
        for rec in iterator:pass
        _,peak=tracemalloc.get_traced_memory();tracemalloc.stop()
        self.assertLess(peak,2*1024**2)
        self.assertEqual(rows.args,['live_ohlc',123])

    def test_corrupt_durable_chunk_is_rejected(self):
        s=PgStore.__new__(PgStore);s.connection=Connection(Cursor(sha='bad'))
        with self.assertRaisesRegex(RuntimeError,'hash mismatch'):next(s.restored_minutes(0))

    def test_capacity_boundary_remains_strict_and_rejected_row_is_not_buffered(self):
        s=PgStore.__new__(PgStore);s.capacity_at=10**20;s.write_errors=0;s.buffers={}
        for size,allowed in [(3*1024**3-1,True),(3*1024**3,False),(3*1024**3+1,False)]:
            s.database_bytes=size;self.assertEqual(s.capacity()['allowed'],allowed)
        with self.assertRaisesRegex(OSError,'CAPTURE_PAUSED_DATABASE_PRESSURE'):s.append('s','BTCUSDT',{'p':'1'},1)
        self.assertEqual(s.buffers,{})

    def test_only_explicit_pressure_errors_are_recoverable(self):
        self.assertTrue(Observer.is_capacity_pressure(OSError('CAPTURE_PAUSED_DATABASE_PRESSURE')))
        self.assertFalse(Observer.is_capacity_pressure(OSError('durable database chunk write failed')))
        self.assertFalse(Observer.is_capacity_pressure(RuntimeError('CAPTURE_PAUSED_DATABASE_PRESSURE')))


if __name__=='__main__':unittest.main(verbosity=2)
