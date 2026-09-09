"""Task model: kill signal and per-execution state."""

import threading
import time

from . import metrics
from .buffers import LineBuffer


class _TaskKill(BaseException):
    """Cooperative kill signal injected into a worker thread.

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
        self.thread = None
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
        self.peak_growth_bytes = None
        self.mem_warned = None
        self.vars = None
        # Guards status/thread-identity checks so interrupt() can never
        # inject into a recycled thread. The worker sets its terminal status
        # under this lock before exiting; interrupt() only injects while the
        # task still reports running under the same lock.
        self.lock = threading.Lock()

    def finish(self, status):
        with self.lock:
            self.status = status
            if self.ended is None:
                self.ended = time.monotonic()
