"""Compact shadow service; downloads are read-only, acknowledgements authenticated."""
import asyncio,hashlib,hmac,json,os,re,time
from pathlib import Path
from aiohttp import web
from decision_store import CompactStore,SCHEMA
from research_memory import snapshot

ROOT=Path(__file__).resolve().parent
DATE=re.compile(r'^\d{4}-\d{2}-\d{2}$')

def create_app(store,health,resume_callback=None):
    app=web.Application(client_max_size=4096)
    def authorized(request,management=False):
        key=os.environ.get('META_ARCHIVE_ACK_TOKEN' if management else 'RESEARCH_API_TOKEN') or os.environ.get('RESEARCH_ACCESS_TOKEN','')
        if not management and os.environ.get('RESEARCH_API_PUBLIC',os.environ.get('RESEARCH_PUBLIC_ACCESS','false')).lower()=='true':return
        supplied=request.headers.get('Authorization','').removeprefix('Bearer ')
        if not key or not hmac.compare_digest(key,supplied):raise web.HTTPUnauthorized()
    async def status(request):
        authorized(request);return web.json_response(health())
    async def current(request):
        authorized(request)
        memory=snapshot()
        if memory and memory['headroom_bytes']<96*1024*1024:raise web.HTTPServiceUnavailable(text='Export waiting for memory headroom')
        try:payload,manifest=store.current_export(int(time.time()*1000))
        except RuntimeError as e:raise web.HTTPConflict(text=str(e))
        return web.Response(body=payload,content_type='application/zip',headers={
            'Content-Disposition':'attachment; filename="META_BRAIN_CURRENT_30H.zip"',
            'X-Archive-SHA256':hashlib.sha256(payload).hexdigest(),'Cache-Control':'no-store'})
    async def daily(request):
        authorized(request);date=request.match_info['date']
        if not DATE.fullmatch(date):raise web.HTTPBadRequest()
        row=store.execute('SELECT record,payload FROM mb_archives WHERE date=?',(date,)).fetchone()
        if not row:raise web.HTTPNotFound()
        info=json.loads(row[0]);payload=bytes(row[1])
        if hashlib.sha256(payload).hexdigest()!=info['sha256']:raise web.HTTPConflict(text='Published archive checksum mismatch')
        return web.Response(body=payload,content_type='application/zip',headers={
            'Content-Disposition':'attachment; filename="META_BRAIN_'+date+'.zip"',
            'X-Archive-SHA256':info['sha256'],'Cache-Control':'private, immutable'})
    async def external(request):
        authorized(request,True);body=await request.json()
        if body.get('verification')!='CRC_MANIFEST_HASH_COUNTS_PASS':raise web.HTTPBadRequest(text='Independent verifier receipt required')
        try:
            with store.transaction():store.mark_external(body['date'],body['sha256'],body['external_location'],int(time.time()*1000))
        except (KeyError,ValueError) as e:raise web.HTTPBadRequest(text=str(e))
        return web.json_response({'accepted':True,'date':body['date'],'sha256':body['sha256']})
    async def index(request):
        authorized(request)
        return web.Response(content_type='text/html',text='''<!doctype html><meta charset="utf-8"><title>Meta Brain research</title>
<style>body{font:16px system-ui;max-width:850px;margin:60px auto;padding:0 20px;background:#101722;color:#edf2fa}a{color:#90c8ff}pre{white-space:pre-wrap}</style>
<h1>Meta Brain research</h1><p>Shadow decisions, outcomes and lessons. Execution is disabled.</p>
<p><a href="/research/api/current.zip">Download current 30 hours</a></p><div id="days"></div><pre id="status">Loading…</pre>
<script>fetch('/research/api/status').then(r=>r.json()).then(x=>{document.getElementById('status').textContent=JSON.stringify(x,null,2);for(const d of x.archives||[]){const p=document.createElement('p'),a=document.createElement('a');a.href='/research/api/daily/'+d.date+'.zip';a.textContent='Download '+d.date+' · '+(d.bytes/1048576).toFixed(2)+' MB';p.append(a);document.getElementById('days').append(p)}})</script>''')
    app.router.add_get('/research',index);app.router.add_get('/research/',index)
    app.router.add_get('/research/api/status',status)
    app.router.add_get('/research/api/current.zip',current)
    app.router.add_get('/research/api/daily/{date}.zip',daily)
    app.router.add_post('/research/api/external-receipt',external)
    async def resume(request):
        authorized(request,True)
        if resume_callback is None:raise web.HTTPConflict(text='Runtime resume unavailable')
        try:return web.json_response(resume_callback(await request.json()))
        except (KeyError,ValueError,RuntimeError) as e:raise web.HTTPConflict(text=str(e))
    app.router.add_post('/research/api/resume',resume)
    async def reset_receipt(request):
        authorized(request);return web.json_response({'receipt':store.state('destructive_reset_receipt'),
            'commit_confirmation':store.state('destructive_reset_commit_confirmation'),
            'deployment_amendment':store.state('deployment_amendment')})
    app.router.add_get('/research/api/reset-receipt',reset_receipt)
    return app

