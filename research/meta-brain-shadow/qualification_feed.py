"""Real read-only feed qualification in a disposable SQLite store, no production writes."""
import collections,json,os,sqlite3,tempfile,time,urllib.request
from decision_store import CompactStore,digest
from decision_learning import EpisodeConsumer
from orayan_feed import URL,selected_events,ingest_export
from research_memory import snapshot
headers={h:os.environ[v] for h,v in (('x-groq-shadow-export-token','ORAYAN_GROQ_EXPORT_TOKEN'),('x-alibaba-shadow-export-token','ORAYAN_ALIBABA_EXPORT_TOKEN'))}
with tempfile.TemporaryFile() as f:
    with urllib.request.urlopen(urllib.request.Request(URL,headers=headers),timeout=180) as r:
        size=0
        for block in iter(lambda:r.read(65536),b''):size+=len(block);assert size<=32*1024*1024;f.write(block)
    f.seek(0);manifest,rows=selected_events(f)
    with tempfile.TemporaryDirectory() as directory:
        c=sqlite3.connect(directory+'/qualification.sqlite');store=CompactStore(c,'SYNTHETIC_QUALIFICATION_ONLY')
        def decide(symbol,at):return {'action':'ABSTAIN','decision_ms':at,'max_input_receipt_ms':at,'features':{},'feature_snapshot_hash':digest({}),'synthetic_fixture':True}
        before=int(time.time()*1000)
        consumer=EpisodeConsumer(store,decide)
        result=ingest_export(store,consumer,f,before,validated=(manifest,rows),clock=lambda:int(time.time()*1000))
        population=store.status();again=ingest_export(store,consumer,f,int(time.time()*1000),validated=(manifest,rows))
        assert store.status()['events']==population['events']
        print(json.dumps({'status':'PASS','real_source_epoch':result['source_epoch'],'selected_events':len(rows),
            'canonical_events':population['events'],'event_json_bytes':population['event_json_bytes'],
            'source_projection_bytes':sum(len(json.dumps(r).encode()) for r in rows),
            'checks':['real canonical hashes/projection','full episode/outcome intake','idempotent replay','temporary qualification store only'],
            'elapsed_ms':int(time.time()*1000)-before,'memory':snapshot(),'production_records_mutated':False},indent=2))
        c.close()
