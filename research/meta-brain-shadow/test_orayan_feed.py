import base64,hashlib,io,json,sqlite3,unittest,zipfile
from decision_store import CompactStore,packed
from decision_learning import EpisodeConsumer
from orayan_feed import selected_events,ingest_export

def fixture(rows,corrupt=False):
    entries={};metadata=[]
    for row in rows:
        blob=packed(row).encode();pieces=[blob[i:i+256] for i in range(0,len(blob),256)]
        meta={'eventId':row['eventId'],'stream':row['stream'],'chunks':len(pieces),'bytes':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}
        metadata.append(meta);name='records/'+row['stream']+'.jsonl'
        data=b''.join((packed({'meta':meta,'index':i,'data':base64.b64encode(p).decode()})+'\n').encode() for i,p in enumerate(pieces))
        entries[name]=entries.get(name,b'')+data
    out=io.BytesIO()
    manifest={'schemaVersion':'ORAYAN_RESEARCH_V2','complete':True,'watermark':max(r['sequence'] for r in rows),
        'integrity':{'populationComplete':True},'events':metadata,
        'entries':[{'name':n,'bytes':len(v),'sha256':hashlib.sha256(v).hexdigest() if not corrupt else 'wrong'} for n,v in entries.items()]}
    with zipfile.ZipFile(out,'w') as z:
        for n,v in entries.items():z.writestr(n,v)
        z.writestr('manifest.json',packed(manifest))
    out.seek(0);return out

class FeedTests(unittest.TestCase):
    def rows(self):return [
        {'eventId':'e:1','episodeId':'ep','candidateId':'c','sequence':1,'epochId':'e','stream':'decisions','at':1000,'persistedAt':1100,
         'symbol':'BTCUSDT','side':'BUY','boundary':'candidate_birth','geometry':{'entryPrice':100,'invalidationPrice':99,'objectivePrice':102}},
        {'eventId':'e:2','episodeId':'ep','candidateId':'c','decisionReference':'e:1','sequence':2,'epochId':'e','stream':'lifecycle',
         'at':2000,'persistedAt':2100,'status':'CLOSED','outcomeComplete':True,'closedAt':2000,'realizedR':-1.,'transitions':['CLOSED']},
        {'eventId':'e:3','episodeId':'ep','sequence':3,'epochId':'e','stream':'ai_calls','at':2200,'persistedAt':2200,
         'disposition':'NOT_REQUESTED','rawResponse':'must not be retained','request':{'prompt':'must not be retained'}}]
    def test_chunk_hash_population_and_filtered_provider_disposition(self):
        m,r=selected_events(fixture(self.rows()));self.assertEqual(len(r),3)
        self.assertEqual(r[0]['plannedSl'],99);self.assertNotIn('rawResponse',r[-1]);self.assertNotIn('request',r[-1])
        self.assertEqual(r[-1]['disposition'],'NOT_REQUESTED')
        with self.assertRaises(ValueError):selected_events(fixture(self.rows(),True))
    def test_terminal_batch_forbids_retrospective_decision_and_restart_is_idempotent(self):
        c=sqlite3.connect(':memory:');s=CompactStore(c,'test');calls=[]
        consumer=EpisodeConsumer(s,lambda symbol,at:calls.append((symbol,at)))
        ingest_export(s,consumer,fixture(self.rows()),3000);self.assertEqual(calls,[]);count=s.status()['events']
        ingest_export(s,consumer,fixture(self.rows()),4000);self.assertEqual(count,s.status()['events'])
        self.assertFalse(s.get_event('orayan:e:2')['independent_comparison_valid']);c.close()
    def test_missing_declared_source_event_is_rejected(self):
        f=fixture(self.rows());z=zipfile.ZipFile(f);out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as w:
            for n in z.namelist():
                if n!='records/ai_calls.jsonl':w.writestr(n,z.read(n))
        out.seek(0)
        with self.assertRaises(ValueError):selected_events(out)
    def test_decision_clock_is_actual_formation_time_not_batch_start(self):
        c=sqlite3.connect(':memory:');s=CompactStore(c,'test');calls=[]
        def decide(symbol,at):calls.append(at);return {'decision_ms':at,'action':'ABSTAIN','max_input_receipt_ms':at-1}
        ingest_export(s,EpisodeConsumer(s,decide),fixture(self.rows()[:1]),1200,clock=lambda:2000)
        self.assertEqual(calls,[2000]);self.assertEqual(s.get_event('decision:e:1')['decision_ms'],2000);c.close()

if __name__=='__main__':unittest.main()
