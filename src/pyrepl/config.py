"""Engine knobs. Values arrive via the parent process spawn environment.

The TypeScript side is the source of truth (it merges pyrepl.jsonc files
and injects the effective values here as transport, not user config), so
this module only parses the environment and never discovers files.
"""

import os


def _env_int(name, fallback, minimum=1):
    try:
        value = int(os.environ.get(name, "").strip() or fallback)
    except ValueError:
        return fallback
    return value if value >= minimum else fallback


MAX_LINES = _env_int("PYREPL_MAX_LINES", 5000)
MAX_BYTES = _env_int("PYREPL_MAX_BYTES", 1000000)
MAX_LINE_CHARS = _env_int("PYREPL_MAX_LINE_CHARS", 10000)
MAX_GREP_CHARS = _env_int("PYREPL_MAX_GREP_CHARS", 500)
RESULT_MAX_CHARS = _env_int("PYREPL_RESULT_MAX_CHARS", 4000)
RESULT_MAX_STORE = _env_int("PYREPL_RESULT_MAX_STORE", 1000000)
RECENT_TASKS = _env_int("PYREPL_RECENT_TASKS", 20)
INTERRUPT_WAIT_S = _env_int("PYREPL_INTERRUPT_WAIT_S", 5)
# Runtime-wide orphan sink (late background-thread output between tasks):
# a big ring so chatty daemons cannot lose data, bounded so they cannot
# OOM the server either. Per-task rings stay at MAX_LINES/MAX_BYTES.
ORPHAN_MAX_LINES = _env_int("PYREPL_ORPHAN_MAX_LINES", 100000)
ORPHAN_MAX_BYTES = _env_int("PYREPL_ORPHAN_MAX_BYTES", 32 * 1024 * 1024)
MAX_MEM_MB = _env_int("PYREPL_MAX_MEM_MB", 4096, minimum=0)
MAX_CPU_S = _env_int("PYREPL_MAX_CPU_S", 0, minimum=0)
# Off by default: the cap is UID-wide (shared with every other process of
# this user), so a blind default breaks boot on busy machines. Opt in with
# headroom over ambient usage.
MAX_NPROC = _env_int("PYREPL_MAX_NPROC", 0, minimum=0)
MEM_WARN_PCT = _env_int("PYREPL_MEM_WARN_PCT", 80, minimum=0)
