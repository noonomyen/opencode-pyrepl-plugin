"""CPU/memory measurement and resource-cap enforcement (Unix only)."""

import os
import sys
import threading
import time

from . import config


def _cpu_clock():
    """Best available CPU clock for the calling thread, else None.

    Prefers thread_time (per-thread) so concurrent user threads do not
    pollute the number; the process_time fallback is process-wide and
    overcounts when other threads burn CPU alongside the task.
    """
    try:
        # Capability probe: the result is discarded on purpose, only the
        # absence of an exception matters before returning the function.
        time.thread_time()
    except (AttributeError, OSError, RuntimeError):
        pass
    else:
        return time.thread_time
    if hasattr(time, "process_time"):
        return time.process_time
    return None


_CPU_CLOCK = _cpu_clock()

try:
    import tracemalloc as _tracemalloc

    _HAVE_TRACEMALLOC = True
except Exception:  # tracemalloc unavailable
    _tracemalloc = None
    _HAVE_TRACEMALLOC = False

try:
    import resource

    _HAVE_GETRUSAGE = True
except ImportError:  # non-Unix: no getrusage/setrlimit
    resource = None  # type: ignore[no-redef]
    _HAVE_GETRUSAGE = False

# Peak-RSS source: getrusage high-water on Unix, else tracemalloc peak
# (Python objects only, misses native allocations like numpy).
_USE_TRACEMALLOC_PEAK = _HAVE_TRACEMALLOC and not _HAVE_GETRUSAGE
# Net Python-byte allocation per task (tracemalloc current delta, may be
# negative when the task frees more than it allocates). Always on where
# available: nframes=1 keeps only totals, no tracebacks.
_USE_TRACEMALLOC_ALLOC = _HAVE_TRACEMALLOC
if _HAVE_TRACEMALLOC:
    try:
        _tracemalloc.start(1)
    except Exception:
        _USE_TRACEMALLOC_PEAK = False
        _USE_TRACEMALLOC_ALLOC = False


def _peak_rss_bytes():
    """Process high-water RSS in bytes, else None. Normalizes Linux KiB vs macOS bytes."""
    if not _HAVE_GETRUSAGE:
        return None
    try:
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak if sys.platform == "darwin" else peak * 1024
    except Exception:
        return None


def _statm_bytes(index):
    """One /proc/self/statm field (0=vsz, 1=resident) in bytes, else None."""
    try:
        with open("/proc/self/statm", encoding="utf-8") as handle:
            pages = int(handle.read().split()[index])
        return pages * os.sysconf("SC_PAGE_SIZE")
    except Exception:
        return None


def _current_rss_bytes():
    """Current RSS in bytes via /proc (Linux only), else None."""
    return _statm_bytes(1)


def _current_vsz_bytes():
    """Current address-space size in bytes via /proc (Linux only), else None."""
    return _statm_bytes(0)


def _apply_limits():
    """Enforce mem/cpu/nproc caps via setrlimit where the platform allows.

    Returns a dict describing what was requested vs enforced. RLIMIT_AS
    overuse raises MemoryError inside the offending task (session
    survives); RLIMIT_CPU overuse kills the process (client respawns).
    CPU accounting is process-lifetime cumulative, not per task.
    RLIMIT_NPROC caps UID-wide process count (anti fork-bomb, not CPU).
    """
    info = {
        "mem_limit_mb": config.MAX_MEM_MB,
        "mem_enforced": False,
        "cpu_limit_s": config.MAX_CPU_S,
        "cpu_enforced": False,
        "nproc_limit": config.MAX_NPROC,
        "nproc_enforced": False,
        "reason": None,
    }
    try:
        import resource as _resource
    except ImportError:
        info["reason"] = "resource module unavailable (non-Unix)"
        return info
    reasons = []
    if config.MAX_MEM_MB > 0:
        cap = config.MAX_MEM_MB * 1024 * 1024
        current_vsz = _current_vsz_bytes()
        if current_vsz is not None and cap < current_vsz:
            reasons.append(
                f"cap {config.MAX_MEM_MB}MB below current address space ({current_vsz // 1048576}MB); not enforced"
            )
        else:
            try:
                _resource.setrlimit(_resource.RLIMIT_AS, (cap, cap))
                info["mem_enforced"] = True
            except Exception as exc:
                reasons.append(f"RLIMIT_AS refused: {exc}")
    if config.MAX_CPU_S > 0:
        try:
            _resource.setrlimit(_resource.RLIMIT_CPU, (config.MAX_CPU_S, config.MAX_CPU_S))
            info["cpu_enforced"] = True
        except Exception as exc:
            reasons.append(f"RLIMIT_CPU refused: {exc}")
    if config.MAX_NPROC > 0:
        # Soft limit only (hard stays untouched so this is reversible), then
        # prove a thread can still spawn: on Linux NPROC counts threads too,
        # and the quota is UID-wide, so a cap below ambient usage breaks
        # boot. A failed probe restores the old soft limit.
        old = None
        try:
            old_soft, old_hard = _resource.getrlimit(_resource.RLIMIT_NPROC)
            old = (old_soft, old_hard)
            effective = min(config.MAX_NPROC, old_hard)
            _resource.setrlimit(_resource.RLIMIT_NPROC, (effective, old_hard))
            probe = threading.Thread(target=lambda: None, daemon=True)
            probe.start()
            probe.join(timeout=5)
            if probe.is_alive():
                raise RuntimeError("probe thread did not finish")
            info["nproc_limit"] = effective
            info["nproc_enforced"] = True
        except Exception as exc:
            if old is not None:
                try:
                    _resource.setrlimit(_resource.RLIMIT_NPROC, (old[0], old[1]))
                except Exception:
                    pass
            reasons.append(f"RLIMIT_NPROC {config.MAX_NPROC} unusable here ({exc}); not enforced")
    if reasons:
        info["reason"] = "; ".join(reasons)
    return info


def _check_mem_warn(task):
    """One-shot RSS warning for a task, evaluated once at task completion.
    Warn-only, never kills.

    Compares high-water GROWTH since the task started (not the absolute
    high-water, which earlier tasks may have left behind), so an innocent
    task after a big hoard does not warn by association. By design this
    reports a process hoarding data at task end, not a mid-run sample:
    ru_maxrss is monotonic, so the end-of-task delta covers any transient
    spike during the run as well.
    """
    if task.mem_warned is not None or config.MEM_WARN_PCT <= 0:
        return
    if config.MAX_MEM_MB <= 0 or not _HAVE_GETRUSAGE:
        return
    try:
        current = _peak_rss_bytes()
        if current is None:
            return
        cap = config.MAX_MEM_MB * 1024 * 1024
        base = task.peak_start or 0
        if current - base > cap * config.MEM_WARN_PCT // 100:
            task.mem_warned = (
                f"RSS +{(current - base) // 1048576}MB this task > {config.MEM_WARN_PCT}% of {config.MAX_MEM_MB}MB limit"
            )
    except Exception:
        pass
