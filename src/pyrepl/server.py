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
import json
import math
import queue
import re
import sys
import threading
import time
import traceback

from . import VERSION
from . import config
from . import metrics
from .buffers import LineBuffer, StreamWriter
from .protocol import _respond
from .tasks import _TaskKill, Task


class ReplServer:
    def __init__(self):
        self.namespace = {"__name__": "__repl__", "__doc__": None}
        self.exec_count = 0
        self.tasks = {}
        self.task_order = collections.deque()
        self.lock = threading.Lock()
        self.inbox: queue.Queue = queue.Queue()
        self.limits = metrics._apply_limits()
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
            while len(self.task_order) > config.RECENT_TASKS:
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
        if metrics._CPU_CLOCK is not None:
            try:
                task.cpu_start = metrics._CPU_CLOCK()
            except Exception:
                task.cpu_start = None
        if metrics._USE_TRACEMALLOC_PEAK or metrics._USE_TRACEMALLOC_ALLOC:
            try:
                metrics._tracemalloc.reset_peak()
                task.tm_start = metrics._tracemalloc.get_traced_memory()[0]
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
                if task.result is not None and len(task.result) > config.RESULT_MAX_STORE:
                    task.result = (
                        task.result[: config.RESULT_MAX_STORE]
                        + f"\n... [result store-truncated at {config.RESULT_MAX_STORE} chars]"
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
            if task.cpu_start is not None and metrics._CPU_CLOCK is not None:
                task.cpu_ms = round((metrics._CPU_CLOCK() - task.cpu_start) * 1000, 1)
        except Exception:
            task.cpu_ms = None
        try:
            if task.tm_start is not None:
                current, peak = metrics._tracemalloc.get_traced_memory()
                if metrics._USE_TRACEMALLOC_ALLOC:
                    task.alloc_bytes = current - task.tm_start
                if metrics._USE_TRACEMALLOC_PEAK:
                    task.peak_growth_bytes = peak - task.tm_start
            if task.peak_growth_bytes is None and task.peak_start is not None:
                peak_end = metrics._peak_rss_bytes()
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
            if metrics._CPU_CLOCK is not None and hasattr(time, "process_time"):
                snap["cpu_total_ms"] = int(time.process_time() * 1000)
        except Exception:
            pass
        current = metrics._current_rss_bytes()
        if current is not None:
            snap["rss_bytes"] = current
        peak = metrics._peak_rss_bytes()
        if peak is not None:
            snap["peak_rss_bytes"] = peak
        elif metrics._USE_TRACEMALLOC_PEAK:
            try:
                snap["rss_bytes"] = metrics._tracemalloc.get_traced_memory()[0]
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
            metrics._check_mem_warn(task)
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
                self._wait_for(running, config.INTERRUPT_WAIT_S)
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
        head = config.RESULT_MAX_CHARS * 5 // 8
        tail = config.RESULT_MAX_CHARS - head
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
        # Monotone watermark, deliberately NOT per-task: counts orphan lines
        # since the last payload that reported any, so a read for task A can
        # consume the hint for output that arrived during task B. Every
        # report points at target=orphan, where the full buffer is readable.
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
            if len(grep) > config.MAX_GREP_CHARS:
                return {
                    "status": "error",
                    "message": f"grep pattern too long ({len(grep)} > {config.MAX_GREP_CHARS} chars)",
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
            wait_s = req.get("wait_s", config.INTERRUPT_WAIT_S)
            try:
                wait_s = float(wait_s)
                if not math.isfinite(wait_s):
                    raise ValueError
                wait_s = min(300, max(0, wait_s))
            except (TypeError, ValueError):
                wait_s = config.INTERRUPT_WAIT_S
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
