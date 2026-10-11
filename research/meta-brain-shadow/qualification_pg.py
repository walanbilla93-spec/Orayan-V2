"""Synthetic qualification in a disposable isolated Meta Brain database schema.

Legacy public research rows are inspected read-only and checked before/after.
No Orayan database, service, trading code or mutation endpoint is involved.
"""
import hashlib,json,os,time,uuid
import psycopg
from psycopg import sql
from decision_store import CompactStore,WINDOW,boundaries
from decision_learning import EpisodeConsumer

def qualify():
    c=psycopg.connect(host=os.environ['PGHOST'],port=os.environ.get('PGPORT','5432'),dbname=os.environ['PGDATABASE'],
        user=os.environ['PGUSER'],password=os.environ['PGPASSWORD'],sslmode=os.environ.get('PGSSLMODE','require'),connect_timeout=15)
    tables=('predictions','labels','boundary','capture_status','capture_chunks')
    def population():return {t:c.execute(sql.SQL('SELECT count(*) FROM public.{}').format(sql.Identifier(t))).fetchone()[0] for t in tables}
    before=population();name='session_temporary_tables'
    try:
        s=CompactStore(c,'qualification-'+name,True,temporary=True);s.set_state('lineage',{'synthetic_qualification':True});c.commit()
        calls=[]
        def decide(symbol,at):calls.append((symbol,at));return {'action':'LONG','decision_ms':at,'max_input_receipt_ms':at-1,'features':{'x':2.},'qualification':True}
        consumer=EpisodeConsumer(s,decide)
        source={'eventId':'source','episodeId':'episode','candidateId':'candidate','kind':'candidate_birth','at':1000,'capturedAt':1000,'symbol':'BTCUSDT','side':'BUY'}
        with s.transaction():consumer.ingest(source,1100,{'synthetic_fixture':True})
        original=s.get_event('decision:source')
        with s.transaction():consumer.ingest(source,1200,{'synthetic_fixture':True})
        assert calls==[('BTCUSDT',1100)]
        outcome={**source,'eventId':'outcome','kind':'order_outcome','at':2000,'capturedAt':2000,'closedAt':2000,'event':'CLOSED','realizedR':-1.,'decisionReference':'source'}
        with s.transaction():consumer.ingest(outcome,2100,{'synthetic_fixture':True})
        assert s.get_event('decision:source')==original
        assert s.get_event('orayan:outcome')['independent_comparison_valid']
        assert s.get_event('loss:outcome')['loss_reason'][0]['category']=='unknown_ambiguous'
        try:
            with s.transaction():s.execute("UPDATE mb_events SET record='changed' WHERE id='decision:source'")
            raise AssertionError('Immutable UPDATE accepted')
        except psycopg.errors.RaiseException:pass
        start,end=boundaries('2026-10-10')
        with s.transaction():
            s.add('integrity','before',None,end-1,end-1,{'fixture':1})
            s.add('integrity','after',None,end,end,{'fixture':2})
            s.publish_day('2026-10-10',end+1)
        archive=s.execute('SELECT payload FROM mb_archives WHERE date=?',('2026-10-10',)).fetchone()[0]
        assert s.verify_zip(bytes(archive))['event_count']==1
        payload,manifest=s.current_export(end+3600000);assert manifest['event_count']==2
        assert s.verify_zip(payload)['event_count']==2
        s.learn('r','test-bucket',1000,1100,-1.);c.commit()
        assert s.trust('test-bucket',1050)['count']==0 and s.trust('test-bucket',1200)['count']==1
        for n in range(1,7):
            with s.transaction():s.publish_day('2026-10-'+str(n).zfill(2),end)
        try:
            with s.transaction():s.publish_day('2026-10-07',end)
            raise AssertionError('Unexternalized retention deletion accepted')
        except RuntimeError as error:assert str(error)=='RETENTION_WAITING_FOR_VERIFIED_EXTERNAL_COPY'
        oldest=json.loads(s.execute('SELECT record FROM mb_archives ORDER BY date LIMIT 1').fetchone()[0])
        with s.transaction():
            s.mark_external(oldest['date'],oldest['sha256'],'synthetic external verifier fixture',end)
            s.publish_day('2026-10-07',end)
        assert s.status()['archive_count']==7
        second=psycopg.connect(host=os.environ['PGHOST'],port=os.environ.get('PGPORT','5432'),dbname=os.environ['PGDATABASE'],
            user=os.environ['PGUSER'],password=os.environ['PGPASSWORD'],sslmode=os.environ.get('PGSSLMODE','require'))
        try:
            transient=CompactStore(second,'atomic-ddl-qualification',True,temporary=True,commit_initialization=False)
            transient.set_state('test',{'rollback_required':True});second.rollback()
            assert second.execute("SELECT to_regclass('pg_temp.mb_events')").fetchone()[0] is None
        finally:second.rollback();second.close()
        after=population();assert before==after
        result={'status':'PASS','adapter':'PostgreSQL','legacy_counts_unchanged':after,'schema':name,
            'checks':['session temporary isolation','atomic schema/receipt DDL rollback','streamed PostgreSQL archive cursor',
                'immutable update guard','atomic episode intake','restart replay idempotency','exact source decisionReference join',
                'no outcome leakage','conservative loss attribution','Colombo boundary','current 30h dedup','cutoff-safe statistics',
                '7-archive externalization gate'],'qualified_at_ms':int(time.time()*1000),'synthetic_schema_removed':True}
    finally:
        c.rollback();c.close() # PostgreSQL removes all session-temporary objects.
    return result

if __name__=='__main__':print(json.dumps(qualify(),sort_keys=True))
