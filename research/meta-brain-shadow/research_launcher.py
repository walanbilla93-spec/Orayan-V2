"""Additive launcher: original observer provenance remains explicit and unmodified."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
from aiohttp import web
from research_api import create_app

ROOT = Path(__file__).resolve().parent


async def main():
    # Refuse to start the overlay against a different observer implementation.
    manifest = json.loads((ROOT / 'research_overlay_lock.json').read_text())
    for name, expected in manifest['observer_files'].items():
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError('Observer source differs from the frozen overlay base.')
    if os.environ.get('GIT_COMMIT') != manifest['observer_commit']:
        raise RuntimeError('Keep GIT_COMMIT at the original observer revision; record overlay revision separately.')
    if os.environ.get('EXECUTION_ENABLED', 'false').lower() != 'false':
        raise RuntimeError('Execution is prohibited.')
    # Validate new access protection before the observer takes the writer lock.
    app = create_app(health=lambda: observer.health())
    from service import Observer
    config = json.loads((ROOT / 'config.json').read_text())
    observer = Observer(config, os.environ.get('DATA_ROOT', '/capture'))
    runner = web.AppRunner(app, access_log=None)
    try:
        await runner.setup()
        port = int(os.environ.get('RESEARCH_PORT', '8081'))
        if port == int(os.environ.get('PORT', '8080')):
            raise RuntimeError('Research and observer ports must differ.')
        await web.TCPSite(runner, '0.0.0.0', port).start()
        await observer.run()
    finally:
        await runner.cleanup()


if __name__ == '__main__':
    asyncio.run(main())
