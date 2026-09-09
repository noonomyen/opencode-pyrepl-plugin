"""Task model: kill signal and per-execution state."""

import threading
import time

from . import metrics
from .buffers import LineBuffer


class _TaskKill(BaseException):
    """Cooperative kill signal injected into the executor (main) thread.

    Deliberately NOT KeyboardInterrupt: user code routinely catches
    KeyboardInterrupt (ignore-Ctrl+C loops) or swallows it via bare
    except clauses, while almost nothing catches a private BaseException
    subclass except bare except / except BaseException. finally blocks
    still run, so cleanup is preserved.
    """


class Task:
    def __init__(self, task_id, code, n):
        self.task_id = task_id
        self.code = code
        self.n = n
        self.status = "running"
        self.buffer = LineBuffer()
        self.result = None
        self.has_result = False
        self.result_store_truncated = False
        self.error = None
        self.done = threading.Event()
        self.started = time.monotonic()
        self.ended = None
        # Baselines are process-wide so the creating thread does not matter,
        # except cpu_start which the worker records itself (thread_time is
        # per-thread).
        self.cpu_start = None
        self.cpu_ms = None
        self.peak_start = metrics._peak_rss_bytes()
        self.tm_start = None
        self.alloc_bytes = None
        self.rss_bytes = None
        self.mem_warned = None
        self.vars = None
        # Set right after user code completes, before finish("done"): lets
        # the interrupt handlers tell a stale arming (natural finish) apart
        # from a live kill. Plain flag, GIL-atomic.
        self.completed_ok = False
        # Guards status checks so interrupt() only targets the live task on
        # the executor: inject paths verify status under this lock, so a
        # recycled task id (after reset) can never receive a stale inject.
        # The executor itself writes status lock-free (single-flight: it is
        # the only writer), so this lock never blocks it.
        self.lock = threading.Lock()

    def finish(self, status):
        # Lock-free by design (see server._run_task): the executor is the
        # only writer, single-flight; dispatcher reads take the lock but
        # never block since nobody else takes it on this path.
        self.status = status
        if self.ended is None:
            self.ended = time.monotonic()
