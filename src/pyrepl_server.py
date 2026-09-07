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
import os
import queue
import re
import sys
import threading
import time
import traceback

VERSION = "0.1.0"


def _env_int(name, fallback):
    try:
        value = int(os.environ.get(name, "").strip() or fallback)
    except ValueError:
        return fallback
    return value if value > 0 else fallback


MAX_LINES = _env_int("PYREPL_MAX_LINES", 5000)
MAX_BYTES = _env_int("PYREPL_MAX_BYTES", 1000000)
MAX_LINE_CHARS = _env_int("PYREPL_MAX_LINE_CHARS", 10000)
MAX_GREP_CHARS = _env_int("PYREPL_MAX_GREP_CHARS", 500)
RESULT_MAX_CHARS = _env_int("PYREPL_RESULT_MAX_CHARS", 4000)
RESULT_MAX_STORE = _env_int("PYREPL_RESULT_MAX_STORE", 1000000)
RECENT_TASKS = _env_int("PYREPL_RECENT_TASKS", 20)


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

    def _push(self, stream, text):
        size = len(text.encode("utf-8"))
        if len(self._buf) >= self._maxlen:
            old = self._buf.popleft()
            self._bytes -= len(old[1].encode("utf-8"))
            self.dropped += 1
        self._buf.append((stream, text))
        self._bytes += size
        while self._bytes > self._max_bytes and len(self._buf) > 1:
            old = self._buf.popleft()
            self._bytes -= len(old[1].encode("utf-8"))
            self.dropped += 1

    def append(self, stream, text):
        with self._lock:
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
        # Guards status/thread-identity checks so interrupt() can never
        # inject into a recycled thread. The worker sets its terminal status
        # under this lock before exiting; interrupt() only injects while the
        # task still reports running under the same lock.
        self.mu = threading.Lock()


class ReplServer:
    def __init__(self):
        self.namespace = {"__name__": "__repl__", "__doc__": None}
        self.exec_count = 0
        self.tasks = {}
        self.task_order = collections.deque()
        self.lock = threading.Lock()
        self.inbox: queue.Queue = queue.Queue()
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
        try:
            try:
                node = ast.parse(task.code, mode="exec")
            except SyntaxError:
                with task.mu:
                    task.error = {
                        "type": "SyntaxError",
                        "message": str(sys.exc_info()[1]),
                        "traceback": traceback.format_exc(),
                    }
                    task.status = "error"
                return
            if node.body and isinstance(node.body[-1], ast.Expr):
                last = node.body[-1]
                body = node.body[:-1]
                if body:
                    module = ast.Module(body=body, type_ignores=[])
                    exec(compile(module, "<repl>", "exec"), self.namespace)  # noqa: S102
                expr = ast.Expression(body=last.value)
                value = eval(compile(expr, "<repl>", "eval"), self.namespace)
                try:
                    task.result = repr(value)
                except Exception:  # noqa: BLE001 -- arbitrary __repr__ may raise anything
                    task.result = f"<repr failed: {type(value).__name__}>"
                task.has_result = True
            else:
                exec(compile(node, "<repl>", "exec"), self.namespace)  # noqa: S102
            with task.mu:
                task.status = "done"
        except KeyboardInterrupt:
            with task.mu:
                task.error = {
                    "type": "KeyboardInterrupt",
                    "message": "execution interrupted",
                    "traceback": traceback.format_exc(),
                }
                task.status = "interrupted"
        except BaseException:  # noqa: BLE001 -- user code must never kill the session
            with task.mu:
                task.error = {
                    "type": type(sys.exc_info()[1]).__name__,
                    "message": str(sys.exc_info()[1]),
                    "traceback": traceback.format_exc(),
                }
                task.status = "error"
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
                # An interrupt landing inside this cleanup must not leave the
                # task stuck: never report running once the thread is gone.
                with task.mu:
                    if task.status == "running":
                        task.status = "interrupted"
                task.done.set()

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
            self._pump_pending()

    def handle_execute(self, req):
        code = req.get("code", "")
        task_id = req.get("task_id") or f"t_{self.exec_count + 1}"
        wait_ms = req.get("wait_ms", 30000)
        running = self._running_task()
        if running is not None:
            return {
                "status": "busy",
                "task_id": running.task_id,
                "message": "another task is running; read or interrupt it first",
            }
        self.exec_count += 1
        task = Task(task_id, code, self.exec_count)
        self._register(task)
        thread = threading.Thread(target=self._run_task, args=(task,), daemon=True)
        task.thread = thread
        thread.start()
        if self._wait_for(task, max(0, wait_ms) / 1000.0):
            return self._task_payload(task, include_lines=True)
        return {
            "status": "running",
            "task_id": task.task_id,
            "n": task.n,
            "message": "still running; use read to poll or interrupt to stop",
        }

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
        payload = {
            "status": task.status,
            "task_id": task.task_id,
            "n": task.n,
            "truncated_lines": dropped,
            "done": task.status != "running",
        }
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
                full = "\n".join(l for l in full.split("\n") if pattern.search(l))
            payload = self._task_payload(task)
            payload["result_full"] = full
            return payload
        if target == "orphan":
            lines, dropped = self.orphan_buffer.snapshot()
        else:
            lines, dropped = task.buffer.snapshot()
        if target in ("stdout", "stderr"):
            lines = [(s, l) for s, l in lines if s == target]
        if pattern is not None:
            lines = [(s, l) for s, l in lines if pattern.search(l)]
        tail_lines = req.get("tail_lines")
        if tail_lines:
            lines = lines[-tail_lines:]
        else:
            offset = req.get("offset", 0) or 0
            limit = req.get("limit", 200) or 200
            lines = lines[offset : offset + limit]
        payload = self._task_payload(task)
        payload["lines"] = [{"stream": s, "line": l} for s, l in lines]
        payload["returned"] = len(lines)
        if target == "orphan":
            payload["orphan_truncated_lines"] = dropped
        return payload

    def handle_interrupt(self, req):
        task = self._get_task(req.get("task_id", ""))
        if task is None:
            return {"status": "not_found", "message": "unknown task_id"}
        with task.mu:
            if task.status != "running" or task.thread is None or not task.thread.is_alive():
                finished = True
            else:
                finished = False
                tid = task.thread.ident
                if tid is None:
                    return {"status": "error", "message": "task thread has no ident yet"}
                try:
                    # c_ulong matches CPython's unsigned long thread id on
                    # 64-bit Linux/macOS; guarded below for other platforms.
                    res = ctypes.pythonapi.PyThreadState_SetAsyncExc(
                        ctypes.c_ulong(tid), ctypes.py_object(KeyboardInterrupt)
                    )
                except (ctypes.ArgumentError, OverflowError, TypeError) as exc:
                    return {"status": "error", "message": f"interrupt failed: {exc}"}
                if res == 0:
                    return {"status": "error", "message": "invalid thread id"}
                if res > 1:
                    ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(tid), None)
                    return {
                        "status": "error",
                        "message": "failed to deliver interrupt to one thread",
                    }
        if finished:
            payload = self._task_payload(task, include_lines=True)
            payload["message"] = "task already finished"
            return payload
        self._wait_for(task, 5.0)
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
                body = {"status": "ok", "version": VERSION, "python": sys.version}
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
                    body = {
                        "status": "ok",
                        "tasks": [
                            {
                                "task_id": tid,
                                "n": self.tasks[tid].n,
                                "task_status": self.tasks[tid].status,
                            }
                            for tid in self.task_order
                            if tid in self.tasks
                        ],
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
        except Exception as exc:  # noqa: BLE001 -- protocol boundary must never crash
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
