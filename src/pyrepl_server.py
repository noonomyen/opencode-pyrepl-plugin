#!/usr/bin/env python3
"""Persistent stdlib-only Python REPL server speaking NDJSON over stdio.

One OS process hosts exactly one REPL session (one namespace). The opencode
plugin spawns one server per opencode session and multiplexes tasks through
the protocol below. No third-party dependencies.

Protocol: each stdin line is one JSON request, each stdout line is one JSON
response. Responses are written to the real stdout (sys.__stdout__) so they
are never captured into a task output buffer.

Requests:
  {"id": 1, "op": "ping"}
  {"id": 2, "op": "execute", "task_id": "t_1", "code": "x = 1", "wait_ms": 30000}
  {"id": 3, "op": "read", "task_id": "t_1", "offset": 0, "limit": 200,
   "target": "combined", "grep": null, "tail_lines": null}
  {"id": 4, "op": "interrupt", "task_id": "t_1"}
  {"id": 5, "op": "reset"}
  {"id": 6, "op": "list"}
  {"id": 7, "op": "shutdown"}

Responses always carry the request "id". Task output lines are stored as
{"stream": "stdout"|"stderr", "line": str} tuples in a bounded ring buffer.

Writes to the real stdout (sys.__stdout__) are reserved for protocol
responses. Between tasks sys.stdout/sys.stderr point at a per-session orphan
sink, so late output from user-spawned background threads can never corrupt
the NDJSON stream; it is collected in the orphan buffer instead.
"""

import ast
import collections
import ctypes
import io
import json
import math
import os
import queue
import re
import sys
import threading
import time
import traceback

VERSION = "0.1.0"


class _TaskKill(BaseException):
    """Cooperative kill signal injected into a worker thread.

    Deliberately NOT KeyboardInterrupt: user code routinely catches
    KeyboardInterrupt (ignore-Ctrl+C loops) or swallows it via bare
    except clauses, while almost nothing catches a private BaseException
    subclass except bare except / except BaseException. finally blocks
    still run, so cleanup is preserved.
    """


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
MAX_MEM_MB = _env_int("PYREPL_MAX_MEM_MB", 4096, minimum=0)
MAX_CPU_S = _env_int("PYREPL_MAX_CPU_S", 0, minimum=0)
# Off by default: the cap is UID-wide (shared with every other process of
# this user), so a blind default breaks boot on busy machines. Opt in with
# headroom over ambient usage.
MAX_NPROC = _env_int("PYREPL_MAX_NPROC", 0, minimum=0)
MEM_WARN_PCT = _env_int("PYREPL_MEM_WARN_PCT", 80, minimum=0)


def _cpu_clock():
    """Best available CPU clock for the calling thread, else None.

    Prefers thread_time (per-thread) so concurrent user threads do not
    pollute the number; the process_time fallback is process-wide and
    overcounts when other threads burn CPU alongside the task.
    """
    try:
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
        "mem_limit_mb": MAX_MEM_MB,
        "mem_enforced": False,
        "cpu_limit_s": MAX_CPU_S,
        "cpu_enforced": False,
        "nproc_limit": MAX_NPROC,
        "nproc_enforced": False,
        "reason": None,
    }
    try:
        import resource as _resource
    except ImportError:
        info["reason"] = "resource module unavailable (non-Unix)"
        return info
    reasons = []
    if MAX_MEM_MB > 0:
        cap = MAX_MEM_MB * 1024 * 1024
        current_vsz = _current_vsz_bytes()
        if current_vsz is not None and cap < current_vsz:
            reasons.append(
                f"cap {MAX_MEM_MB}MB below current address space ({current_vsz // 1048576}MB); not enforced"
            )
        else:
            try:
                _resource.setrlimit(_resource.RLIMIT_AS, (cap, cap))
                info["mem_enforced"] = True
            except Exception as exc:
                reasons.append(f"RLIMIT_AS refused: {exc}")
    if MAX_CPU_S > 0:
        try:
            _resource.setrlimit(_resource.RLIMIT_CPU, (MAX_CPU_S, MAX_CPU_S))
            info["cpu_enforced"] = True
        except Exception as exc:
            reasons.append(f"RLIMIT_CPU refused: {exc}")
    if MAX_NPROC > 0:
        # Soft limit only (hard stays untouched so this is reversible), then
        # prove a thread can still spawn: on Linux NPROC counts threads too,
        # and the quota is UID-wide, so a cap below ambient usage breaks
        # boot. A failed probe restores the old soft limit.
        old = None
        try:
            old_soft, old_hard = _resource.getrlimit(_resource.RLIMIT_NPROC)
            old = (old_soft, old_hard)
            effective = min(MAX_NPROC, old_hard)
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
            reasons.append(f"RLIMIT_NPROC {MAX_NPROC} unusable here ({exc}); not enforced")
    if reasons:
        info["reason"] = "; ".join(reasons)
    return info


