"""Public-only Bybit observer; isolated image contains no trading application."""
import asyncio, os, json, time, uuid, random, sqlite3, signal, re, gzip
from pathlib import Path
from collections import Counter,deque
import aiohttp
from aiohttp import web
import websockets
from storage import Store,packed,digest,utc
from flow import Flow
from base import Base

ROOT=Path(__file__).resolve().parent
REST='https://api.bybit.com'
WS='wss://stream.bybit.com/v5/public/linear'
PUBLIC_GETS=frozenset(['/v5/market/kline','/v5/market/open-interest','/v5/market/account-ratio',
 '/v5/market/premium-index-price-kline','/v5/market/funding/history','/v5/market/time'])

def enforce(config):
    if os.environ.get('EXECUTION_ENABLED','false').lower()!='false' or os.environ.get('SHADOW_ONLY','true').lower()!='true':
        raise RuntimeError('execution is prohibited in this image')
    if config['execution_enabled'] is not False or config['shadow_only'] is not True:raise RuntimeError('shadow config required')
    if config['public_ws']!=WS or config['public_rest']!=REST:raise RuntimeError('public endpoint allowlist mismatch')
    if config['symbols']!=['BTCUSDT','ETHUSDT','SOLUSDT'] or config['depth']!=50:raise RuntimeError('frozen universe mismatch')