async def main():
    # The reset operation creates this boot receipt only after all historical
    # archives have been independently verified and copied off this volume.
    # Boot evidence belongs in the durable canonical database, never an
    # ephemeral container filesystem that disappears during a deployment.
    import psycopg
    with psycopg.connect(host=os.environ['PGHOST'],port=os.environ.get('PGPORT','5432'),dbname=os.environ['PGDATABASE'],
        user=os.environ['PGUSER'],password=os.environ['PGPASSWORD'],sslmode=os.environ.get('PGSSLMODE','require'),
        options='-c default_transaction_read_only=on',connect_timeout=15) as connection:
        row=connection.execute("SELECT record FROM public.mb_state WHERE key='destructive_reset_receipt'").fetchone()
        if not row:raise RuntimeError('Verified reset receipt missing')
        receipt=json.loads(row[0]);boot=receipt['boot']
        check=json.loads(json.dumps(receipt));check.pop('receipt_sha256');check['boot'].pop('reset_receipt_sha256')
        if hashlib.sha256(json.dumps(check,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()!=receipt['receipt_sha256']:
            raise RuntimeError('Reset receipt checksum mismatch')
    if boot.get('historical_archive_verification')!='VERIFIED_EXTERNAL_COPY' or not boot.get('reset_receipt_sha256'):
        raise RuntimeError('Verified reset receipt required')
    policy=json.loads((ROOT/'decision_policy.json').read_text())
    spec=None
    if (ROOT/'source_deployment_amendment.json').exists():
        spec=json.loads((ROOT/'source_deployment_amendment.json').read_text())
        from deployment_amendment import validate
        validate(receipt,spec)
    expected=spec['files'] if spec else boot.get('build_files_sha256',{})
    for name,checksum in expected.items():
        if hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=checksum:raise RuntimeError('Reset/deployment source hash mismatch')
    policy.update(epoch_started_ms=boot['epoch_started_ms'],deployment_source_commit=boot['build_commit'])
    store=CompactStore.production(boot['epoch_id'])
    if spec:
        from deployment_amendment import apply
        amendment=apply(store,receipt,spec,os.environ.get('NF_DEPLOYMENT_SHA'))
        policy['deployment_source_commit']=amendment['new_source_commit']
    from decision_runtime import DecisionRuntime
    runtime=DecisionRuntime(store,policy)
    app=create_app(store,runtime.health,runtime.resume);health=web.Application()
    async def live(request):return web.json_response({'alive':True,'shadow_only':True,'execution_enabled':False})
    async def ready(request):return web.json_response(runtime.health())
    health.router.add_get('/livez',live);health.router.add_get('/healthz',ready)
    runners=[web.AppRunner(health,access_log=None),web.AppRunner(app,access_log=None)]
    task=None
    try:
        for runner,port in zip(runners,[os.environ.get('PORT','8080'),os.environ.get('RESEARCH_PORT','8081')]):
            await runner.setup();await web.TCPSite(runner,'0.0.0.0',int(port)).start()
        task=asyncio.create_task(runtime.run());await task
    finally:
        if task:task.cancel();await asyncio.gather(task,return_exceptions=True)
        for runner in runners:await runner.cleanup()
        store.conn.close()

if __name__=='__main__':asyncio.run(main())