def _check_mem_warn(task):
    """One-shot RSS warning for a running task. Warn-only, never kills.

    Compares high-water GROWTH since the task started (not the absolute
    high-water, which earlier tasks may have left behind), so an innocent
    long task after a big transient alloc does not warn by association.
    Only fires for tasks alive past one wait slice (~0.1s).
    """
    if task.mem_warned is not None or MEM_WARN_PCT <= 0:
        return
    if MAX_MEM_MB <= 0 or not _HAVE_GETRUSAGE:
        return
    try:
        current = _peak_rss_bytes()
        if current is None:
            return
        cap = MAX_MEM_MB * 1024 * 1024
        base = task.peak_start or 0
        if current - base > cap * MEM_WARN_PCT // 100:
            task.mem_warned = (
                f"RSS +{(current - base) // 1048576}MB this task > {MEM_WARN_PCT}% of {MAX_MEM_MB}MB limit"
            )
    except Exception:
        pass


def _respond(payload):
    try:
        text = json.dumps(payload)
    except (TypeError, ValueError):
        try:
            text = json.dumps(
                {"id": payload.get("id"), "status": "error", "message": "unserializable response"}
            )
        except (TypeError, ValueError):
            return
    sys.__stdout__.write(text + "\n")
    sys.__stdout__.flush()


def _utf8_len(text):
    """Byte length for buffer accounting. surrogatepass keeps lone
    surrogates (agent printing weird data) from crashing the task."""
    return len(text.encode("utf-8", "surrogatepass"))


class LineBuffer:
    """Thread-safe bounded ring buffer of (stream, line) tuples.

    Bounded by line count AND total bytes; lines longer than MAX_LINE_CHARS
    are split into multiple entries so one huge print cannot blow memory.
    """

    def __init__(self, maxlen=MAX_LINES, max_bytes=MAX_BYTES, max_line=MAX_LINE_CHARS):
        self._buf = collections.deque()
        self._maxlen = maxlen
        self._max_bytes = max_bytes
        self._max_line = max_line
        self._bytes = 0
        self._lock = threading.Lock()
        self.dropped = 0
        # Lifetime totals (pre-eviction): the true output size even when the
        # ring already dropped the oldest entries.
        self.total_bytes = 0
        self.total_lines = 0

    def _push(self, stream, text, size=None):
        if size is None:
            size = _utf8_len(text)
        if len(self._buf) >= self._maxlen:
            old = self._buf.popleft()
            self._bytes -= _utf8_len(old[1])
            self.dropped += 1
        self._buf.append((stream, text))
        self._bytes += size
        while self._bytes > self._max_bytes and len(self._buf) > 1:
            old = self._buf.popleft()
            self._bytes -= _utf8_len(old[1])
            self.dropped += 1

    def append(self, stream, text):
        self.total_lines += 1
        encoded_len = _utf8_len(text)
        self.total_bytes += encoded_len
        with self._lock:
            if len(text) <= self._max_line:
                self._push(stream, text, encoded_len)
                return
            while len(text) > self._max_line:
                self._push(stream, text[: self._max_line] + " [line split]")
                text = text[self._max_line :]
            self._push(stream, text)

    def snapshot(self):
        with self._lock:
            return list(self._buf), self.dropped


