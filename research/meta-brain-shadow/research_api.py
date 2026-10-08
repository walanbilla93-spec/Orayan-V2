"""Optional read-only research API. Never imports the observer or trading code."""
import asyncio
import base64
import csv
import gzip
import hashlib
import hmac
import io
import json
import os
import time
import zlib
import zipfile
from contextlib import asynccontextmanager, aclosing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import web
from research_memory import RESERVE, snapshot as memory_snapshot, trim_unused

ROOT = Path(__file__).resolve().parent / 'research_ui'
SYMBOLS = ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')
STREAMS = ('raw_trades', 'depth_1s', 'derived_1s', 'derived_5s', 'derived_60s',
           'raw_liquidations', 'live_ohlc', 'bootstrap_ohlc', 'feature_pipeline_status',
           'aux_oi_5m', 'aux_long_short_5m', 'aux_premium_1m', 'aux_funding')
SCHEMA = {
    'predictions': {'id': 'text', 'event_ms': 'bigint', 'symbol': 'text', 'record': 'text'},
    'labels': {'id': 'text', 'record': 'text'},
    'boundary': {'id': 'integer', 'record': 'text'},
    'capture_chunks': {'id': 'text', 'stream': 'text', 'symbol': 'text', 'first_ms': 'bigint',
                       'last_ms': 'bigint', 'rows': 'integer', 'sha256': 'text', 'payload': 'bytea'},
    'capture_status': {'id': 'bigint', 'at': 'bigint', 'record': 'text'},
}
MAX_INPUT = 8 * 1024**2
MAX_TABLE_SCAN = 32 * 1024**2
MAX_OUTPUT = 32 * 1024**2
MAX_CHUNK = 2 * 1024**2
MAX_DECODED_CHUNK = 8 * 1024**2
MAX_LINE = 1024**2
MAX_ROWS = 25000
MAX_SECONDS = 120
ESSENTIALS = ('predictions', 'labels', 'boundary')
CSV_COLUMNS = {'capture': ['chunk_id', 'chunk_sha256', 'receipt_at_utc', 'symbol', 'record_json'],
               'predictions': ['id', 'event_at_utc', 'symbol', 'record_json'],
               'labels': ['id', 'prediction_event_at_utc', 'symbol', 'record_json'],
               'capture_status': ['id', 'at_utc', 'record_json'], 'boundary': ['id', 'record_json']}
TABLES_SQL = """SELECT c.relname, pg_total_relation_size(c.oid), pg_table_size(c.oid),
 pg_indexes_size(c.oid), c.reltuples::bigint FROM pg_class c JOIN pg_namespace n
 ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(%s)"""


class GuardError(ValueError):
    pass


class ZipSink(io.RawIOBase):
    """Non-seekable output; drain after each row instead of retaining the archive."""
    def __init__(self):
        super().__init__()
        self.pending = bytearray()
        self.position = 0

    def writable(self):
        return True

    def seekable(self):
        return False

    def tell(self):
        return self.position

    def write(self, data):
        self.pending.extend(data)
        self.position += len(data)
        return len(data)

    def drain(self):
        data = bytes(self.pending)
        self.pending.clear()
        return data


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


def parse_ms(value):
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            raise ValueError()
        return int(dt.timestamp() * 1000)
    except (ValueError, AttributeError, OverflowError):
        raise GuardError('Use an ISO timestamp with UTC offset.') from None


