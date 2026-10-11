"""Explicit, fail-closed migration. Never run before external archive verification.

Only the five legacy Meta Brain research tables and their owned objects are
removed. No Orayan connection, endpoint, environment, or code is used here.
"""
import argparse,hashlib,json,os,time
from pathlib import Path
import psycopg
from decision_store import CompactStore,digest,packed

TABLES=('labels','predictions','boundary','capture_chunks','capture_status')
EXPECTED={'predictions':53,'labels':53,'boundary':1,'capture_status':25500,'capture_chunks':2191797}

def inspect(connection):
    tables=[r[0] for r in connection.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")]
    if set(tables)!=set(TABLES):raise RuntimeError('Unexpected persisted tables; reset refused')
    counts={t:connection.execute('SELECT count(*) FROM public.'+t).fetchone()[0] for t in TABLES}
    if counts!=EXPECTED:raise RuntimeError('Legacy population changed; reset refused')
    streams=[list(r) for r in connection.execute('SELECT stream,count(*),sum(rows),sum(octet_length(payload)),min(first_ms),max(last_ms) FROM public.capture_chunks GROUP BY stream ORDER BY stream')]
    watermark={'counts':counts,'streams':streams,'boundary':[list(r) for r in connection.execute('SELECT * FROM public.boundary')],
        'max_chunk':connection.execute('SELECT max(first_ms),max(last_ms),max(id) FROM public.capture_chunks').fetchone(),
        'max_status':connection.execute('SELECT max(id),max(at) FROM public.capture_status').fetchone()}
    objects={'tables':tables,'indexes':[list(r) for r in connection.execute("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")],
        'triggers':[list(r) for r in connection.execute("SELECT tgrelid::regclass::text,tgname,pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY tgname")],
        'sequences':[r[0] for r in connection.execute("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")],
        'functions':[r[0] for r in connection.execute("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY proname")]}
    if objects['functions']!=['immutable_shadow']:raise RuntimeError('Unexpected legacy functions; reset refused')
    persisted=[list(r) for r in connection.execute("SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_temp_%' ORDER BY schemaname,tablename")]
    if any(s!='public' for s,t in persisted):raise RuntimeError('Unexpected persisted research schema; reset refused')
    capture_files=[str(p) for p in Path('/capture').rglob('*') if p.is_file()]
    if capture_files:raise RuntimeError('Unarchived persisted volume files; reset refused')
    return {'counts':counts,'watermark_sha256':digest(watermark),'watermark':watermark,
        'database_bytes':connection.execute('SELECT pg_database_size(current_database())').fetchone()[0],
        'table_sizes':[list(r) for r in connection.execute("SELECT relname,pg_table_size(oid),pg_indexes_size(oid),pg_total_relation_size(oid) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname")],
        'objects':objects,'persisted_capture_files':capture_files,'capture_paused':'migration-only launcher; no market or observer writer'}

def main(plan_path,execute=False):
    if not os.environ.get('HOSTNAME','').startswith('meta-brain-shadow-v1-'):raise RuntimeError('Scope identity mismatch')
    plan=json.loads(Path(plan_path).read_text());inventory=plan['archive_inventory']
    if inventory.get('status')!='VERIFIED_EXTERNAL_COPY' or inventory.get('full_reset_gate_passed') is not True:
        raise RuntimeError('Full external archive verification required')
    if digest(inventory)!=plan['archive_inventory_sha256']:raise RuntimeError('External archive inventory digest mismatch')
    if inventory['verified_counts']!=EXPECTED or any(a['verification']!='PASS' for a in inventory['archives']):
        raise RuntimeError('Archive inventory incomplete')
    if plan['scope']!='meta-brain-shadow-v1' or plan['execution_enabled'] is not False:raise RuntimeError('Invalid authorized scope')
    c=psycopg.connect(host=os.environ['PGHOST'],port=os.environ.get('PGPORT','5432'),dbname=os.environ['PGDATABASE'],
        user=os.environ['PGUSER'],password=os.environ['PGPASSWORD'],sslmode=os.environ.get('PGSSLMODE','require'),connect_timeout=15)
    try:
        c.execute('SET lock_timeout=2000');c.execute('SET statement_timeout=300000')
        if not c.execute('SELECT pg_try_advisory_lock(31062026)').fetchone()[0]:raise RuntimeError('A research writer is still active')
        if execute:
            for t in TABLES:c.execute('LOCK TABLE public.'+t+' IN ACCESS EXCLUSIVE MODE')
        before=inspect(c)
        if before['watermark_sha256']!=inventory['watermark_sha256']:raise RuntimeError('Archive/source watermark mismatch')
        if not execute:
            result={'mode':'PREFLIGHT_ONLY','status':'PASS','source':before,'archive_inventory_sha256':plan['archive_inventory_sha256'],
                'exact_reset_plan':{'delete':before['objects'],'retain':['PostgreSQL system schemas and dedicated credentials','frozen model/config/code in the verified build'],
                    'create':['compact canonical mb_* store','durable epoch/reset receipt','initial capture pause']},
                'planned_build_commit':plan['build_commit'],'planned_epoch':plan['epoch_id'],'execution_enabled':False}
            print(json.dumps(result,sort_keys=True));return
        for t in TABLES:c.execute('DROP TABLE public.'+t)
        c.execute('DROP FUNCTION public.immutable_shadow()')
        at=int(time.time()*1000);s=CompactStore(c,plan['epoch_id'],True,commit_initialization=False)
        boot={'epoch_id':plan['epoch_id'],'epoch_started_ms':at,'build_commit':plan['build_commit'],
            'build_files_sha256':plan['build_files_sha256'],'preflight_sha256':plan['preflight_sha256'],
            'historical_archive_verification':'VERIFIED_EXTERNAL_COPY'}
        receipt={'service':'meta-brain-shadow-v1','reset_transaction_recorded_at_ms':at,'boot':boot,'pre_reset':before,
            'archive_inventory_sha256':plan['archive_inventory_sha256'],'archive_watermark_sha256':inventory['watermark_sha256'],
            'archive_inventory':inventory['archives'],'external_directory':inventory['external_directory'],
            'exact_objects_deleted':before['objects'],'exact_objects_retained':['PostgreSQL system schemas, roles and dedicated service credentials','verified build model/config/runtime files'],
            'new_tables':[r[0] for r in c.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")],
            'min_service_mutated':False,'execution_enabled':False}
        checksum=digest(receipt);receipt['receipt_sha256']=checksum;receipt['boot']['reset_receipt_sha256']=checksum
        s.set_state('destructive_reset_receipt',receipt)
        s.set_state('capture_pause',{'reason':'PREFLIGHT_AWAITING_CONTROLLED_RESUME','observed_ms':at})
        c.commit()
        confirmation={'commit_completed_at_ms':int(time.time()*1000),'receipt_sha256':checksum,'reset_committed':True}
        s.set_state('destructive_reset_commit_confirmation',confirmation);c.commit()
        print(json.dumps({'status':'RESET_COMMITTED','epoch':plan['epoch_id'],'receipt_sha256':checksum,**confirmation},sort_keys=True))
    finally:c.rollback();c.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('plan');p.add_argument('--execute',action='store_true');a=p.parse_args();main(a.plan,a.execute)
