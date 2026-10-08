"""Memory accounting and release of unused allocator pages; no data eviction."""
import asyncio
import ctypes
import sys
from pathlib import Path

RESERVE = 64 * 1024**2


def snapshot(root=Path('/sys/fs/cgroup')):
    try:
        maximum = (root / 'memory.max').read_text().strip()
        if maximum == 'max':
            return None
        maximum = int(maximum)
        current = int((root / 'memory.current').read_text())
        stat = dict(line.split() for line in (root / 'memory.stat').read_text().splitlines())
        inactive = int(stat.get('inactive_file', 0))
        working = max(0, current - inactive)
        return {'limit_bytes': maximum, 'current_bytes': current,
                'inactive_file_bytes': inactive, 'working_set_bytes': working,
                'anonymous_bytes': int(stat.get('anon', 0)),
                'headroom_bytes': max(0, maximum - working), 'export_reserve_bytes': RESERVE}
    except (OSError, ValueError):
        return None


def trim_unused():
    if sys.platform != 'linux':
        return False
    try:
        trim = ctypes.CDLL(None).malloc_trim
        trim.argtypes = [ctypes.c_size_t]
        trim.restype = ctypes.c_int
        return bool(trim(0))
    except (AttributeError, OSError):
        return False


async def maintenance():
    while True:
        await asyncio.sleep(60)
        trim_unused()