@dataclass(frozen=True)
class Selection:
    dataset: str
    stream: str
    symbol: str
    start: int
    end: int
    compressed: bool

    @classmethod
    def parse(cls, query):
        if any(len(query.getall(k)) != 1 for k in query):
            raise GuardError('Repeated filters are not allowed.')
        if set(query) - {'dataset', 'stream', 'symbol', 'start', 'end', 'format'}:
            raise GuardError('Unknown filter.')
        dataset = query.get('dataset', '')
        stream = query.get('stream', '')
        symbol = query.get('symbol', '')
        if dataset not in (*SCHEMA.keys(), 'capture') or dataset == 'capture_chunks':
            raise GuardError('Select an available dataset.')
        if dataset == 'capture' and stream not in STREAMS:
            raise GuardError('Select one capture stream.')
        if symbol and symbol not in SYMBOLS:
            raise GuardError('Unknown symbol.')
        if query.get('format', 'csv.gz') not in ('csv', 'csv.gz'):
            raise GuardError('Unknown download format.')
        start, end = parse_ms(query.get('start')), parse_ms(query.get('end'))
        if not 0 < end - start <= 3600000:
            raise GuardError('Choose a positive range of at most one hour; download longer periods in parts.')
        return cls(dataset, stream, symbol, start, end, query.get('format', 'csv.gz') == 'csv.gz')

    def sql(self):
        """Identifiers are constants; every user value remains a bound parameter."""
        args = [self.start, self.end]
        if self.dataset == 'capture':
            # Do not assume a maximum chunk span: a failed flush can span a long interval.
            # Older ranges may time out safely instead of silently omitting overlapping chunks.
            q = """SELECT id,sha256,CASE WHEN octet_length(payload)<=2097152 THEN payload ELSE NULL END
              FROM public.capture_chunks WHERE stream=%s
              AND last_ms >= %s AND first_ms < %s"""
            args = [self.stream, self.start, self.end]
            if self.symbol:
                q += ' AND symbol=%s'
                args.append(self.symbol)
            # stream,last_ms index supports this order; no unindexed full sort.
            return q + ' ORDER BY last_ms,id LIMIT 100001', args
        if self.dataset in ('predictions', 'labels'):
            if self.dataset == 'predictions':
                q = 'SELECT p.id,p.event_ms,p.symbol,p.record FROM public.predictions p'
            else:
                q = 'SELECT l.id,p.event_ms,p.symbol,l.record FROM public.labels l JOIN public.predictions p ON p.id=l.id'
            q += ' WHERE p.event_ms >= %s AND p.event_ms < %s'
            if self.symbol:
                q += ' AND p.symbol=%s'
                args.append(self.symbol)
            return q + ' ORDER BY p.event_ms,p.id LIMIT 100001', args
        if self.dataset == 'capture_status':
            return 'SELECT id,at,record FROM public.capture_status WHERE at >= %s AND at < %s ORDER BY id LIMIT 100001', args
        return 'SELECT id,record FROM public.boundary WHERE id=1', []


def csv_row(values):
    # JSON strings are valid research data; guard free text against spreadsheet formula execution.
    safe = ["'" + str(v) if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v for v in values]
    out = io.StringIO(newline='')
    csv.writer(out).writerow(safe)
    return out.getvalue().encode('utf-8')


def unpack_lines(payload, sha):
    if len(payload) > MAX_CHUNK or hashlib.sha256(payload).hexdigest() != sha:
        raise GuardError('Chunk is too large or failed its stored checksum.')
    total = 0
    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as source:
        while True:
            line = source.readline(MAX_LINE + 1)
            if not line:
                break
            total += len(line)
            if len(line) > MAX_LINE or total > MAX_DECODED_CHUNK:
                raise GuardError('Decoded chunk exceeds the safe size limit.')
            yield line.decode('utf-8').rstrip('\n')


def receipt(record):
    # Derived rows have window_end_ms, while raw envelopes/status have receipt_ms.
    value = record.get('receipt_ms', record.get('window_end_ms'))
    if not isinstance(value, int):
        raise GuardError('Capture row has no supported receipt clock.')
    return value


