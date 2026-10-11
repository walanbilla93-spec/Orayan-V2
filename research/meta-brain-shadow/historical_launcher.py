"""Temporary migration runtime: no observer, no market feeds, no DB writes."""
import asyncio
import os
from aiohttp import web
from research_api import create_app

async def main():
    if os.environ.get('EXECUTION_ENABLED', 'false').lower() != 'false' or os.environ.get('SHADOW_ONLY', 'true').lower() != 'true':
        raise RuntimeError('Shadow-only required')
    app = create_app(health=lambda: {'healthy': False, 'shadow_only': True, 'execution_enabled': False,
                                   'capture_pause': 'HISTORICAL_ARCHIVE_MIGRATION'})
    from historical_archive import make_handlers
    status, download = make_handlers()
    app.router.add_get('/research/api/historical/status', status)
    app.router.add_get('/research/api/historical/{date}.zip', download)
    health = web.Application()
    health.router.add_get('/livez', lambda r: web.json_response({'alive': True, 'capture_paused': True}))
    health.router.add_get('/healthz', lambda r: web.json_response({'alive': True, 'capture_paused': True, 'shadow_only': True, 'execution_enabled': False}))
    runners = [web.AppRunner(health, access_log=None), web.AppRunner(app, access_log=None)]
    try:
        for runner, port in zip(runners, [os.environ.get('PORT', '8080'), os.environ.get('RESEARCH_PORT', '8081')]):
            await runner.setup(); await web.TCPSite(runner, '0.0.0.0', int(port)).start()
        await asyncio.Event().wait()
    finally:
        for runner in runners: await runner.cleanup()

if __name__ == '__main__': asyncio.run(main())
