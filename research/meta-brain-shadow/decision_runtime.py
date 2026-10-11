"""Decision-first shadow runtime: public OHLC/aux rings and canonical episodes.

No trades/depth subscription, no raw exhaust writer, no trading application import.
Frozen risk estimates are unchanged; structural direction is a registered experiment.
"""
import asyncio,base64,copy,gzip,hashlib,hmac,io,json,os,re,tempfile,time,zipfile
from pathlib import Path
import aiohttp,websockets
from aiohttp import web
from decision_store import CompactStore,SCHEMA,WINDOW,boundaries,day,digest,packed
from decision_learning import EpisodeConsumer
from orayan_feed import URL as ORAYAN_URL,ingest_export_async
from structural_policy import DEFINITION as STRUCTURE_DEFINITION,context_from_base,decide_structure,mature_structure
from research_memory import snapshot as memory_snapshot,trim_unused

ROOT=Path(__file__).resolve().parent
REST='https://api.bybit.com';WS='wss://stream.bybit.com/v5/public/linear'
PUBLIC_PATHS=frozenset(('/v5/market/kline','/v5/market/open-interest','/v5/market/account-ratio','/v5/market/premium-index-price-kline','/v5/market/funding/history','/v5/market/time'))

class DecisionRuntime:
    def __init__(self,store,policy):
        if os.environ.get('EXECUTION_ENABLED','false').lower()!='false' or os.environ.get('SHADOW_ONLY','true').lower()!='true':raise RuntimeError('Execution prohibited')
        self.store=store;self.policy=policy;self.started=policy['epoch_started_ms'];self.capture_enabled=policy.get('capture_enabled',False) and not store.state('capture_pause')
        self.feed_enabled=policy.get('orayan_feed_enabled',False);self.last_feed=None;self.errors=[];self.snapshots={};self.last_minute={};self.connected=False
        self.symbols=['BTCUSDT'];self.last_interest={};self.active_limit=4;self.last_checkpoint=0;self.last_eval={};self.last_integrity={};self.last_clock=None
        from base import Base
        config=json.loads((ROOT/'config.json').read_text());config['symbols']=self.symbols
        self.base=Base(ROOT,config);self.consumer=EpisodeConsumer(store,self.decide)
        self.lineage={'schema':SCHEMA,'epoch':store.epoch,'policy':policy,'model_lock_sha256':hashlib.sha256((ROOT/'model_lock.json').read_bytes()).hexdigest(),
            'model_files':self.base.lock['files'],'runtime_files':{n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in
                ('decision_runtime.py','decision_store.py','decision_learning.py','orayan_feed.py','structural_policy.py','base.py','frozen_features.py','frozen_detector.py','frozen_indicators.py')},
            'build_revision_environment':os.environ.get('RESEARCH_REVISION'),'source_commit':policy.get('deployment_source_commit','QUALIFICATION_ONLY'),
            'providers':{'independent_market':{'name':'Bybit','rest':REST,'websocket':WS,'channels':['completed kline.1'],
                'auxiliary':['open interest','long/short account ratio','premium','funding'],'raw_tick_depth_persistence':False},
                'orayan':{'url':ORAYAN_URL,'access':'authenticated read-only existing canonical export; filtered episode evidence'}},
            'adaptation':'durable bounded performance statistics; no online model changes','execution_enabled':False}
        with store.transaction():
            prior=store.state('lineage')
            if prior and prior!=self.lineage:
                amendment=store.state('deployment_amendment') or {}
                if amendment.get('new_source_commit')!=policy.get('deployment_source_commit') or amendment.get('previous_lineage_sha256')!=digest(prior):
                    raise RuntimeError('New config/build requires explicit epoch migration')
            store.set_state('lineage',self.lineage)
            store.set_state('epoch',{'id':store.epoch,'schema':SCHEMA,'started_ms':self.started})
            self.definition_id=store.epoch+':definitions:'+digest(self.lineage)[:16]
            definition_at=self.now()
            store.add('definitions',self.definition_id,None,definition_at,definition_at,self.lineage)
            store.add('registered_experiment',store.epoch+':structure-definition',None,self.started,self.started,STRUCTURE_DEFINITION)
        checkpoint=store.state('working_checkpoint')
        if checkpoint and self.now()-checkpoint['at']<WINDOW:
            state=json.loads(gzip.decompress(base64.b64decode(checkpoint['gzip_json'])))
            for symbol,rows in state['minutes'].items():
                self.base.minutes.setdefault(symbol,{})
                if symbol not in self.symbols:self.symbols.append(symbol)
                for row in rows:self.base.minute(symbol,row)
            for symbol,stream,rows in state['aux']:
                for row in rows:self.base.aux.add(symbol,stream,row)
        self.note('restart_gap',{'since_ms':checkpoint.get('at') if checkpoint else self.started,'until_ms':self.now(),'continuity_not_assumed':True})
        trim_unused()

    @staticmethod
    def now():return int(time.time()*1000)
    def pause(self,reason):
        self.capture_enabled=False;self.errors=[reason]
        with self.store.transaction():self.store.set_state('capture_pause',{'reason':reason,'observed_ms':self.now()})
    def resume(self,request):
        receipt=self.store.state('destructive_reset_receipt')
        if request.get('epoch')!=self.store.epoch or request.get('preflight_sha256')!=receipt['boot']['preflight_sha256']:
            raise ValueError('Controlled preflight/epoch mismatch')
        with self.store.transaction():
            self.store.retire_archives(self.now());self.store.set_state('capture_pause',None)
            self.store.add('integrity',self.store.epoch+':capture-resume:'+str(self.now()),None,self.now(),self.now(),
                {'kind':'CONTROLLED_SHADOW_CAPTURE_RESUME','historical_archive_inventory_sha256':receipt['archive_inventory_sha256'],
                 'preflight_sha256':request['preflight_sha256'],'execution_enabled':False})
        self.errors=[];self.capture_enabled=self.policy.get('capture_enabled',False)
        return {'resumed':self.capture_enabled,'epoch':self.store.epoch,'execution_enabled':False}
    def note(self,kind,details):
        at=self.now();hour=at//3600000
        group=kind+':'+digest({k:details.get(k) for k in ('symbol','stream')})[:12]
        if self.last_integrity.get(group)==hour:return
        key=self.store.epoch+':'+group+':'+str(hour)
        if not self.store.get_event(key):
            with self.store.transaction():self.store.add('integrity',key,None,at,at,{'kind':kind,**details,
                'diagnostic_aggregation':'one record per kind/symbol/stream/hour; exact availability clocks retained in decisions'})
        self.last_integrity[group]=hour
    async def get(self,path,params):
        if path not in PUBLIC_PATHS:raise RuntimeError('Private/unknown market endpoint prohibited')
        async with self.http.get(REST+path,params=params,allow_redirects=False) as r:
            r.raise_for_status();data=await r.json();at=self.now()
            if data.get('retCode')!=0:raise RuntimeError('Public market response error')
            return data,at
    async def bootstrap_symbol(self,symbol):
        end=self.now()//60000*60000-60000
        for offset in range(0,6000,1000):
            upper=end-offset*60000;lower=upper-999*60000
            body,at=await self.get('/v5/market/kline',{'category':'linear','symbol':symbol,'interval':'1','limit':'1000','start':str(lower),'end':str(upper+59999)})
            for r in sorted(body['result']['list'],key=lambda r:int(r[0])):
                t=int(r[0])
                if t+60000>at:continue
                self.base.minutes[symbol].setdefault(t,{'timestamp_ms':t,'open':float(r[1]),'high':float(r[2]),'low':float(r[3]),'close':float(r[4]),
                    'open_raw':r[1],'high_raw':r[2],'low_raw':r[3],'close_raw':r[4],'volume_base':float(r[5]),'turnover_quote':float(r[6]),
                    'receipt_ms':at,'cohort':'historical_bootstrap'})
            await asyncio.sleep(.1)
        self.base.minutes[symbol]=dict(sorted(self.base.minutes[symbol].items())[-7500:])
    async def market_loop(self):
        while True:
            try:
                # Only completed OHLC is needed by the frozen model. Tick/depth
                # exhaust is neither subscribed nor archived in this release.
                async with websockets.connect(WS,max_size=1024*1024,ping_interval=20,ping_timeout=20) as ws:
                    subscribed=set()
                    while True:
                        for symbol in self.symbols:
                            if symbol not in subscribed:
                                await ws.send(packed({'op':'subscribe','args':['kline.1.'+symbol]}));subscribed.add(symbol)
                        for symbol in list(subscribed-set(self.symbols)):
                            await ws.send(packed({'op':'unsubscribe','args':['kline.1.'+symbol]}));subscribed.remove(symbol)
                        self.connected=True
                        try:message=json.loads(await asyncio.wait_for(ws.recv(),timeout=10))
                        except asyncio.TimeoutError:continue
                        if not str(message.get('topic','')).startswith('kline.1.'):continue
                        symbol=message['topic'].split('.')[-1];at=self.now()
                        if symbol not in self.symbols:continue
                        for d in message.get('data',[]):
                            if d.get('confirm') is not True:continue
                            t=int(d['start'])
                            if t+60000>at:raise ValueError('Future/partial completed bar')
                            self.base.minute(symbol,{'timestamp_ms':t,'open':float(d['open']),'high':float(d['high']),'low':float(d['low']),'close':float(d['close']),
                                'open_raw':d['open'],'high_raw':d['high'],'low_raw':d['low'],'close_raw':d['close'],
                                'volume_base':float(d['volume']),'turnover_quote':float(d['turnover']),'receipt_ms':at,'cohort':'prospective'})
                            self.last_minute[symbol]=at
            except (OSError,ValueError,KeyError,asyncio.TimeoutError,websockets.exceptions.WebSocketException):
                self.connected=False;self.note('market_feed_gap',{'fresh_inputs_required':True});await asyncio.sleep(10)

    async def aux_loop(self):
        while True:
            for s in list(self.symbols):
                for stream,path,params in (
                    ('oi_5m','/v5/market/open-interest',{'category':'linear','symbol':s,'intervalTime':'5min','limit':'200'}),
                    ('long_short_5m','/v5/market/account-ratio',{'category':'linear','symbol':s,'period':'5min','limit':'288'}),
                    ('premium_1m','/v5/market/premium-index-price-kline',{'category':'linear','symbol':s,'interval':'1','limit':'1000','end':str(self.now()//60000*60000-1)}),
                    ('funding','/v5/market/funding/history',{'category':'linear','symbol':s,'limit':'4'})):
                    try:
                        key=(s,stream);warm=bool(self.base.aux.rows.get(key))
                        if warm:params={**params,'limit':'1'}
                        data,at=await self.get(path,params)
                        pages=[(data,at)]
                        if not warm and stream=='oi_5m' and data['result'].get('nextPageCursor'):
                            pages.append(await self.get(path,{**params,'limit':'200','cursor':data['result']['nextPageCursor']}))
                        if not warm and stream=='premium_1m' and data['result']['list']:
                            before=min(int(d[0]) for d in data['result']['list'])-1
                            pages.append(await self.get(path,{**params,'limit':'600','end':str(before)}))
                        for page,received in pages:
                            for d in page['result']['list']:
                                if stream=='oi_5m':row={'timestamp_ms':int(d['timestamp']),'open_interest':float(d['openInterest']),'open_interest_raw':d['openInterest']}
                                elif stream=='long_short_5m':row={'timestamp_ms':int(d['timestamp']),'buy_ratio_raw':d['buyRatio'],'sell_ratio_raw':d['sellRatio']}
                                elif stream=='premium_1m':row={'timestamp_ms':int(d[0]),'close':float(d[4])}
                                else:row={'timestamp_ms':int(d['fundingRateTimestamp']),'funding_rate':float(d['fundingRate'])}
                                row['receipt_ms']=received;self.base.aux.add(s,stream,row)
                        self.base.aux.rows[key]={t:r for t,r in self.base.aux.rows.get(key,{}).items() if t>=at-WINDOW}
                    except (aiohttp.ClientError,RuntimeError,KeyError,ValueError,asyncio.TimeoutError):self.note('auxiliary_input_gap',{'symbol':s,'stream':stream})
                    await asyncio.sleep(.2)
            before=self.now()
            try:
                data,after=await self.get('/v5/market/time',{});server=int(data['result']['timeNano'])//1000000
                self.last_clock={'offset_ms':server-(before+after)/2,'uncertainty_ms':(after-before)/2,'observed_ms':after}
            except (aiohttp.ClientError,RuntimeError,KeyError,ValueError,asyncio.TimeoutError):self.note('clock_input_gap',{})
            await asyncio.sleep(60)

    def decide(self,symbol,at):
        cached=self.snapshots.get(symbol)
        base={'decision_ms':at,'action':'ABSTAIN','confidence':None,'abstention_reason':'DIRECTIONAL_POLICY_UNCONFIGURED',
            'model_version':'phase3a-fold3-frozen','model_lock_sha256':self.lineage['model_lock_sha256'],
            'model_definition_id':self.definition_id,'no_trade':True,'orayan_inputs_used':False}
        clock_ok=bool(self.last_clock and at-self.last_clock['observed_ms']<180000 and
                      abs(self.last_clock['offset_ms'])+self.last_clock['uncertainty_ms']<2000)
        if not clock_ok or not cached or at-cached['at']>90000 or at-self.last_minute.get(symbol,0)>120000:
            return {**base,'abstention_reason':'MISSING_OR_STALE_INDEPENDENT_INPUTS','features':{},'feature_snapshot_hash':digest({}),
                    'max_input_receipt_ms':at,'input_integrity':{'fresh':False,'symbol_warmup_or_outside_bounded_universe':True,
                        'clock_valid':clock_ok,'clock':self.last_clock}}
        record=copy.deepcopy(cached.get('prediction'));state=copy.deepcopy(cached['state'])
        features=record['feature_snapshot'] if record else state.get('live_feature_snapshot',{})
        structure=decide_structure(cached['structure'],at,True)
        feature_receipt=record['feature_max_receipt_ms'] if record else state.get('latest_minute_receipt_ms',cached['at'])
        return {**base,**structure,'features':features,'feature_snapshot_hash':digest(features),
            'max_input_receipt_ms':max(feature_receipt,cached['structure'].get('max_input_receipt_ms',feature_receipt)),
            'availability_clocks':record.get('feature_availability_audit') if record else {'state_observed_ms':cached['at']},
            'state':state,'independent_snapshot_created_ms':cached['at'],
            'frozen_estimates':{k:record[k] for k in ('head_A_prediction','head_B_probability','head_C_diagnostic','head_D')} if record else None,
            'input_integrity':{'fresh':True,'clock':self.last_clock,'last_live_minute_receipt_ms':self.last_minute.get(symbol),
                'missing_feature_mask':record.get('missing_feature_mask',[]) if record else [],'flow_used_by_base':False}}

    async def feed_loop(self):
        while True:
            try:
                memory=memory_snapshot()
                if memory and memory['headroom_bytes']<128*1024*1024:
                    self.note('orayan_intake_memory_gap',{'fresh_decisions_censored':True});await asyncio.sleep(120);continue
                # This endpoint creates only an export scratch file in Orayan;
                # inspection confirms no flush/prune/reset/config mutation path.
                with tempfile.TemporaryFile() as file:
                    headers={k:os.environ[v] for k,v in (('x-groq-shadow-export-token','ORAYAN_GROQ_EXPORT_TOKEN'),
                        ('x-alibaba-shadow-export-token','ORAYAN_ALIBABA_EXPORT_TOKEN')) if os.environ.get(v)}
                    async with self.http.get(ORAYAN_URL,headers=headers,allow_redirects=False,timeout=aiohttp.ClientTimeout(total=180)) as r:
                        r.raise_for_status();size=0
                        async for data in r.content.iter_chunked(65536):
                            size+=len(data)
                            if size>32*1024*1024:raise RuntimeError('ORAYAN_EXPORT_SIZE_BOUND')
                            file.write(data)
                    file.seek(0)
                    from orayan_feed import selected_events
                    manifest,rows=selected_events(file)
                    self.last_feed=await ingest_export_async(self.store,self.consumer,file,self.now(),validated=(manifest,rows),clock=self.now)
                    # Keep BTC as the anchor, prioritizing eligible native candidates.
                    # Outside this bounded universe, independent abstentions are
                    # retained with an explicit input-coverage reason.
                    candidates=sorted(rows,key=lambda r:(r.get('admission')!='ELIGIBLE',r.get('strategy')=='ORAYAN_V3',-r['sequence']))
                    for row in candidates:
                        s=row.get('symbol');at=row.get('capturedAt',0)
                        if row['kind'] not in ('candidate_birth','candidate_update') or not s or self.now()-at>90000:continue
                        self.last_interest[s]=self.now()
                        if s not in self.symbols and len(self.symbols)<self.active_limit and re.fullmatch('[A-Z0-9]{2,24}USDT',s):
                            self.symbols.append(s);self.base.minutes[s]={};await self.bootstrap_symbol(s)
            except (aiohttp.ClientError,ValueError,RuntimeError,zipfile.BadZipFile,KeyError,asyncio.TimeoutError) as error:
                self.note('orayan_feed_gap',{'reason':'READ_ONLY_CANONICAL_FEED_UNAVAILABLE_OR_INCOMPLETE',
                    'error_type':type(error).__name__,'diagnostic_code':str(error)[:160],'no_execution_authority':True})
            finally:
                # Do not retain yesterday's projection while constructing the next one.
                manifest=rows=candidates=None
                trim_unused()
            await asyncio.sleep(120)

    async def maintenance(self):
        while True:
            at=self.now()
            try:
                for s in list(self.symbols):
                    latest=max(self.base.minutes[s],default=0)
                    if self.last_eval.get(s)==latest:continue
                    self.last_eval[s]=latest
                    records,state=self.base.observations(s,at,self.started)
                    timely=[r for r in records if r['cohort']=='prospective' and 0<=at-r['event_clock_ms']<=90000]
                    self.snapshots[s]={'at':at,'state':state,'prediction':timely[-1] if timely else None,'structure':context_from_base(self.base,s,at)}
                    for row in timely:
                        key=self.store.epoch+':meta:'+row['observation_id']
                        with self.store.transaction():
                            if self.store.get_event(key):continue
                            decision=self.decide(s,at);decision['frozen_prediction']=row
                            self.store.add('meta_decision',key,key,row['event_clock_ms'],at,decision)
                            self.store.add('decision_comparison',key+':comparison',key,at,at,{'state':'independent-only','decision_id':key,'source_refs':[{'event_id':key}]})
                            self.store.set_pending('meta:'+key,{'model_row':row,'decision_id':key,'observed_ms':at})
                            if decision.get('action') in ('LONG','SHORT'):
                                self.store.set_pending('baseline:'+key,{'decision':decision,'decision_id':key,'symbol':s,'observed_ms':at,'bucket':'INDEPENDENT_ONLY'})
                for key,text in self.store.execute('SELECT episode_id,record FROM mb_pending WHERE episode_id LIKE ?',('meta:%',)).fetchall():
                    pending=json.loads(text);row=pending['model_row']
                    label=self.base.mature_labels(row,at) if row['symbol'] in self.base.minutes else {
                        'status':'CENSORED_INPUT_SOURCE_OUTSIDE_RECOVERY_WINDOW','observation_id':row['observation_id'],'written_at':at}
                    if not label:continue
                    with self.store.transaction():
                        if label.get('status')=='MATURED':
                            path=[self.base.minutes[row['symbol']][t] for t in range(row['reference_entry_ms'],row['reference_entry_ms']+60*60000,60000)]
                            label['path_summary']={'minute_count':len(path),'high':max(p['high'] for p in path),
                                'low':min(p['low'] for p in path),'terminal_close':path[-1]['close'],
                                'upward_excursion':max(p['high'] for p in path)-label['reference_entry_price'],
                                'downward_excursion':label['reference_entry_price']-min(p['low'] for p in path),
                                'directional_mae_mfe':'unassigned for the frozen two-sided risk model; structural outcomes are separate',
                                'path_disposition':'compacted after label maturation'}
                        self.store.add('lifecycle_outcome',pending['decision_id']+':label',pending['decision_id'],label.get('written_at',at),at,
                            {'label':label,'decision_id':pending['decision_id'],'source_refs':[{'event_id':pending['decision_id']}],'frozen_decision':self.store.get_event(pending['decision_id'])})
                        self.store.execute('DELETE FROM mb_pending WHERE episode_id=?',(key,))
                for key,text in self.store.execute('SELECT episode_id,record FROM mb_pending WHERE episode_id LIKE ?',('baseline:%',)).fetchall():
                    pending=json.loads(text);decision=pending['decision'];label=mature_structure(decision,self.base.minutes.get(pending['symbol'],{}),at)
                    if label is None:continue
                    with self.store.transaction():
                        outcome_id=pending['decision_id']+':structure-label'
                        self.store.add('lifecycle_outcome',outcome_id,pending['decision_id'],label['resolved_ms'],at,
                            {'independent_baseline_outcome':label,'decision_id':pending['decision_id'],'decision_snapshot':decision,
                             'source_refs':[{'event_id':pending['decision_id'],'owner_date':day(pending['observed_ms'])}]})
                        self.store.learn(outcome_id,'STRUCTURAL_BASELINE|'+pending['bucket'],label['resolved_ms'],at,label.get('realizedR'))
                        if label.get('loss_reason'):
                            self.store.add('loss_attribution',outcome_id+':loss',pending['decision_id'],label['resolved_ms'],at,
                                {'loss_reason':label['loss_reason'],'experimental_counterfactual':True,'source_refs':[{'event_id':outcome_id}]})
                        self.store.add('lesson',outcome_id+':lesson',pending['decision_id'],label['resolved_ms'],at,
                            {'experiment_id':STRUCTURE_DEFINITION['id'],'outcome_id':outcome_id,'weights_changed':False,
                             'correlated_candidates':'descriptive statistics; counts do not establish independent samples',
                             'source_refs':[{'event_id':outcome_id}]})
                        self.store.execute('DELETE FROM mb_pending WHERE episode_id=?',(key,))
                if at-self.last_checkpoint>=600000:
                    state={'minutes':{s:[r for r in self.base.minutes[s].values() if r['timestamp_ms']>=at-2*3600000] for s in self.symbols},
                           'aux':[[s,stream,list(rows.values())] for (s,stream),rows in self.base.aux.rows.items()]}
                    with self.store.transaction():self.store.set_state('working_checkpoint',{'at':at,'retention':'bounded restart/label working state','gzip_json':base64.b64encode(gzip.compress(packed(state).encode(),mtime=0)).decode()})
                    self.last_checkpoint=at
                today=day(at);last_day=(self.store.state('last_daily_archive') or {}).get('date')
                date=day(boundaries(last_day)[1]) if last_day else day(self.started)
                while date<today:
                    with self.store.transaction():
                        self.store.publish_day(date,at);self.store.set_state('last_daily_archive',{'date':date})
                    date=day(boundaries(date)[1])
                with self.store.transaction():self.store.compact_current(at);self.store.compact_pending(at);self.store.retire_archives(at)
                protected={json.loads(text).get('symbol',json.loads(text).get('model_row',{}).get('symbol')) for (text,) in self.store.execute('SELECT record FROM mb_pending')}
                for s in list(self.symbols):
                    if s!='BTCUSDT' and s not in protected and at-self.last_interest.get(s,self.started)>2*3600000:
                        self.symbols.remove(s);self.base.minutes.pop(s,None);self.snapshots.pop(s,None);self.last_eval.pop(s,None)
                        self.base.aux.rows={k:v for k,v in self.base.aux.rows.items() if k[0]!=s}
                trim_unused()
            except RuntimeError as error:
                self.pause(str(error))
                self.note('decision_capture_paused',{'reason':str(error),'accepted_evidence_preserved':True})
                raise
            await asyncio.sleep(20)

    def health(self):
        return {**self.store.status(),'capture_enabled':self.capture_enabled,'feed_enabled':self.feed_enabled,
                'capture_pause':self.store.state('capture_pause'),
                'orayan_feed':self.last_feed,'market_connected':self.connected,'working_symbols':self.symbols,
                'memory':memory_snapshot(),'errors':self.errors,'direction_policy':STRUCTURE_DEFINITION}

    async def run(self):
        self.http=aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30),trust_env=False)
        tasks=[]
        try:
            while True:
                if self.capture_enabled and not tasks:
                    try:
                        for s in list(self.symbols):await self.bootstrap_symbol(s)
                        tasks=[asyncio.create_task(f()) for f in (self.market_loop,self.aux_loop,self.maintenance)]
                        if self.feed_enabled:tasks.append(asyncio.create_task(self.feed_loop()))
                    except (aiohttp.ClientError,RuntimeError,KeyError,ValueError,asyncio.TimeoutError):self.pause('BOOTSTRAP_UNAVAILABLE')
                if not self.capture_enabled and tasks:
                    for t in tasks:t.cancel()
                    await asyncio.gather(*tasks,return_exceptions=True);tasks=[]
                for task in tasks:
                    if task.done():
                        error=task.exception()
                        if self.capture_enabled:self.pause(type(error).__name__ if error else 'UNEXPECTED_TASK_EXIT')
                        for t in tasks:t.cancel()
                        await asyncio.gather(*tasks,return_exceptions=True);tasks=[];break
                await asyncio.sleep(1)
        finally:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True);await self.http.close()
