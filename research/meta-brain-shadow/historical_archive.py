"""Migration-only lossless day exports. Every DB connection is read-only.

Original compressed chunks are preserved verbatim, including chunks crossing
midnight. Ownership is by first receipt; dependency dates describe their tail.
No materialized archive, market connection, or writer is created in the pod.
"""
import asyncio
import base64
import gzip
import hashlib
import io
import json
import os
import re
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from aiohttp import web

COLOMBO = timezone(timedelta(hours=5, minutes=30))
TABLES = ('predictions', 'labels', 'boundary', 'capture_status', 'capture_chunks')
EXPECTED = {'predictions': 53, 'labels': 53, 'boundary': 1,
            'capture_status': 25500, 'capture_chunks': 2191797}
ROOT = Path(__file__).resolve().parent
DAY_SQL = "to_char(to_timestamp((%s)/1000.0) AT TIME ZONE 'Asia/Colombo','YYYY-MM-DD')"
CLocks = {'predictions': 'event_ms', 'labels': "(record::jsonb->>'written_at')::bigint",
          'boundary': "(record::jsonb->>'prospective_start_ms')::bigint",
          'capture_status': 'at', 'capture_chunks': 'first_ms'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def day(ms):
    return datetime.fromtimestamp(ms / 1000, COLOMBO).date().isoformat()


class Sink(io.RawIOBase):
    def __init__(self): self.pending = bytearray(); self.position = 0
    def writable(self): return True
    def seekable(self): return False
    def tell(self): return self.position
    def write(self, data):
        self.pending.extend(data); self.position += len(data); return len(data)
    def drain(self):
        data = bytes(self.pending); self.pending.clear(); return data


@asynccontextmanager
async def readonly():
    import psycopg
    conn = await psycopg.AsyncConnection.connect(
        host=os.environ['PGHOST'], port=os.environ.get('PGPORT', '5432'),
        dbname=os.environ['PGDATABASE'], user=os.environ['PGUSER'],
        password=os.environ['PGPASSWORD'], sslmode=os.environ.get('PGSSLMODE', 'require'),
        options='-c default_transaction_read_only=on -c statement_timeout=300000 -c lock_timeout=500 -c work_mem=1024',
        connect_timeout=15)
    try:
        await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        yield conn
    finally:
        await conn.rollback(); await conn.close()


async def inventory(conn):
    tables = [r[0] for r in await (await conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).fetchall()]
    if set(tables) != set(TABLES): raise RuntimeError('Unexpected persisted tables; full export must be extended')
    counts = {t: (await (await conn.execute('SELECT count(*) FROM public.' + t)).fetchone())[0] for t in TABLES}
    if counts != EXPECTED: raise RuntimeError('Historical population changed; do not reset')
    streams = [list(r) for r in await (await conn.execute('SELECT stream,count(*),sum(rows),sum(octet_length(payload)),min(first_ms),max(last_ms) FROM public.capture_chunks GROUP BY stream ORDER BY stream')).fetchall()]
    dates = set()
    for t in TABLES:
        expression = DAY_SQL % CLocks[t]
        for (d,) in await (await conn.execute('SELECT DISTINCT ' + expression + ' FROM public.' + t)).fetchall():
            if d is None: raise RuntimeError('Unpartitionable historical clock')
            dates.add(d)
    columns = [list(r) for r in await (await conn.execute("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).fetchall()]
    indexes = [list(r) for r in await (await conn.execute("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).fetchall()]
    constraints = [list(r) for r in await (await conn.execute("SELECT conrelid::regclass::text,conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conrelid,conname")).fetchall()]
    triggers = [list(r) for r in await (await conn.execute("SELECT tgrelid::regclass::text,tgname,pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY tgname")).fetchall()]
    functions = [list(r) for r in await (await conn.execute("SELECT proname,pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY proname")).fetchall()]
    sizes = [list(r) for r in await (await conn.execute("SELECT relname,pg_table_size(oid),pg_indexes_size(oid),pg_total_relation_size(oid) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname")).fetchall()]
    boundary = [list(r) for r in await (await conn.execute('SELECT * FROM public.boundary')).fetchall()]
    watermark = {'counts': counts, 'streams': streams, 'boundary': boundary,
                 'max_chunk': (await (await conn.execute('SELECT max(first_ms),max(last_ms),max(id) FROM public.capture_chunks')).fetchone()),
                 'max_status': (await (await conn.execute('SELECT max(id),max(at) FROM public.capture_status')).fetchone())}
    return {'format': 'meta-brain-full-history-v1', 'dates': sorted(dates), 'tables': tables,
            'watermark': watermark, 'watermark_sha256': hashlib.sha256(canonical(watermark).encode()).hexdigest(),
            'snapshot': (await (await conn.execute('SELECT pg_current_snapshot()::text')).fetchone())[0],
            'database_bytes': (await (await conn.execute('SELECT pg_database_size(current_database())')).fetchone())[0],
            'schema': {'columns': columns, 'indexes': indexes, 'constraints': constraints, 'triggers': triggers, 'functions': functions},
            'table_sizes': sizes, 'source': 'meta-brain-shadow-v1 private PostgreSQL',
            'exporter_revision_environment': os.environ.get('RESEARCH_REVISION'),
            'exporter_source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'legacy_runtime_revision': 'fd3cde70b331d2337cec18ef73fcd62e51da0e73',
            'observer_revision': os.environ.get('GIT_COMMIT'), 'shadow_only': True,
            'execution_enabled': False, 'partition_timezone': 'Asia/Colombo',
            'chunk_ownership': 'first_ms; original payload unmodified; cross-day tails referenced',
            'coverage_claim': 'captured evidence only; exchange completeness not proven; all original gaps/censors retained',
            'archive_sha256': 'external .sha256 sidecar; a ZIP cannot contain its own SHA-256'}


def make_handlers():
    gate = asyncio.Lock()
    async def status(request):
        if gate.locked(): raise web.HTTPTooManyRequests(text='An archive export is running')
        async with gate, readonly() as conn:
            return web.json_response(await inventory(conn))

    async def download(request):
        date = request.match_info['date']
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date): raise web.HTTPBadRequest()
        if gate.locked(): raise web.HTTPTooManyRequests(text='An archive export is running')
        async with gate, readonly() as conn:
            info = await inventory(conn)
            if date not in info['dates']: raise web.HTTPNotFound()
            if request.query.get('watermark') != info['watermark_sha256']:
                raise web.HTTPConflict(text='Export watermark mismatch')
            try:part=int(request.query.get('part','0'))
            except ValueError:raise web.HTTPBadRequest(text='Part must be 1..8')
            if part not in range(9):raise web.HTTPBadRequest(text='Part must be 1..8')
            lower=int(datetime.fromisoformat(date).replace(tzinfo=COLOMBO).timestamp()*1000)
            upper=lower+86400000
            if part:lower+=(part-1)*10800000;upper=lower+10800000
            suffix=('-part'+str(part).zfill(2)) if part else ''
            response = web.StreamResponse(headers={'Content-Type': 'application/zip',
                'Content-Disposition': 'attachment; filename="META_BRAIN_FULL_' + date + suffix+'.zip"', 'Cache-Control': 'no-store'})
            await response.prepare(request)
            sink = Sink(); archive = zipfile.ZipFile(sink, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True)
            files = {}; stream_counts = {}; dependencies = {}; clocks = {}
            async def drain():
                data = sink.drain()
                if data: await response.write(data)
                await asyncio.sleep(0)
            def note_clock(t, clock):
                prior = clocks.setdefault(t, [clock, clock]); prior[0] = min(prior[0], clock); prior[1] = max(prior[1], clock)
            try:
                for table in TABLES:
                    count = 0; size = 0; digest = hashlib.sha256()
                    condition=CLocks[table]+' >= %s AND '+CLocks[table]+' < %s'
                    expected = (await (await conn.execute('SELECT count(*) FROM public.' + table + ' WHERE '+condition, (lower,upper))).fetchone())[0]
                    entry_info = zipfile.ZipInfo(table + '.ndjson')
                    entry_info.compress_type = zipfile.ZIP_STORED if table == 'capture_chunks' else zipfile.ZIP_DEFLATED
                    with archive.open(entry_info, 'w', force_zip64=True) as entry:
                        async with conn.cursor(name='archive_' + table) as cur:
                            await cur.execute('SELECT * FROM public.' + table + ' WHERE '+condition, (lower,upper))
                            columns = [c.name for c in cur.description]
                            while True:
                                batch = await cur.fetchmany(128)
                                if not batch: break
                                for values in batch:
                                    row = dict(zip(columns, values))
                                    if table == 'capture_chunks':
                                        blob = bytes(row['payload'])
                                        if hashlib.sha256(blob).hexdigest() != row['sha256']: raise RuntimeError('Original chunk checksum failure')
                                        # Original gzip CRC/JSON/event counts are independently
                                        # checked off-volume by verify_history.py. Do not burn
                                        # the tiny production CPU decoding the same exhaust.
                                        actual = row['rows']
                                        key = row['stream']; stats = stream_counts.setdefault(key, {'chunks': 0, 'events': 0, 'payload_bytes': 0})
                                        stats['chunks'] += 1; stats['events'] += actual; stats['payload_bytes'] += len(blob)
                                        row['payload'] = base64.b64encode(blob).decode('ascii')
                                        note_clock(table, row['first_ms']); note_clock(table, row['last_ms'])
                                        tail = day(row['last_ms'])
                                        if tail != date: dependencies[row['id']] = {'owner': date, 'tail_date': tail, 'stream': key, 'first_ms': row['first_ms'], 'last_ms': row['last_ms']}
                                    else:
                                        record = json.loads(row['record'])
                                        clock = row.get('event_ms', row.get('at', record.get('written_at', record.get('prospective_start_ms'))))
                                        note_clock(table, int(clock))
                                    line = (canonical(row) + '\n').encode(); entry.write(line)
                                    count += 1; size += len(line); digest.update(line)
                                await drain()
                    if count != expected: raise RuntimeError('Day table population mismatch')
                    files[table + '.ndjson'] = {'rows': count, 'bytes': size, 'sha256': digest.hexdigest()}
                    await drain()
                # Include the exact model/config/runtime artifacts needed to reconstruct the old epoch.
                for path in sorted(ROOT.rglob('*')):
                    if not path.is_file() or '__pycache__' in path.parts or path.suffix in ('.pyc',): continue
                    name = 'runtime/' + path.relative_to(ROOT).as_posix(); data = path.read_bytes()
                    archive.writestr(name, data); files[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                    await drain()
                coverage = {t: {'utc': [datetime.fromtimestamp(v / 1000, timezone.utc).isoformat() for v in pair],
                                'colombo': [datetime.fromtimestamp(v / 1000, COLOMBO).isoformat() for v in pair]} for t, pair in clocks.items()}
                manifest = {**info, 'date': date,'part':part or 1,'parts':8 if part else 1,
                            'partition':{'start_ms':lower,'end_ms_exclusive':upper,'clock':'table owner clock'},
                            'files': files, 'stream_counts': stream_counts, 'coverage': coverage,
                            'dependencies': dependencies, 'label_join': 'labels.id references predictions.id across the archive set',
                            'complete': True, 'exported_at_utc': datetime.now(timezone.utc).isoformat()}
                archive.writestr('manifest.json', canonical(manifest).encode()); archive.close()
                await drain(); await response.write_eof(); return response
            except BaseException:
                if request.transport: request.transport.abort()
                archive.close(); raise
    return status, download
