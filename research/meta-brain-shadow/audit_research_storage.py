"""Read-only on-demand storage audit. Read PG* from service environment, never print credentials."""
import argparse
import gzip
import hashlib
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from research_api import SCHEMA, STREAMS, MAX_CHUNK, MAX_LINE


def run():
    import psycopg
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='research_storage_audit.json')
    parser.add_argument('--hours', type=int, default=6, choices=range(1, 25))
    args = parser.parse_args()
    report = {'measured_at': datetime.now(timezone.utc).isoformat(), 'read_only': True,
              'method': 'relation sizes; exact indexed recent stream aggregates; bounded latest payload samples',
              'errors': []}
    with psycopg.connect(host=os.environ['PGHOST'], port=os.environ.get('PGPORT','5432'),
                        dbname=os.environ['PGDATABASE'], user=os.environ.get('RESEARCH_PGUSER',os.environ['PGUSER']),
                        password=os.environ.get('RESEARCH_PGPASSWORD',os.environ['PGPASSWORD']),
                        sslmode=os.environ.get('PGSSLMODE','require'), connect_timeout=5, autocommit=True,
                        options='-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=250 -c work_mem=1024') as conn:
        # Each query runs in its own read-only transaction; denied optional WAL privileges do not poison the audit.
        def query(sql, params=()):
            return conn.execute(sql,params).fetchall()
        report['schema'] = query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")
        found = {}
        for table,col,dtype in report['schema']:
            found.setdefault(table,{})[col] = dtype
        if any(found.get(t) != fields for t,fields in SCHEMA.items()):
            raise RuntimeError('Schema differs from inspected version; no payload audit performed.')
        report['database_bytes'] = query('SELECT pg_database_size(current_database())')[0][0]
        report['tables'] = [dict(zip(['table','heap_bytes','table_toast_bytes','index_bytes','total_bytes','estimated_rows'],r)) for r in query("""SELECT c.relname,pg_relation_size(c.oid),pg_table_size(c.oid),pg_indexes_size(c.oid),
         pg_total_relation_size(c.oid),c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC""")]
        report['indexes'] = query("SELECT indexrelname,pg_relation_size(indexrelid),idx_scan FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC")
        report['toast'] = query("""SELECT c.relname,pg_total_relation_size(c.reltoastrelid) FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.reltoastrelid<>0""")
        report['streams'] = []
        now = int(datetime.now(timezone.utc).timestamp()*1000)
        # Complete UTC hours only; partial current hour would understate rate.
        end = now//3600000*3600000
        start = end - args.hours*3600000
        report['rate_interval'] = {'start_ms':start,'end_ms':end,'complete_hours':args.hours,'clock':'chunk last receipt; minor boundary assignment effects'}
        for stream in STREAMS:
            try:
                latest = query('SELECT last_ms FROM public.capture_chunks WHERE stream=%s ORDER BY last_ms DESC LIMIT 1',(stream,))
                if not latest:
                    continue
                earliest = query('SELECT first_ms FROM public.capture_chunks WHERE stream=%s ORDER BY last_ms ASC LIMIT 1',(stream,))[0][0]
                stats = query("""SELECT last_ms/3600000*3600000 AS hour,symbol,count(*),sum(rows),sum(octet_length(payload)),max(octet_length(payload)),max(last_ms-first_ms)
                  FROM public.capture_chunks WHERE stream=%s AND last_ms>=%s AND last_ms<%s GROUP BY hour,symbol ORDER BY hour,symbol""",(stream,start,end))
                entry = {'stream':stream,'earliest_first_receipt_ms':earliest,'latest_receipt_ms':latest[0][0],
                         'hourly_by_symbol':[dict(zip(['hour_ms','symbol','chunks','source_rows','compressed_payload_bytes','max_chunk_bytes','max_chunk_span_ms'],r)) for r in stats]}
                # Sample metadata and field names only; never dump captured data or arbitrary record values.
                sample = query('SELECT rows,octet_length(payload),sha256,CASE WHEN octet_length(payload)<=%s THEN payload ELSE NULL END FROM public.capture_chunks WHERE stream=%s ORDER BY last_ms DESC LIMIT 1',(MAX_CHUNK,stream))[0]
                count,size,sha,payload = sample
                entry['latest_chunk'] = {'source_rows':count,'compressed_bytes':size,'sha256':sha}
                if payload is not None:
                    payload = bytes(payload)
                    if hashlib.sha256(payload).hexdigest() != sha:
                        raise RuntimeError('Stored checksum mismatch')
                    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as gz:
                        line = gz.readline(MAX_LINE+1)
                    if len(line)>MAX_LINE:
                        raise RuntimeError('Sample row too large')
                    row = json.loads(line)
                    entry['sample_fields'] = {k: {'json_bytes':len(json.dumps(v,separators=(',',':')).encode()),'type':type(v).__name__} for k,v in row.items()}
                    if isinstance(row.get('payload'),dict):
                        entry['sample_payload_fields'] = {k:{'json_bytes':len(json.dumps(v,separators=(',',':')).encode()),'type':type(v).__name__} for k,v in row['payload'].items()}
                report['streams'].append(entry)
            except psycopg.Error as error:
                report['errors'].append({'stream':stream,'sqlstate':error.sqlstate,'message':'query denied or timed out; not a zero result'})
        for table in ['predictions','labels','boundary','capture_status']:
            # Exact counts only small relations; avoid an unrestricted busy-table audit.
            size = next((r['total_bytes'] for r in report['tables'] if r['table']==table),0)
            if size <= 32*1024**2:
                report.setdefault('exact_counts',{})[table] = query('SELECT count(*) FROM public.'+table)[0][0]
            else:
                report.setdefault('omitted_exact_counts',[]).append(table)
        try:
            report['wal_directory_bytes'] = query('SELECT sum(size) FROM pg_ls_waldir()')[0][0]
        except psycopg.Error as error:
            report['wal_directory_bytes'] = None
            report['errors'].append({'optional':'WAL directory size','sqlstate':error.sqlstate,'message':'not accessible with current privileges'})
        report['postgresql_version'] = query('SHOW server_version')[0][0]
    Path(args.output).write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'output':args.output,'database_bytes':report['database_bytes'],'tables':len(report['tables']),'streams':len(report['streams']),'partial_errors':len(report['errors'])}))


if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        print(json.dumps({'error_type':type(error).__name__,'message':'Audit unavailable. Verify PG environment/access and schema; credentials and DB errors are intentionally redacted.'}))
        raise SystemExit(1) from None
