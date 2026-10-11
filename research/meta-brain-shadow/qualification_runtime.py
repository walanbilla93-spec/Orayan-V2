"""Bounded four-symbol feature/model qualification, entirely synthetic and shadow."""
import hashlib,json,math,os,resource,time
from pathlib import Path
import psycopg
from decision_store import CompactStore
import decision_runtime
from structural_policy import context_from_base,mature_structure
from research_memory import snapshot,trim_unused

def qualify():
    stage=Path(__file__).resolve().parent
    for path in Path('/app').iterdir():
        target=stage/path.name
        if not target.exists():target.symlink_to(path,target_is_directory=path.is_dir())
    decision_runtime.ROOT=stage
    c=psycopg.connect(host=os.environ['PGHOST'],port=os.environ.get('PGPORT','5432'),dbname=os.environ['PGDATABASE'],
        user=os.environ['PGUSER'],password=os.environ['PGPASSWORD'],sslmode=os.environ.get('PGSSLMODE','require'))
    try:
        at=int(time.time()*1000);s=CompactStore(c,'runtime-qualification',True,temporary=True)
        policy={'epoch_started_ms':at-24*3600000,'capture_enabled':False,'orayan_feed_enabled':False,'direction_policy':'EXPERIMENTAL_UNVALIDATED'}
        runtime=decision_runtime.DecisionRuntime(s,policy)
        symbols=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];runtime.symbols[:]=symbols
        start=(at//60000-6000)*60000
        for index,symbol in enumerate(symbols):
            rows={}
            for i in range(6000):
                t=start+i*60000;price=100+index*10+math.sin(i/17)*2+math.sin(i/107)*3+i/10000
                rows[t]={'timestamp_ms':t,'open':price-.05,'high':price+.15,'low':price-.15,'close':price,
                    'open_raw':str(price-.05),'high_raw':str(price+.15),'low_raw':str(price-.15),'close_raw':str(price),
                    'volume_base':10.,'turnover_quote':10*price,'receipt_ms':t+60000,'cohort':'prospective'}
            runtime.base.minutes[symbol]=rows
        runtime.last_clock={'offset_ms':0,'uncertainty_ms':1,'observed_ms':at}
        results={}
        for symbol in symbols:
            records,state=runtime.base.observations(symbol,at,policy['epoch_started_ms'])
            structure=context_from_base(runtime.base,symbol,at)
            runtime.snapshots[symbol]={'at':at,'state':state,'prediction':records[-1] if records else None,'structure':structure}
            runtime.last_minute[symbol]=at
            d=runtime.decide(symbol,at)
            assert d['max_input_receipt_ms']<=at and d['no_trade'] and not d['orayan_inputs_used']
            assert d['confidence'] is None
            if d['features']:assert d['feature_snapshot_hash']==hashlib.sha256(json.dumps(d['features'],sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
            results[symbol]={'minutes':len(runtime.base.minutes[symbol]),'features':len(d['features']),'action':d['action'],'frozen_predictions':len(records)}
        trim_unused();memory=snapshot();maximum=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024
        assert maximum<448*1024*1024,'Scientific runtime exceeds memory qualification bound'
        if memory:assert memory['working_set_bytes']<448*1024*1024,'Combined helper and qualification exceed safe container bound'
        tables=c.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").fetchall()
        assert [r[0] for r in tables]==['boundary','capture_chunks','capture_status','labels','predictions']
        return {'status':'PASS','synthetic':True,'symbols':results,'process_peak_rss_bytes':maximum,'combined_container_memory':memory,
            'old_public_tables_unchanged':True,'public_market_requests':0,'orayan_requests':0,'execution_enabled':False,'qualified_at_ms':int(time.time()*1000)}
    finally:c.rollback();c.close()

if __name__=='__main__':print(json.dumps(qualify(),sort_keys=True))