@asynccontextmanager
async def connect_readonly():
    import psycopg
    connection = await psycopg.AsyncConnection.connect(
        host=os.environ['PGHOST'], port=os.environ.get('PGPORT', '5432'),
        dbname=os.environ['PGDATABASE'], user=os.environ.get('RESEARCH_PGUSER', os.environ['PGUSER']),
        password=os.environ.get('RESEARCH_PGPASSWORD', os.environ['PGPASSWORD']),
        sslmode=os.environ.get('PGSSLMODE', 'require'), connect_timeout=5,
        options='-c default_transaction_read_only=on -c statement_timeout=2000 '
                '-c lock_timeout=250 -c idle_in_transaction_session_timeout=10000 -c work_mem=1024',
        autocommit=False)
    try:
        await connection.execute('SET TRANSACTION READ ONLY')
        await connection.execute('SET LOCAL search_path = pg_catalog, public')
        await connection.execute("SET LOCAL timezone = 'UTC'")
        yield connection
    finally:
        await connection.rollback()
        await connection.close()


class ResearchDB:
    def __init__(self, factory=connect_readonly):
        self.factory = factory
        self.cached = None
        self.cached_at = 0

    async def validate(self, conn):
        cur = await conn.execute("""SELECT table_name,column_name,data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name=ANY(%s)""", (list(SCHEMA),))
        found = {}
        for table, column, dtype in await cur.fetchall():
            found.setdefault(table, {})[column] = dtype
        if any(found.get(t) != fields for t, fields in SCHEMA.items()):
            raise GuardError('Database schema differs from the inspected capture version; exports disabled.')
        cur = await conn.execute("""SELECT 1 FROM pg_indexes WHERE schemaname='public'
          AND tablename='capture_chunks' AND indexdef LIKE '%%(stream, last_ms)%%'""")
        if not await cur.fetchone():
            raise GuardError('Required capture range index is missing.')

    async def metadata(self):
        if self.cached and time.monotonic() - self.cached_at < 60:
            return self.cached
        async with self.factory() as conn:
            await self.validate(conn)
            cur = await conn.execute(TABLES_SQL, (list(SCHEMA),))
            tables = {r[0]: {'total_bytes': r[1], 'table_toast_bytes': r[2], 'index_bytes': r[3],
                             'estimated_rows': r[4] if r[4] >= 0 else None, 'row_count_is_estimate': True}
                      for r in await cur.fetchall()}
            cur = await conn.execute('SELECT pg_database_size(current_database())')
            database_bytes = (await cur.fetchone())[0]
            streams = []
            for stream in STREAMS:
                cur = await conn.execute('SELECT first_ms,last_ms FROM public.capture_chunks WHERE stream=%s ORDER BY last_ms ASC LIMIT 1', (stream,))
                first = await cur.fetchone()
                if not first:
                    continue
                cur = await conn.execute('SELECT last_ms FROM public.capture_chunks WHERE stream=%s ORDER BY last_ms DESC LIMIT 1', (stream,))
                latest = await cur.fetchone()
                streams.append({'name': stream, 'start': iso(first[0]), 'latest': iso(latest[0])})
            cur = await conn.execute('SELECT record FROM public.capture_status ORDER BY id DESC LIMIT 1')
            row = await cur.fetchone()
            status = json.loads(row[0]) if row else {}
            cur = await conn.execute('SELECT record FROM public.boundary WHERE id=1')
            row = await cur.fetchone()
            boundary = json.loads(row[0]) if row else {}
        # Explicit projection: never send connection details or arbitrary status/config fields.
        self.cached = {'database_bytes': database_bytes, 'tables': tables, 'streams': streams,
                       'schema_version': boundary.get('schema_version'),
                       'prospective_start_at': boundary.get('prospective_start_at'),
                       'status_at': status.get('at'), 'healthy': status.get('healthy'),
                       'execution_enabled': status.get('execution_enabled'),
                       'shadow_only': status.get('shadow_only'),
                       'session_counters': status.get('counters', {}),
                       'datasets': ['capture', 'predictions', 'labels', 'boundary', 'capture_status'],
                       'symbols': list(SYMBOLS), 'max_range_minutes': 60, 'bundle_available': True}
        self.cached_at = time.monotonic()
        return self.cached

    async def estimate(self, selection):
        async with self.factory() as conn:
            await self.validate(conn)
            sql, args = selection.sql()
            cur = await conn.execute('EXPLAIN (FORMAT JSON) ' + sql, args)
            plan = (await cur.fetchone())[0][0]['Plan']
            # Postgres Plan Width severely underestimates toasted gzip payloads; never use it as a cap.
            if selection.dataset == 'capture':
                where = sql[sql.index(' WHERE '):sql.index(' ORDER BY ')]
                cur = await conn.execute('SELECT count(*),coalesce(sum(octet_length(payload)),0),coalesce(max(octet_length(payload)),0),coalesce(sum(rows),0) FROM public.capture_chunks' + where, args)
                chunks, size, largest, rows = await cur.fetchone()
                if size > MAX_INPUT or largest > MAX_CHUNK or rows > MAX_ROWS:
                    raise GuardError('This range is too large. Choose a shorter time range or one symbol.')
                return {'chunks': chunks, 'compressed_input_bytes': size, 'max_source_rows': rows,
                        'complete_range': True, 'output_bytes': None, 'output_size_is_unknown': True,
                        'note': 'Output is decoded CSV. Size is capped during streaming.'}
            cur = await conn.execute(TABLES_SQL, (list(SCHEMA),))
            sizes = {r[0]: r[1] for r in await cur.fetchall()}
            if selection.dataset in ('predictions', 'labels'):
                checked = ['predictions', 'labels']
            else:
                checked = [selection.dataset]
            if any(sizes.get(t, MAX_TABLE_SCAN + 1) > MAX_TABLE_SCAN for t in checked):
                raise GuardError('Dataset needs a time index before safe online export; no index will be created here.')
            return {'estimated_rows': plan['Plan Rows'], 'row_count_is_estimate': True,
                    'output_bytes': None, 'output_size_is_unknown': True}

    async def records(self, selection):
        async with self.factory() as conn:
            await self.validate(conn)
            sql, args = selection.sql()
            async with conn.cursor(name='research_export') as cur:
                await cur.execute(sql, args)
                consumed = 0
                while True:
                    row = await cur.fetchone()  # one source chunk; no client-side whole-result buffer
                    if row is None:
                        return
                    if selection.dataset == 'capture':
                        oid, sha, payload = row
                        if payload is None:
                            raise GuardError('New source chunk exceeds the safe size limit.')
                        payload = bytes(payload)
                        consumed += len(payload)
                        if consumed > MAX_INPUT:
                            raise GuardError('Compressed input limit exceeded.')
                        for text in unpack_lines(payload, sha):
                            record = json.loads(text)
                            at = receipt(record)
                            if selection.start <= at < selection.end:
                                yield (oid, sha, iso(at), record.get('symbol', selection.symbol), text)
                            await asyncio.sleep(0)
                    elif selection.dataset in ('predictions', 'labels'):
                        yield (row[0], iso(row[1]), row[2], row[3])
                    elif selection.dataset == 'capture_status':
                        yield (row[0], iso(row[1]), row[2])
                    else:
                        yield row

    @asynccontextmanager
    async def essentials(self):
        """Full small durable population from one read-only repeatable-read snapshot."""
        async with self.factory() as conn:
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await self.validate(conn)
            cur = await conn.execute(TABLES_SQL, (list(ESSENTIALS),))
            sizes = {row[0]: row[1] for row in await cur.fetchall()}
            if any(sizes.get(name, MAX_TABLE_SCAN + 1) > MAX_TABLE_SCAN for name in ESSENTIALS):
                raise GuardError('Essential history exceeds the safe online scan limit.')
            counts = {}
            total_bytes = 0
            for name in ESSENTIALS:
                # Names are fixed constants, never request inputs.
                cur = await conn.execute(f'SELECT count(*),coalesce(sum(octet_length(record)),0),coalesce(max(octet_length(record)),0) FROM public.{name}')
                count, size, largest = await cur.fetchone()
                counts[name] = count
                total_bytes += size
                if largest > MAX_LINE:
                    raise GuardError('An essential record exceeds the safe row size.')
            if sum(counts.values()) > MAX_ROWS or total_bytes > MAX_OUTPUT:
                raise GuardError('Essential history exceeds the safe download limit.')
            cur = await conn.execute('SELECT count(*) FROM public.labels l LEFT JOIN public.predictions p ON p.id=l.id WHERE p.id IS NULL')
            if (await cur.fetchone())[0]:
                raise GuardError('An outcome has no linked prediction; bundle refused.')
            cur = await conn.execute('SELECT record FROM public.boundary WHERE id=1')
            boundary = await cur.fetchone()
            if counts['boundary'] != 1 or not boundary:
                raise GuardError('The immutable experiment boundary is missing or ambiguous.')
            cur = await conn.execute('SELECT CURRENT_TIMESTAMP, min(event_ms), max(event_ms) FROM public.predictions')
            at, first, latest = await cur.fetchone()
            info = {'format_version': 1, 'snapshot_at_utc': at.isoformat(),
                    'scope': 'All available essential history; all symbols; no time filter',
                    'symbols': list(SYMBOLS), 'counts': counts,
                    'prediction_event_range_utc': {'first': iso(first) if first is not None else None,
                                                  'latest': iso(latest) if latest is not None else None},
                    'pending_outcomes': counts['predictions'] - counts['labels'],
                    'label_clock': 'Linked prediction event time, not outcome maturation time',
                    'schema_version': json.loads(boundary[0]).get('schema_version'),
                    'excludes': ['Dense capture streams', 'Repetitive capture status', 'Secrets and service configuration']}
            queries = {
                'predictions': 'SELECT id,event_ms,symbol,record FROM public.predictions ORDER BY event_ms,id',
                'labels': 'SELECT l.id,p.event_ms,p.symbol,l.record FROM public.labels l JOIN public.predictions p ON p.id=l.id ORDER BY p.event_ms,p.id',
                'boundary': 'SELECT id,record FROM public.boundary WHERE id=1'}

            async def rows(name):
                async with conn.cursor(name='essentials_' + name) as cursor:
                    await cursor.execute(queries[name])
                    while True:
                        row = await cursor.fetchone()
                        if row is None:
                            return
                        if name in ('predictions', 'labels'):
                            yield (row[0], iso(row[1]), row[2], row[3])
                        else:
                            yield row
                        await asyncio.sleep(0)

            yield info, rows