class Observer:
    def __init__(self,config,folder):
        enforce(config);self.config=config;self.started_ms=int(time.time()*1000);self.stopping=False
        self.mode=os.environ.get('DEPLOYMENT_ENV','qualification')
        self.sha=os.environ.get('GIT_COMMIT','');self.deployment=os.environ.get('SHADOW_DEPLOYMENT_ID','qualification-only')
        storage_kind=os.environ.get('SHADOW_STORAGE','filesystem')
        if self.mode=='northflank':
            if not re.fullmatch('[0-9a-f]{40}',self.sha) or self.deployment=='qualification-only':raise RuntimeError('deployment provenance required')
            if storage_kind!='postgres' and (os.environ.get('STORAGE_PERSISTENT')!='true' or not os.path.ismount(folder)):raise RuntimeError('dedicated persistent storage required')
        if storage_kind=='postgres':
            from pg_storage import PgStore
            self.store=PgStore(folder,config)
        else:self.store=Store(folder,config)
        self.base=Base(ROOT,config);self.flow=Flow(config['symbols'])
        self.counters=Counter();self.last={};self.lags=deque(maxlen=10000);self.connected=False;self.subscription_ok=False
        self.healthy_since=None;self.clock_offset_ms=None;self.clock_uncertainty_ms=None;self.pending=None
        self.boundary=self.store.boundary();self.store.export_boundary()
        if self.boundary and (self.boundary['config_hash']!=digest(config) or self.boundary['model_lock_hash']!=digest(self.base.lock) or self.boundary['git_commit_sha']!=self.sha):
            raise RuntimeError('prospective boundary belongs to a different lock/config/build; use a new evidence root')
        self.restore_minutes()
        self.first_live_event_ms=None;self.heartbeat_ms=self.started_ms;self.last_snapshot={};self.task_errors=[]
        self.store.status('service_start',{'mode':self.mode,'git_commit_sha':self.sha,'deployment_id':self.deployment,'execution_enabled':False})

    def restore_minutes(self):
        # Restore actual prospective provenance before adding bootstrap warmup bars.
        if hasattr(self.store,'restored_minutes'):
            for rec in self.store.restored_minutes(self.at()-7*86400000):self.restore_minute_record(rec)
            return
        folder=self.store.root/'live_ohlc'
        if not folder.exists():return
        cutoff=self.at()-7*86400000
        for p in sorted(folder.rglob('*.jsonl.gz')):
            date=p.parents[1].name
            if date<utc(cutoff)[:10]:continue
            with gzip.open(p,'rt',encoding='utf8') as f:
                for line in f:
                    rec=json.loads(line)
                    if int(rec['payload']['start'])>=cutoff:self.restore_minute_record(rec)

    def restore_minute_record(self,rec):
        d=rec['payload'];s=rec['symbol'];t=int(d['start']);at=rec['receipt_ms']
        row={'timestamp_ms':t,'open':float(d['open']),'high':float(d['high']),'low':float(d['low']),
          'close':float(d['close']),'open_raw':d['open'],'high_raw':d['high'],'low_raw':d['low'],'close_raw':d['close'],
          'volume_base':float(d['volume']),'turnover_quote':float(d['turnover']),'receipt_ms':at,'cohort':self.cohort(t,at)}
        self.base.minute(s,row)

    def at(self):return int(time.time()*1000)
    def cohort(self,exchange_ms,receipt_ms):
        if self.mode!='northflank':return 'qualification_only'
        start=self.boundary['prospective_start_ms'] if self.boundary else None
        return 'prospective' if start is not None and receipt_ms>=start and exchange_ms>=start else 'historical_bootstrap'

    async def public_get(self,path,params):
        if path not in PUBLIC_GETS:raise RuntimeError('private/unknown path prohibited')
        async with self.http.get(REST+path,params=params,allow_redirects=False) as r:
            r.raise_for_status();body=await r.json();at=self.at()
            if body.get('retCode')!=0:raise RuntimeError('public_feed_response_error '+str(body.get('retCode')))
            self.counters['public_gets']+=1;return body,at

    def raw(self,stream,symbol,message,at,ex):
        rec={'schema_version':self.config['schema_version'],'source':'bybit','market':'linear','stream':stream,'symbol':symbol,
          'exchange_ms':ex,'receipt_ms':at,'receipt_monotonic_ns':time.monotonic_ns(),'connection_id':self.flow.epoch,
          'cohort':self.cohort(ex,at),'payload':message,'payload_hash':digest(message),'clock_offset_ms':self.clock_offset_ms,
          'clock_uncertainty_ms':self.clock_uncertainty_ms,'exchange_completeness':'not_proven'}
        self.store.append(stream,symbol,rec,at)

    async def bootstrap(self):
        # OHLC is indicator warmup only. No REST public-trades or book history is fetched.
        for s in self.config['symbols']:
            end=self.at()//60000*60000-1;allrows=[]
            for _ in range(6):
                body,at=await self.public_get('/v5/market/kline',{'category':'linear','symbol':s,'interval':'1','limit':'1000','end':str(end)})
                rows=body['result']['list']
                if not rows:break
                self.raw('bootstrap_ohlc',s,body,at,0);allrows.extend(rows);end=min(int(r[0]) for r in rows)-1
                await asyncio.sleep(.15)
            for r in sorted(allrows,key=lambda r:int(r[0])):
                t=int(r[0]);row={'timestamp_ms':t,'open':float(r[1]),'high':float(r[2]),'low':float(r[3]),'close':float(r[4]),
                  'open_raw':r[1],'high_raw':r[2],'low_raw':r[3],'close_raw':r[4],'volume_base':float(r[5]),'turnover_quote':float(r[6]),
                  'receipt_ms':at,'cohort':'historical_bootstrap'}
                if t+60000<=at:self.base.minute(s,row)
            self.counters['bootstrap_minutes']+=len(allrows)

    async def ws_loop(self):
        delay=1
        topics=[t for s in self.config['symbols'] for t in ['publicTrade.'+s,'orderbook.50.'+s,'allLiquidation.'+s,'kline.1.'+s]]
        while not self.stopping:
            try:
                async with websockets.connect(WS,max_queue=256,max_size=4*1024*1024,ping_interval=20,ping_timeout=20,close_timeout=5) as ws:
                    self.flow.reconnect(self.at());self.connected=True;self.subscription_ok=False
                    self.store.status('connection_open',{'connection_id':self.flow.epoch,'gap':True})
                    await ws.send(packed({'op':'subscribe','args':topics}));delay=1
                    last_ping=self.at()
                    while not self.stopping:
                        try:data=await asyncio.wait_for(ws.recv(),timeout=10)
                        except asyncio.TimeoutError:
                            if self.at()-last_ping>20000:
                                await ws.send(packed({'op':'ping'}));last_ping=self.at()
                            if self.last and self.at()-max(self.last.values())>30000:raise RuntimeError('feed_silence')
                            continue
                        at=self.at()
                        try:
                            msg=json.loads(data)
                            if msg.get('op')=='subscribe':
                                self.subscription_ok=msg.get('success') is True
                                if not self.subscription_ok:raise RuntimeError('public_subscription_rejected')
                                continue
                            if 'topic' not in msg:continue
                            symbol=msg['topic'].split('.')[-1]
                            if symbol not in self.config['symbols']:raise ValueError('unfrozen_symbol')
                            ex=int(msg['ts']);lag=at-ex;self.lags.append(lag)
                            if lag<-1000 or lag>60000:self.counters['implausible_latency']+=1
                            self.last[msg['topic']]=at;self.counters['messages']+=1
                            if msg['topic'].startswith('publicTrade.'):
                                self.raw('raw_trades',symbol,msg,at,ex)
                                for d in msg['data']:
                                    if d['s']!=symbol:raise ValueError('trade_symbol_mismatch')
                                    self.flow.trade(d,at);self.counters['public_trades']+=1
                                    if self.first_live_event_ms is None and int(d['T'])<=at:self.first_live_event_ms=int(d['T'])
                            elif msg['topic'].startswith('orderbook.'):
                                self.flow.books[symbol].apply(msg,at);self.counters['book_messages']+=1
                            elif msg['topic'].startswith('allLiquidation.'):
                                self.raw('raw_liquidations',symbol,msg,at,ex);self.counters['liquidations']+=len(msg['data'])
                            elif msg['topic'].startswith('kline.'):
                                for d in msg['data']:
                                    if d.get('confirm') is not True:continue
                                    t=int(d['start']);row={'timestamp_ms':t,'open':float(d['open']),'high':float(d['high']),
                                      'low':float(d['low']),'close':float(d['close']),'open_raw':d['open'],'high_raw':d['high'],
                                      'low_raw':d['low'],'close_raw':d['close'],'volume_base':float(d['volume']),
                                      'turnover_quote':float(d['turnover']),'receipt_ms':at,'cohort':self.cohort(t,at)}
                                    self.raw('live_ohlc',symbol,d,at,int(d['timestamp']));self.base.minute(symbol,row)
                                    self.counters['live_minutes']+=1
                        except (ValueError,KeyError,TypeError):
                            self.counters['malformed']+=1;raise RuntimeError('malformed_message_resync')
            except (OSError,RuntimeError,websockets.exceptions.WebSocketException,asyncio.TimeoutError) as error:
                self.connected=False;self.subscription_ok=False;self.healthy_since=None;self.counters['reconnects']+=1
                self.store.status('feed_gap',{'reason':type(error).__name__,'message':str(error)[:120],'connection_id':self.flow.epoch,'gap':True})
                self.flow.reconnect(self.at());self.last.clear()
                if not self.store.capacity()['allowed']:self.stopping=True;raise
                await asyncio.sleep(delay+random.random());delay=min(60,delay*2)

    async def aux_loop(self):
        while not self.stopping:
            for s in self.config['symbols']:
                for stream,path,params in [
                  ('oi_5m','/v5/market/open-interest',{'category':'linear','symbol':s,'intervalTime':'5min','limit':'1'}),
                  ('long_short_5m','/v5/market/account-ratio',{'category':'linear','symbol':s,'period':'5min','limit':'1'}),
                  ('premium_1m','/v5/market/premium-index-price-kline',{'category':'linear','symbol':s,'interval':'1','limit':'1','end':str(self.at()//60000*60000-1)}),
                  ('funding','/v5/market/funding/history',{'category':'linear','symbol':s,'limit':'1'})]:
                    try:
                        body,at=await self.public_get(path,params);rows=body['result']['list']
                        for d in rows:
                            if stream=='oi_5m':row={'timestamp_ms':int(d['timestamp']),'open_interest':float(d['openInterest']),'open_interest_raw':d['openInterest']}
                            elif stream=='long_short_5m':row={'timestamp_ms':int(d['timestamp']),'buy_ratio_raw':d['buyRatio'],'sell_ratio_raw':d['sellRatio']}
                            elif stream=='premium_1m':row={'timestamp_ms':int(d[0]),'close':float(d[4])}
                            else:row={'timestamp_ms':int(d['fundingRateTimestamp']),'funding_rate':float(d['fundingRate'])}
                            row['receipt_ms']=at;self.raw('aux_'+stream,s,d,at,row['timestamp_ms']);self.base.aux.add(s,stream,row)
                        self.counters['aux_success']+=1
                    except (aiohttp.ClientError,asyncio.TimeoutError,RuntimeError,KeyError,ValueError):self.counters['aux_errors']+=1
                    await asyncio.sleep(.15)
            await asyncio.sleep(45)

    async def clock_loop(self):
        while not self.stopping:
            before=self.at()
            try:
                body,after=await self.public_get('/v5/market/time',{})
                server=int(body['result']['timeNano'])//1000000
                self.clock_offset_ms=server-(before+after)/2;self.clock_uncertainty_ms=(after-before)/2
            except (aiohttp.ClientError,RuntimeError,asyncio.TimeoutError,KeyError,ValueError):self.counters['clock_errors']+=1
            await asyncio.sleep(30)

    def healthy(self,at):
        freshness=all(at-self.last.get('publicTrade.'+s,0)<30000 and self.flow.books[s].valid and
           at-self.flow.books[s].receipt_ms<10000 for s in self.config['symbols'])
        ordered_clocks=bool(self.lags) and all(lag>=0 for lag in list(self.lags)[-100:])
        return self.connected and self.subscription_ok and freshness and ordered_clocks and self.store.capacity()['allowed'] and not self.task_errors and \
          self.clock_offset_ms is not None and abs(self.clock_offset_ms)<1000 and self.clock_uncertainty_ms<2000

    async def maintenance(self):
        last_rollup={};last_predict=0
        while not self.stopping:
            at=self.at();self.heartbeat_ms=at
            if hasattr(self.store,'flush'):self.store.flush()
            if self.healthy(at):
                if self.healthy_since is None:self.healthy_since=at
                if self.boundary is None and self.mode=='northflank' and at-self.healthy_since>=self.config['healthy_seconds_before_boundary']*1000:
                    boundary={'prospective_start_at':utc(at),'prospective_start_ms':at,'git_commit_sha':self.sha,
                      'model_spec_hashes':self.base.lock['files'],'model_lock_hash':digest(self.base.lock),'config_hash':digest(self.config),
                      'schema_version':self.config['schema_version'],'deployment_id':self.deployment,'service_start_at':utc(self.started_ms),
                      'first_valid_live_event_at':utc(self.first_live_event_ms),'symbols':self.config['symbols'],
                      'storage_root':str(self.store.root),'shadow_only':True,'execution_enabled':False}
                    self.store.set_boundary(boundary);self.boundary=boundary;self.store.status('prospective_start',boundary)
                    print(packed({'kind':'prospective_start',**boundary}),flush=True)
            else:self.healthy_since=None
            for s in self.config['symbols']:
                book=self.flow.books[s].summary(at);self.raw('depth_1s',s,book,at,book.get('exchange_ms',at))
                for sec in self.config['rollup_seconds']:
                    bucket=at//(sec*1000);key=(s,sec)
                    if last_rollup.get(key)==bucket:continue
                    last_rollup[key]=bucket;row=self.flow.rollup(s,at,sec,book)
                    row['cohort']=self.cohort(at-sec*1000,at);row['schema_version']=self.config['schema_version']
                    self.store.append('derived_'+str(sec)+'s',s,row,at);self.counters['derived_rows']+=1
            if at-last_predict>=10000:
                last_predict=at;start=self.boundary['prospective_start_ms'] if self.boundary else None
                self.base.update_drift(self.store.db,at)
                for s in self.config['symbols']:
                    records,snap=self.base.observations(s,at,start);self.last_snapshot[s]=snap
                    self.store.append('feature_pipeline_status',s,{**snap,'receipt_ms':at,'cohort':self.cohort(at,at)},at)
                    for row in records:
                        if self.mode!='northflank':row['cohort']='qualification_only'
                        if self.store.db.execute('SELECT 1 FROM predictions WHERE id=?',(row['observation_id'],)).fetchone():continue
                        # Old events can be diagnosed, but prospective issuance must be timely.
                        if at-row['event_clock_ms']>90000:continue
                        self.store.prediction(row);self.counters['predictions']+=1;self.counters['missing_features']+=len(row['missing_feature_mask'])
                pending=self.store.db.execute('SELECT p.record FROM predictions p LEFT JOIN labels l ON p.id=l.id WHERE l.id IS NULL').fetchall()
                for (record,) in pending:
                    row=json.loads(record)
                    label=self.base.mature_labels(row,at)
                    if label:self.store.label(row['observation_id'],label);self.counters['labels']+=1
                self.store.status('heartbeat',self.health(at))
                print(packed({'kind':'heartbeat',**self.health(at)}),flush=True)
                if hasattr(self.store,'audit') and self.counters.get('audit_logged',0)==0 and self.counters['public_trades']>100:
                    print(packed({'kind':'durable_audit',**self.store.audit()}),flush=True);self.counters['audit_logged']=1
            await asyncio.sleep(1)

    def health(self,at=None):
        at=at or self.at();lags=sorted(self.lags)
        return {'at':utc(at),'healthy':self.healthy(at),'uptime_seconds':(at-self.started_ms)/1000,'mode':self.mode,
          'execution_enabled':False,'shadow_only':True,'model_lock_verified':True,'git_commit_sha':self.sha,'deployment_id':self.deployment,
          'prospective_start_at':self.boundary['prospective_start_at'] if self.boundary else None,
          'healthy_seconds':(at-self.healthy_since)/1000 if self.healthy_since else 0,'counters':dict(self.counters),
          'freshness_ms':{s:{'trade_age':at-self.flow.last_trade[s],'book_age':at-self.flow.books[s].receipt_ms} for s in self.config['symbols']},
          'capture_lag_ms':{'p50':lags[len(lags)//2] if lags else None,'p95':lags[int(len(lags)*.95)] if lags else None,
          'negative_lag_count_window':sum(v<0 for v in lags),'sample_count':len(lags),
          'clock_adjusted_p50_estimate':lags[len(lags)//2]+self.clock_offset_ms if lags and self.clock_offset_ms is not None else None},
          'clock_offset_ms':self.clock_offset_ms,'clock_uncertainty_ms':self.clock_uncertainty_ms,'storage':self.store.capacity(),
          'write_errors':self.store.write_errors,'trade_duplicates':self.flow.duplicates,'sequence_regressions':self.flow.regressions,
          'feature_pipeline':self.last_snapshot,'task_errors':self.task_errors,'heartbeat_age_ms':at-self.heartbeat_ms}

    async def endpoint(self,request):
        if request.path=='/healthz':return web.json_response(self.health(),status=200 if self.healthy(self.at()) else 503)
        if request.path=='/livez':return web.json_response({'alive':self.at()-self.heartbeat_ms<30000},status=200 if self.at()-self.heartbeat_ms<30000 else 503)
        return web.json_response({'shadow_only':True,'execution_enabled':False})

    async def run(self,duration=None):
        app=web.Application();app.router.add_get('/healthz',self.endpoint);app.router.add_get('/livez',self.endpoint)
        runner=web.AppRunner(app);await runner.setup();await web.TCPSite(runner,'0.0.0.0',int(os.environ.get('PORT','8080'))).start()
        self.http=aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20),headers={'User-Agent':'OrayanShadow/1'},trust_env=False)
        tasks=[]
        try:
            await self.bootstrap()
            tasks=[asyncio.create_task(f()) for f in [self.ws_loop,self.aux_loop,self.clock_loop,self.maintenance]]
            deadline=time.monotonic()+duration if duration else None
            while not self.stopping:
                for task in tasks:
                    if task.done():
                        error=task.exception();self.task_errors.append(type(error).__name__ if error else 'unexpected_task_exit')
                        self.store.status('fatal_task',{'error':str(error)[:160]});raise RuntimeError('capture task terminated')
                if deadline and time.monotonic()>=deadline:break
                await asyncio.sleep(1)
        finally:
            self.stopping=True
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            (self.store.root/'final_health.json').write_text(packed(self.health())+'\n',encoding='utf8')
            await self.http.close();await runner.cleanup();self.store.close()

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--duration',type=int);parser.add_argument('--data',default=os.environ.get('DATA_ROOT','/capture'))
    args=parser.parse_args();config=json.loads((ROOT/'config.json').read_text());observer=Observer(config,args.data)
    asyncio.run(observer.run(args.duration))