class StreamWriter(io.TextIOBase):
    """File-like object routing writes into a LineBuffer, split per line.

    User code may print from several threads at once, so the pending
    fragment is guarded by a lock.
    """

    def __init__(self, buffer, stream):
        self._buffer = buffer
        self._stream = stream
        self._pending = ""
        self._lock = threading.Lock()

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        with self._lock:
            data = self._pending + text
            parts = data.split("\n")
            self._pending = parts.pop()
            for part in parts:
                self._buffer.append(self._stream, part)
        return len(text)

    def flush(self):
        with self._lock:
            if self._pending:
                self._buffer.append(self._stream, self._pending)
                self._pending = ""


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
        self.peak_start = _peak_rss_bytes()
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


class ReplServer:
    def __init__(self):
        self.namespace = {"__name__": "__repl__", "__doc__": None}
        self.exec_count = 0
        self.tasks = {}
        self.task_order = collections.deque()
        self.lock = threading.Lock()
        self.inbox: queue.Queue = queue.Queue()
        self.limits = _apply_limits()
        # Spawn generation: _wait_for pumps the inbox, so a second execute
        # can dispatch nested while the outer one is still waiting. Every
        # spawn bumps this; an execute that waited (preempt) must re-check
        # it before spawning, otherwise two workers would run at once.
        self._spawn_epoch = 0
        # Orphan sink: late output from user-spawned background threads lands
        # here instead of the protocol stream. sys.stdout/sys.stderr always
        # point at these writers when no task is running; protocol responses
        # bypass them via sys.__stdout__.
        self.orphan_buffer = LineBuffer()
        self.orphan_out = StreamWriter(self.orphan_buffer, "stdout")
        self.orphan_err = StreamWriter(self.orphan_buffer, "stderr")
        # Watermark for the orphan hint: responses only advertise orphan lines
        # that arrived since the last report, so the hint is not repeated.
        self.orphan_reported = 0
        sys.stdout, sys.stderr = self.orphan_out, self.orphan_err

    def _register(self, task):
        with self.lock:
            self.tasks[task.task_id] = task
            self.task_order.append(task.task_id)
            while len(self.task_order) > RECENT_TASKS:
                old = self.task_order.popleft()
                if old != task.task_id:
                    self.tasks.pop(old, None)

    def _get_task(self, task_id):
        with self.lock:
            return self.tasks.get(task_id)

    def _running_task(self):
        with self.lock:
            for task in self.tasks.values():
                if task.status == "running":
                    return task
        return None

    def _run_task(self, task):
        out = StreamWriter(task.buffer, "stdout")
        err = StreamWriter(task.buffer, "stderr")
        sys.stdout, sys.stderr = out, err
        if _CPU_CLOCK is not None:
            try:
                task.cpu_start = _CPU_CLOCK()
            except Exception:
                task.cpu_start = None
        if _USE_TRACEMALLOC_PEAK or _USE_TRACEMALLOC_ALLOC:
            try:
                _tracemalloc.reset_peak()
                task.tm_start = _tracemalloc.get_traced_memory()[0]
            except Exception:
                task.tm_start = None
        try:
            try:
                node = ast.parse(task.code, mode="exec")
            except SyntaxError:
                with task.lock:
                    task.error = {
                        "type": "SyntaxError",
                        "message": str(sys.exc_info()[1]),
                        "traceback": traceback.format_exc(),
                    }
                task.finish("error")
                return
            if node.body and isinstance(node.body[-1], ast.Expr):
                last = node.body[-1]
                body = node.body[:-1]
                if body:
                    module = ast.Module(body=body, type_ignores=[])
                    exec(compile(module, "<repl>", "exec"), self.namespace)  # executing code is this server's purpose
                expr = ast.Expression(body=last.value)
                value = eval(compile(expr, "<repl>", "eval"), self.namespace)
                try:
                    task.result = repr(value)
                except Exception:  # arbitrary __repr__ may raise anything; keep the value anyway
                    task.result = f"<repr failed: {type(value).__name__}>"
                task.has_result = True
            else:
                exec(compile(node, "<repl>", "exec"), self.namespace)  # executing code is this server's purpose
            task.finish("done")
        except _TaskKill:
            with task.lock:
                task.error = {
                    "type": "_TaskKill",
                    "message": "task killed by pyrepl interrupt",
                    "traceback": traceback.format_exc(),
                }
            task.finish("interrupted")
        except KeyboardInterrupt:
            with task.lock:
                task.error = {
                    "type": "KeyboardInterrupt",
                    "message": "execution interrupted",
                    "traceback": traceback.format_exc(),
                }
            task.finish("interrupted")
        except BaseException:  # user code must never kill the session
            with task.lock:
                task.error = {
                    "type": type(sys.exc_info()[1]).__name__,
                    "message": str(sys.exc_info()[1]),
                    "traceback": traceback.format_exc(),
                }
            task.finish("error")
        finally:
            try:
                out.flush()
                err.flush()
                sys.stdout, sys.stderr = self.orphan_out, self.orphan_err
                # Keep the full value server-side (up to the store cap);
                # truncation happens only at display time.
                if task.result is not None and len(task.result) > RESULT_MAX_STORE:
                    task.result = (
                        task.result[:RESULT_MAX_STORE]
                        + f"\n... [result store-truncated at {RESULT_MAX_STORE} chars]"
                    )
                    task.result_store_truncated = True
            finally:
                self._finalize_metrics(task)
                # An interrupt landing inside this cleanup must not leave the
                # task stuck: never report running once the thread is gone.
                with task.lock:
                    if task.status == "running":
                        task.status = "interrupted"
                        if task.ended is None:
                            task.ended = time.monotonic()
                task.done.set()

    def _finalize_metrics(self, task):
        """Snapshot per-task cpu/alloc/peak-rss/namespace size. Never raises."""
        try:
            if task.cpu_start is not None and _CPU_CLOCK is not None:
                task.cpu_ms = round((_CPU_CLOCK() - task.cpu_start) * 1000, 1)
        except Exception:
            task.cpu_ms = None
        try:
            if task.tm_start is not None:
                current, peak = _tracemalloc.get_traced_memory()
                if _USE_TRACEMALLOC_ALLOC:
                    task.alloc_bytes = current - task.tm_start
                if _USE_TRACEMALLOC_PEAK:
                    task.peak_growth_bytes = peak - task.tm_start
            if task.peak_growth_bytes is None and task.peak_start is not None:
                peak_end = _peak_rss_bytes()
                if peak_end is not None:
                    task.peak_growth_bytes = peak_end - task.peak_start
        except Exception:
            task.alloc_bytes = None
            task.peak_growth_bytes = None
        try:
            task.vars = len(self.namespace)
        except Exception:
            task.vars = None

    def _proc_snapshot(self):
        """Process-wide counters for the status view. Never raises."""
        snap = {"vars": len(self.namespace)}
        try:
            if _CPU_CLOCK is not None and hasattr(time, "process_time"):
                snap["cpu_total_ms"] = int(time.process_time() * 1000)
        except Exception:
            pass
        current = _current_rss_bytes()
        if current is not None:
            snap["rss_bytes"] = current
        peak = _peak_rss_bytes()
        if peak is not None:
            snap["peak_rss_bytes"] = peak
        elif _USE_TRACEMALLOC_PEAK:
            try:
                snap["rss_bytes"] = _tracemalloc.get_traced_memory()[0]
            except Exception:
                pass
        return snap

    def _reader_loop(self):
        # A dedicated thread owns the blocking stdin read, so the main thread
        # can always drain the inbox - including mid-wait - on any platform.
        # select() on pipes does not work on Windows; this does.
        stdin = sys.__stdin__
        while True:
            try:
                line = stdin.readline()
            except (OSError, ValueError):
                line = ""
            self.inbox.put(line)
            if not line:
                return

    def _handle_line(self, line):
        """Dispatch one input line. Returns False when the server should exit."""
        if not line:
            return False
        line = line.strip()
        if not line:
            return True
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _respond({"id": None, "status": "error", "message": f"bad json: {exc}"})
            return True
        _respond(self.dispatch(req))
        return True

    def _pump_pending(self):
        """Dispatch all queued requests without blocking.

        Lets the server answer read/interrupt/reset while a long task runs.
        Returns True if at least one request was handled.
        """
        handled = False
        while True:
            try:
                line = self.inbox.get_nowait()
            except queue.Empty:
                return handled
            handled = True
            if not self._handle_line(line):
                raise SystemExit(0)

    def _wait_for(self, task, timeout_s):
        """Wait for a task while staying responsive to new requests."""
        deadline = time.monotonic() + max(0, timeout_s)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            if task.done.wait(timeout=min(0.1, remaining)):
                return True
            _check_mem_warn(task)
            self._pump_pending()

    def _answer_inflight(self, req, task):
        """Best-effort response for a request abandoned by shutdown/EOF.

        _pump_pending raises SystemExit when EOF lands mid-wait; without
        this, the in-flight execute/interrupt would never get a response
        and the client would hang until its own timeout.
        """
        try:
            if task.done.is_set():
                body = self._task_payload(task, include_lines=True)
            else:
                body = {
                    "status": "running",
                    "task_id": task.task_id,
                    "n": task.n,
                    "message": "server is shutting down; the task will not complete",
                }
            body["id"] = req.get("id")
            _respond(body)
        except OSError:
            pass  # output pipe already gone; exiting anyway

    def handle_execute(self, req):
        code = req.get("code", "")
        task_id = req.get("task_id") or f"t_{self.exec_count + 1}"
        wait_ms = req.get("wait_ms", 30000)
        preempt = bool(req.get("preempt", False))
        entry_epoch = self._spawn_epoch
        preempted = None
        running = self._running_task()
        if running is not None:
            if not preempt:
                return {
                    "status": "busy",
                    "task_id": running.task_id,
                    "message": "another task is running; read or interrupt it first",
                }
            err = self._inject_interrupt(running)
            if err is not None and err != "already finished":
                return {
                    "status": "preempt_failed",
                    "task_id": running.task_id,
                    "message": f"could not interrupt task {running.task_id}: {err}; re-init to respawn",
                }
            try:
                self._wait_for(running, INTERRUPT_WAIT_S)
            except SystemExit:
                self._answer_inflight(req, running)
                raise
            with running.lock:
                still_running = running.status == "running"
            if still_running:
                return {
                    "status": "preempt_failed",
                    "task_id": running.task_id,
                    "message": f"task {running.task_id} ignored the interrupt (native blocking call?); re-init to respawn",
                }
            preempted = {"task_id": running.task_id, "status": running.status}
        if self._spawn_epoch != entry_epoch:
            # A nested execute spawned while this one waited (preempt race
            # or recycled-id arrival): back off so only one worker runs.
            current = self._running_task()
            return {
                "status": "busy",
                "task_id": current.task_id if current is not None else task_id,
                "message": "another execute spawned while this one waited; retry",
            }
        self.exec_count += 1
        self._spawn_epoch += 1
        task = Task(task_id, code, self.exec_count)
        self._register(task)
        thread = threading.Thread(target=self._run_task, args=(task,), daemon=True)
        task.thread = thread
        thread.start()
        try:
            finished = self._wait_for(task, max(0, wait_ms) / 1000.0)
        except SystemExit:
            self._answer_inflight(req, task)
            raise
        if finished:
            payload = self._task_payload(task, include_lines=True)
            if preempted is not None:
                payload["preempted"] = preempted
            return payload
        payload = {
            "status": "running",
            "task_id": task.task_id,
            "n": task.n,
            "message": "still running; use read to poll or interrupt to stop",
        }
        if preempted is not None:
            payload["preempted"] = preempted
        return payload

    @staticmethod
    def _preview_result(result):
        """Head+tail preview so the end (END-MARKERs, final errors) survives."""
        head = RESULT_MAX_CHARS * 5 // 8
        tail = RESULT_MAX_CHARS - head
        if len(result) <= head + tail:
            return result, False
        omitted = len(result) - head - tail
        return (
            result[:head]
            + f"\n... [{omitted} chars omitted, END follows] ...\n"
            + result[-tail:],
            True,
        )

    def _task_payload(self, task, include_lines=False, offset=0, limit=200):
        lines, dropped = task.buffer.snapshot()
        ended = task.ended if task.ended is not None else time.monotonic()
        payload = {
            "status": task.status,
            "task_id": task.task_id,
            "n": task.n,
            "truncated_lines": dropped,
            "done": task.status != "running",
            "elapsed_ms": round((ended - task.started) * 1000, 1),
            "output_bytes": task.buffer.total_bytes,
            "output_lines": task.buffer.total_lines,
            "mem_limit_mb": self.limits["mem_limit_mb"],
        }
        if task.cpu_ms is not None:
            payload["cpu_ms"] = task.cpu_ms
        if task.alloc_bytes is not None:
            payload["alloc_bytes"] = task.alloc_bytes
        if task.peak_growth_bytes is not None:
            payload["peak_growth_bytes"] = task.peak_growth_bytes
        if task.mem_warned is not None:
            payload["mem_warn"] = task.mem_warned
        if task.vars is not None:
            payload["vars"] = task.vars
        elif task.status == "running":
            try:
                payload["vars"] = len(self.namespace)
            except Exception:
                pass
        if task.has_result:
            preview, cut = self._preview_result(task.result)
            payload["result_preview"] = preview
            payload["result_chars"] = len(task.result)
            payload["result_truncated"] = cut or task.result_store_truncated
        orphan_lines, _ = self.orphan_buffer.snapshot()
        new_orphan = len(orphan_lines) - self.orphan_reported
        if new_orphan > 0:
            payload["orphan_new"] = new_orphan
            self.orphan_reported = len(orphan_lines)
        if task.error is not None:
            payload["error"] = task.error
        if include_lines:
            payload["lines"] = [
                {"stream": stream, "line": line}
                for stream, line in lines[offset : offset + limit]
            ]
            payload["line_count"] = len(lines)
        return payload

    def handle_read(self, req):
        task = self._get_task(req.get("task_id", ""))
        if task is None:
            return {"status": "not_found", "message": "unknown task_id"}
        target = req.get("target", "combined")
        grep = req.get("grep")
        pattern = None
        if grep:
            if len(grep) > MAX_GREP_CHARS:
                return {
                    "status": "error",
                    "message": f"grep pattern too long ({len(grep)} > {MAX_GREP_CHARS} chars)",
                }
            try:
                pattern = re.compile(grep)
            except re.error as exc:
                return {"status": "error", "message": f"invalid grep regex: {exc}"}
        if target == "result":
            full = task.result if task.has_result else None
            if full is not None and pattern is not None:
                full = "\n".join(line for line in full.split("\n") if pattern.search(line))
            payload = self._task_payload(task)
            payload["result_full"] = full
            return payload
        if target == "orphan":
            lines, dropped = self.orphan_buffer.snapshot()
        else:
            lines, dropped = task.buffer.snapshot()
        if target in ("stdout", "stderr"):
            lines = [(s, line) for s, line in lines if s == target]
        if pattern is not None:
            lines = [(s, line) for s, line in lines if pattern.search(line)]
        tail_lines = req.get("tail_lines")
        if tail_lines:
            lines = lines[-tail_lines:]
        else:
            try:
                offset = max(0, int(req.get("offset", 0) or 0))
            except (TypeError, ValueError):
                offset = 0
            try:
                limit = int(req.get("limit", 200) or 200)
            except (TypeError, ValueError):
                limit = 200
            limit = min(limit, 5000)
            if limit < 1:
                limit = 200
            lines = lines[offset : offset + limit]
        payload = self._task_payload(task)
        payload["lines"] = [{"stream": s, "line": line} for s, line in lines]
        payload["returned"] = len(lines)
        if target == "orphan":
            payload["orphan_truncated_lines"] = dropped
        return payload

    def _inject_interrupt(self, task):
        """Deliver _TaskKill to a running task thread.

        Returns None when the injection was delivered, else an error
        string ("already finished" means the task ended on its own).
        """
        with task.lock:
            if task.status != "running" or task.thread is None or not task.thread.is_alive():
                return "already finished"
            tid = task.thread.ident
            if tid is None:
                return "task thread has no ident yet"
            try:
                # c_ulong matches CPython's unsigned long thread id on
                # 64-bit Linux/macOS; guarded below for other platforms.
                # CPython-only: other interpreters lack pythonapi.
                # 3.14+ only accepts a class here; an instance raises
                # SystemError. The message is attached by the except
                # _TaskKill handler instead.
                res = ctypes.pythonapi.PyThreadState_SetAsyncExc(
                    ctypes.c_ulong(tid), ctypes.py_object(_TaskKill)
                )
            except (AttributeError, ctypes.ArgumentError, OverflowError, TypeError) as exc:
                return f"interrupt failed: {exc}"
            if res == 0:
                return "invalid thread id"
            if res > 1:
                ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(tid), None)
                return "failed to deliver interrupt to one thread"
            return None

    def handle_interrupt(self, req):
        task = self._get_task(req.get("task_id", ""))
        if task is None:
            return {"status": "not_found", "message": "unknown task_id"}
        err = self._inject_interrupt(task)
        if err == "already finished":
            payload = self._task_payload(task, include_lines=True)
            payload["message"] = "task already finished"
            return payload
        if err is not None:
            return {"status": "error", "message": err}
        try:
            wait_s = req.get("wait_s", INTERRUPT_WAIT_S)
            try:
                wait_s = float(wait_s)
                if not math.isfinite(wait_s):
                    raise ValueError
                wait_s = min(300, max(0, wait_s))
            except (TypeError, ValueError):
                wait_s = INTERRUPT_WAIT_S
            self._wait_for(task, wait_s)
        except SystemExit:
            self._answer_inflight(req, task)
            raise
        payload = self._task_payload(task, include_lines=True)
        return payload

    def handle_reset(self):
        running = self._running_task()
        if running is not None:
            return {
                "status": "busy",
                "task_id": running.task_id,
                "message": "cannot reset while a task is running; interrupt it first",
            }
        self.namespace = {"__name__": "__repl__", "__doc__": None}
        self.exec_count = 0
        # Task ids restart at t_1 alongside exec numbers, so drop the old
        # registry: pre-reset ids report not_found instead of wrong data.
        with self.lock:
            self.tasks.clear()
            self.task_order.clear()
        return {"status": "ok", "message": "namespace cleared"}

    def dispatch(self, req):
        op = req.get("op")
        req_id = req.get("id")
        try:
            if op == "ping":
                body = {
                    "status": "ok",
                    "version": VERSION,
                    "python": sys.version,
                    "limits": self.limits,
                    "proc": self._proc_snapshot(),
                }
            elif op == "execute":
                body = self.handle_execute(req)
            elif op == "read":
                body = self.handle_read(req)
            elif op == "interrupt":
                body = self.handle_interrupt(req)
            elif op == "reset":
                body = self.handle_reset()
            elif op == "list":
                with self.lock:
                    entries = []
                    for tid in self.task_order:
                        task = self.tasks.get(tid)
                        if task is None:
                            continue
                        entry = {
                            "task_id": tid,
                            "n": task.n,
                            "task_status": task.status,
                            "elapsed_ms": round(
                                ((task.ended if task.ended is not None else time.monotonic()) - task.started)
                                * 1000,
                                1,
                            ),
                            "output_lines": task.buffer.total_lines,
                            "output_bytes": task.buffer.total_bytes,
                        }
                        if task.error is not None:
                            entry["error_type"] = task.error.get("type")
                        entries.append(entry)
                    body = {
                        "status": "ok",
                        "tasks": entries,
                        "proc": self._proc_snapshot(),
                        "limits": self.limits,
                    }
            elif op == "shutdown":
                body = {"status": "ok"}
                body["id"] = req_id
                _respond(body)
                raise SystemExit(0)
            else:
                body = {"status": "error", "message": f"unknown op: {op!r}"}
        except SystemExit:
            raise
        except Exception as exc:  # protocol boundary must never crash
            body = {"status": "error", "message": f"server error: {exc}"}
        body["id"] = req_id
        return body

    def serve(self):
        threading.Thread(target=self._reader_loop, daemon=True).start()
        while True:
            line = self.inbox.get()
            if not self._handle_line(line):
                break


def main():
    ReplServer().serve()


if __name__ == "__main__":
    main()