class Access:
    def __init__(self, token, development=False):
        if not development and (len(token) < 43 or len(set(token)) < 16):
            raise RuntimeError('Set a cryptographically random RESEARCH_ACCESS_TOKEN (at least 32 random bytes).')
        self.key = token.encode('utf-8')
        self.development = development
        self.bad_times = []

    def cookie(self):
        value = str(int(time.time()) + 8 * 3600)
        return value + '.' + hmac.new(self.key, value.encode(), hashlib.sha256).hexdigest()

    def valid(self, value):
        try:
            expiry, sig = value.split('.')
            return int(time.time()) < int(expiry) <= int(time.time()) + 8 * 3600 and hmac.compare_digest(
                sig, hmac.new(self.key, expiry.encode(), hashlib.sha256).hexdigest())
        except (ValueError, AttributeError):
            return False


def create_app(db=None, token=None, development=False, health=None, public_access=None):
    if public_access is None:
        mode = os.environ.get('RESEARCH_PUBLIC_ACCESS', 'false').strip().lower()
        if mode not in ('true', 'false'):
            raise RuntimeError('RESEARCH_PUBLIC_ACCESS must explicitly be true or false.')
        public_access = mode == 'true'
    access = None if public_access else Access(token if token is not None else os.environ.get('RESEARCH_ACCESS_TOKEN', ''), development)
    db = db or ResearchDB()
    gate = asyncio.Lock()

    def check_memory():
        usage = memory_snapshot()
        if usage and usage['headroom_bytes'] < RESERVE:
            trim_unused()
            usage = memory_snapshot()
            if usage and usage['headroom_bytes'] < RESERVE:
                raise GuardError('Observer memory is busy. Try the download again later.')

    @web.middleware
    async def protect(request, handler):
        if development and request.remote not in ('127.0.0.1', '::1'):
            raise web.HTTPForbidden(text='Development preview is localhost only.')
        if request.path.startswith('/research/api/') and not development and not public_access and not access.valid(request.cookies.get('research_session')):
            raise web.HTTPUnauthorized(text='Enter your research access key.')
        try:
            response = await handler(request)
        except GuardError as error:
            response = web.json_response({'error': str(error)}, status=400)
        except (web.HTTPException, asyncio.CancelledError, ConnectionError):
            raise
        except Exception:
            # Never include DB exception/DSN or secret values in HTTP errors or logs.
            response = web.json_response({'error': 'Research database is unavailable or query exceeded its limit.'}, status=503)
        if not response.prepared:
            response.headers.update(security_headers())
        return response

    def security_headers():
        return {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
                'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
                'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}

    async def login(request):
        if public_access:
            return web.json_response({'ok': True, 'access_mode': 'public'})
        origin = request.headers.get('Origin')
        if not origin or origin != 'https://' + request.host:
            raise web.HTTPForbidden(text='Same-origin HTTPS access required.')
        now = time.monotonic()
        access.bad_times[:] = [t for t in access.bad_times if now - t < 60]
        if len(access.bad_times) >= 10:
            raise web.HTTPTooManyRequests(text='Wait a minute before trying the access link again.')
        try:
            body = await request.json()
            supplied = body.get('token', '')
            good = isinstance(supplied, str) and hmac.compare_digest(supplied.encode(), access.key)
        except (ValueError, AttributeError):
            good = False
        if not good:
            access.bad_times.append(now)
            raise web.HTTPUnauthorized(text='Access link is invalid.')
        response = web.json_response({'ok': True})
        response.set_cookie('research_session', access.cookie(), secure=True, httponly=True,
                            samesite='Strict', path='/research', max_age=8 * 3600)
        return response

    async def metadata(request):
        if gate.locked():
            raise web.HTTPTooManyRequests(text='A research query is already running.')
        async with gate, asyncio.timeout(15):
            result = dict(await db.metadata())
            result['access_mode'] = 'public' if public_access else 'protected'
            result['bundle_available'] = True
            result['memory'] = memory_snapshot()
            if health:
                h = health()
                result['observer'] = {k: h.get(k) for k in ('healthy', 'execution_enabled', 'shadow_only', 'at', 'write_errors')}
            return web.json_response(result)

    async def estimate(request):
        selection = Selection.parse(request.query)
        if gate.locked():
            raise web.HTTPTooManyRequests(text='A research query is already running.')
        async with gate, asyncio.timeout(15):
            check_memory()
            return web.json_response(await db.estimate(selection))

    async def download(request):
        selection = Selection.parse(request.query)
        if gate.locked():
            raise web.HTTPTooManyRequests(text='An export is already running.')
        async with gate, asyncio.timeout(MAX_SECONDS):
            check_memory()
            await db.estimate(selection)  # fail before sending HTTP success headers
            name = selection.dataset + ('_' + selection.stream if selection.dataset == 'capture' else '')
            response = web.StreamResponse(headers={**security_headers(),
                'Content-Type': 'application/gzip' if selection.compressed else 'text/csv; charset=utf-8',
                'Content-Disposition': f'attachment; filename="{name}_{selection.start}_{selection.end}.csv' + ('.gz"' if selection.compressed else '"')})
            compressor = zlib.compressobj(3, zlib.DEFLATED, 31) if selection.compressed else None
            output_bytes = 0
            row_count = 0
            await response.prepare(request)

            async def send(data):
                nonlocal output_bytes
                output_bytes += len(data)
                if output_bytes > MAX_OUTPUT:
                    raise GuardError('Output size limit exceeded.')
                data = compressor.compress(data) if compressor else data
                if data:
                    await response.write(data)

            try:
                await send(csv_row(CSV_COLUMNS[selection.dataset]))
                async for row in db.records(selection):
                    if row_count % 256 == 0:
                        check_memory()
                    row_count += 1
                    if row_count > MAX_ROWS:
                        raise GuardError('Row limit exceeded.')
                    await send(csv_row(row))
                if compressor:
                    await response.write(compressor.flush())  # valid gzip footer only on success
                await response.write_eof()
            except BaseException:
                # Abort connection: an interrupted export must not masquerade as a completed CSV.
                if request.transport:
                    request.transport.abort()
                raise
            return response

    async def bundle(request):
        if request.query:
            raise GuardError('The essentials bundle includes all symbols and all available history; no filters are accepted.')
        if gate.locked():
            raise web.HTTPTooManyRequests(text='A research query is already running.')
        async with gate, asyncio.timeout(MAX_SECONDS):
            check_memory()
            async with db.essentials() as (info, rows):
                # All bounds/consistency checks complete before HTTP success.
                check_memory()
                response = web.StreamResponse(headers={**security_headers(),
                    'Content-Type': 'application/zip',
                    'Content-Disposition': 'attachment; filename="meta_brain_essentials.zip"'})
                await response.prepare(request)
                sink = ZipSink()
                archive = zipfile.ZipFile(sink, 'w', zipfile.ZIP_DEFLATED, compresslevel=3)
                total_bytes, total_rows = 0, 0
                files = {}

                async def flush():
                    data = sink.drain()
                    if data:
                        await response.write(data)

                try:
                    for name in ESSENTIALS:
                        digest = hashlib.sha256()
                        count, size = 0, 0
                        with archive.open(name + '.csv', 'w', force_zip64=True) as member:
                            header = csv_row(CSV_COLUMNS[name])
                            member.write(header)
                            digest.update(header)
                            size += len(header)
                            total_bytes += len(header)
                            await flush()
                            async with aclosing(rows(name)) as records:
                                async for row in records:
                                    if total_rows % 256 == 0:
                                        check_memory()
                                    total_rows += 1
                                    count += 1
                                    data = csv_row(row)
                                    total_bytes += len(data)
                                    size += len(data)
                                    if total_rows > MAX_ROWS or len(data) > MAX_LINE or total_bytes > MAX_OUTPUT:
                                        raise GuardError('Essential export exceeds its safe streaming limit.')
                                    member.write(data)
                                    digest.update(data)
                                    await flush()
                        await flush()
                        if count != info['counts'][name]:
                            raise GuardError('Essential export population differs from its snapshot manifest.')
                        files[name + '.csv'] = {'rows': count, 'bytes': size, 'sha256': digest.hexdigest()}
                    info = {**info, 'files': files, 'complete': True}
                    archive.writestr('manifest.json', json.dumps(info, indent=2).encode())
                    archive.close()  # central directory is written only on success
                    await flush()
                    await response.write_eof()
                except BaseException:
                    if request.transport:
                        request.transport.abort()
                    archive.close()  # never flush an incomplete ZIP to the client
                    raise
                return response

    async def static(request):
        filename = request.match_info.get('file', 'index.html')
        if filename not in ('index.html', 'app.js', 'style.css'):
            raise web.HTTPNotFound()
        return web.FileResponse(ROOT / filename)

    app = web.Application(middlewares=[protect], client_max_size=4096)
    app.router.add_post('/research/session', login)
    app.router.add_get('/research/api/status', metadata)
    app.router.add_get('/research/api/estimate', estimate)
    app.router.add_get('/research/api/download', download)
    app.router.add_get('/research/api/essentials', bundle)
    app.router.add_get('/research/', static)
    app.router.add_get('/research/{file}', static)
    return app


if __name__ == '__main__':
    # Production startup is the additive launcher; direct preview requires explicit local-only flag.
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--local-preview', action='store_true', required=True)
    args = parser.parse_args()
    web.run_app(create_app(development=True), host='127.0.0.1', port=8081, access_log=None)
