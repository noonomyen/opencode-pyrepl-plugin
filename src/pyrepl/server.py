"""Persistent stdlib-only Python REPL server speaking NDJSON over stdio.

One OS process hosts exactly one REPL session (one namespace). The opencode
plugin spawns one server per opencode session and multiplexes tasks through
the protocol below. No third-party dependencies.

Protocol: each stdin line is one JSON request, each stdout line is one JSON
response. Responses are written to the real stdout (sys.__stdout__) so they
are never captured into a task output buffer.

Requests:
  {"id": 1, "op": "ping"}
  {"id": 2, "op": "execute", "task_id": "t_1", "code": "x = 1", "wait_ms": 30000,
   "on_timeout": "interrupt" | "detach"}
  {"id": 3, "op": "read", "task_id": "t_1", "offset": 0, "limit": 200,
   "target": "combined", "grep": null, "tail_lines": null}
  {"id": 4, "op": "interrupt", "task_id": "t_1", "wait_s": 5, "mode": "cooperative" | "kill"}
  {"id": 5, "op": "reset"}
  {"id": 6, "op": "list"}
  {"id": 7, "op": "vars", "pattern": null, "limit": 200, "sort": "name", "name": null}
  {"id": 8, "op": "shutdown"}

Responses always carry the request "id".

Output retention: per-task rings hold up to MAX_LINES/MAX_BYTES while the
task runs. Lines are DROPPED at the first terminal observation (completion
payload built, then buffer cleared): finished tasks keep result, error,
totals and metadata only. Late background-thread output lands in the
process-wide orphan ring (ORPHAN_MAX_*), readable via target=orphan.

Threading model: user code always runs on the MAIN thread so OS signals
reach it (like ipykernel). A dispatcher thread owns stdin RPCs and answers
read/list/interrupt/reset/vars immediately, even mid-task; waits (execute
timeout, interrupt grace, preempt grace) are waiter records polled by the
dispatcher event loop, never nested dispatches. Interrupt is one dual shot
per attempt: a private _TaskKill via SetAsyncExc (bytecode level, escapes
except KeyboardInterrupt) plus SIGINT to the main thread (syscalls like
time.sleep), plus process-group SIGINT (the task's own child subprocesses,
so no orphaned `sleep` stays behind). Deliberately no re-arming: a pending
async exc firing inside a lock acquisition leaks the lock with no __exit__,
deadlocking both threads silently. Code swallowing the one shot (except
BaseException loops, signal-immune C calls) is reported via the ladder
message and still needs a respawn (interrupt mode=kill, or re-init).
"""

import ast
import collections
import ctypes
import json
import math
import os
import queue
import re
import signal
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

# Event-loop tick: bounds RPC latency mid-task and mem-warn granularity.
_TICK_S = 0.05
# Phase-2 delay: arm _TaskKill only if the task outlived phase-1 signals by
# this long. Gives signal trips time to be consumed-or-irrelevant first, so
# the armed async never races a signal break (see _arm_taskkill).
ASYNC_DELAY_S = 0.2
# pthread_kill lets the dispatcher signal the MAIN thread precisely
# (process-directed kill() could land anywhere). Absent on Windows, where
# interrupt degrades to _TaskKill only.
_HAVE_PTHREAD_KILL = hasattr(signal, "pthread_kill")
# User code compiles under this filename (see _run_task), so engine frames
# are recognizable and strippable from user-facing tracebacks.
_USER_FILENAME = "<repl>"


def _format_user_traceback(exc):
    """Traceback with engine frames stripped (no local paths leak).

    User code runs inside _run_task, so format_exc() would prefix every
    error with File ".../server.py" frames. Keep only user frames;
    exceptions raised before any user frame runs (e.g. SyntaxError at
    parse time) fall back to the exception line alone. Never raises.
    """
    try:
        entries = [e for e in traceback.extract_tb(exc.__traceback__) if e.filename == _USER_FILENAME]
        if not entries:
            return "".join(traceback.format_exception_only(type(exc), exc))
        out = ["Traceback (most recent call last):\n"]
        out.extend(traceback.format_list(entries))
        out.extend(traceback.format_exception_only(type(exc), exc))
        return "".join(out)
    except Exception:
        try:
            return traceback.format_exc()
        except Exception:
            return f"{type(exc).__name__}: {exc}"


class ReplServer:
    def __init__(self):
        self.namespace = {"__name__": "__repl__", "__doc__": None}
        self.exec_count = 0
        self.tasks = {}
        self.task_order = collections.deque()
        self.lock = threading.Lock()
        self.inbox: queue.Queue = queue.Queue()
        self.limits = metrics._apply_limits()
        self.booted = time.monotonic()
        # Handoff to the executor (the main thread). At most one item is
        # ever queued: single-flight is enforced at dispatch, so a queued
        # task always means the executor is about to pick it up.
        self.work: queue.Queue = queue.Queue()
        # Task currently executing on the main thread (dispatcher reads it;
        # claimed at spawn, cleared by the executor; benign GIL-atomic
        # race by design, guarded by conditional clear).
        self.current = None
        self.main_ident = None
        # Deferred replies polled by the dispatcher loop. Dispatcher-only
        # state, no lock needed. Kinds: "exec" | "preempt" | "interrupt" |
        # "timeout" (exec whose deadline passed under on_timeout=interrupt).
        self.waiters = []
        self._exiting = False
        # Own process group so interrupt can SIGINT the task's children too
        # (no orphaned `sleep` subprocesses). Skipped when unavailable: the
        # group would include the parent, which must never be signalled.
        self._own_pgid = None
        if hasattr(os, "setpgid") and hasattr(os, "killpg"):
            try:
                os.setpgid(0, 0)
                self._own_pgid = os.getpgrp()
            except Exception:
                self._own_pgid = None
        # SIGINT is our control plane: force the default handler even when
        # inherited as ignored (nohup/background shells). Without this every
        # pthread_kill/killpg SIGINT is eaten at kernel level and sleeps
        # become uninterruptible with zero diagnostics.
        try:
            if os.name == "posix":
                signal.signal(signal.SIGINT, signal.default_int_handler)
        except Exception:
            pass
        # Orphan sink: late output from user-spawned background threads lands
        # here instead of the protocol stream. sys.stdout/sys.stderr always
        # point at these writers when no task is running; protocol responses
        # bypass them via sys.__stdout__.
        self.orphan_buffer = LineBuffer(
            maxlen=config.ORPHAN_MAX_LINES, max_bytes=config.ORPHAN_MAX_BYTES
        )
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

    def _record_terminal(self, task, status, exc):
        """Record a terminal outcome, tolerating late spurious deliveries.

        Interrupt channels are one-shot each (one async arming, up to two
        SIGINTs per attempt), so only a bounded handful of deliveries can
        ever be in flight; each is consumed on delivery. Concurrent attempts
        on the same task (interrupt + preempt waiter) multiply that handful,
        hence the margin: bounded retries still terminate with full data in
        every realistic interleaving. Last resort keeps status without
        traceback rather than hanging or dying. Never raises.
        """
        for _ in range(6):
            try:
                task.error = {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": _format_user_traceback(exc),
                }
                task.finish(status)
                return
            except (_TaskKill, KeyboardInterrupt):
                continue
        try:
            task.finish(status)
        except (_TaskKill, KeyboardInterrupt):
            pass

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
            except SyntaxError as exc:
                self._record_terminal(task, "error", exc)
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
            task.completed_ok = True
            task.finish("done")
        except _TaskKill as exc:
            # A stale arming that lands exactly at natural completion must
            # not misreport a done task as killed.
            if task.completed_ok:
                task.finish("done")
            else:
                self._record_terminal(task, "interrupted", exc)
        except KeyboardInterrupt as exc:
            if task.completed_ok:
                task.finish("done")
            else:
                self._record_terminal(task, "interrupted", exc)
        except BaseException as exc:  # user code must never kill the session
            self._record_terminal(task, "error", exc)
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
                # task stuck: never report running once the executor is done
                # with it. Lock-free (see above): this is the last writer.
                if task.status == "running":
                    task.status = "interrupted"
                    if task.ended is None:
                        task.ended = time.monotonic()
                task.done.set()

    def _finalize_metrics(self, task):
        """Snapshot per-task cpu/alloc/peak-rss/namespace size. Never raises."""
        try:
            # Sole mem-warn evaluation point, at task completion: ru_maxrss
            # is monotonic, so end-of-task growth subsumes anything mid-run.
            # Deliberately not polled mid-run (by design the warn reports a
            # process hoarding data at task end), which also keeps delivery
            # independent of dispatcher tick timing under CPU starvation.
            # One-shot, same message. Never raises.
            metrics._check_mem_warn(task)
        except Exception:
            pass
        try:
            if task.cpu_start is not None and metrics._CPU_CLOCK is not None:
                task.cpu_ms = round((metrics._CPU_CLOCK() - task.cpu_start) * 1000, 1)
        except Exception:
            task.cpu_ms = None
        try:
            if task.tm_start is not None:
                current = metrics._tracemalloc.get_traced_memory()[0]
                if metrics._USE_TRACEMALLOC_ALLOC:
                    task.alloc_bytes = current - task.tm_start
            # Absolute current RSS at task end: answers "how much pressure
            # now", unlike growth deltas which saturate once HWM is high.
            # None where unmeasurable (Linux /proc only); omitted there.
            task.rss_bytes = metrics._current_rss_bytes()
        except Exception:
            task.alloc_bytes = None
            task.rss_bytes = None
        try:
            task.vars = sum(1 for k in self.namespace if not k.startswith("__"))
        except Exception:
            task.vars = None

    def _proc_snapshot(self):
        """Process-wide counters for the status (health) view. Never raises."""
        # User names only (no dunders): matches what list/vars show.
        try:
            snap = {"vars": sum(1 for k in self.namespace if not k.startswith("__"))}
        except Exception:
            snap = {"vars": len(self.namespace)}
        # PID for ps-matching (display only: stop via tools, never kill
        # directly, PIDs are shared across sessions). User code always runs
        # on the main thread, so no thread id is needed.
        try:
            snap["pid"] = os.getpid()
        except Exception:
            pass
        try:
            snap["cwd"] = os.getcwd()
        except Exception:
            pass
        try:
            snap["uptime_ms"] = int((time.monotonic() - self.booted) * 1000)
        except Exception:
            pass
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
        return snap

    def _executor_loop(self):
        """Main thread: run user tasks serially. A stray KeyboardInterrupt
        (a signal that outlived its target) is swallowed: only code running
        inside _run_task may turn it into task output. A stale _TaskKill
        arming (inject raced a natural finish) can also land out here: log
        it loudly and continue instead of dying silently."""
        while True:
            try:
                try:
                    task = self.work.get()
                except KeyboardInterrupt:
                    continue
                if task is None:
                    return
                try:
                    self._run_task(task)
                finally:
                    # Conditional: a successor may already have claimed ownership
                    # between our done.set() and this line; never clobber it.
                    if self.current is task:
                        self.current = None
            except (_TaskKill, KeyboardInterrupt) as exc:
                try:
                    sys.__stderr__.write(f"[pyrepl] stale {type(exc).__name__} outside task, ignored\n")
                    sys.__stderr__.flush()
                except Exception:
                    pass
                continue

    def _reader_loop(self):
        # A dedicated thread owns the blocking stdin read, so the dispatcher
        # event loop below stays portable where select() on pipes does not
        # work (Windows). EOF arrives here exactly once.
        stdin = sys.__stdin__
        while True:
            try:
                line = stdin.readline()
            except (OSError, ValueError):
                line = ""
            self.inbox.put(line)
            if not line:
                return

    def _dispatch_loop(self):
        # Belt and suspenders: a poisoned op must never silently kill this
        # loop (a dead dispatcher looks exactly like a hung server: no
        # responses, no shutdown, immune to stdin close). Unexpected errors
        # go to the REAL stderr (the orphan sink would swallow them).
        while not self._exiting:
            try:
                try:
                    line = self.inbox.get(timeout=_TICK_S)
                except queue.Empty:
                    pass
                else:
                    self._handle_line(line)
                self._poll_waiters()
            except Exception:
                try:
                    traceback.print_exc(file=sys.__stderr__)
                    sys.__stderr__.flush()
                except Exception:
                    pass

    def _handle_line(self, line):
        """Dispatch one input line. Empty line means EOF: shut down."""
        if not line:
            self._begin_shutdown()
            return
        line = line.strip()
        if not line:
            return
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _respond({"id": None, "status": "error", "message": f"bad json: {exc}"})
            return
        body = self.dispatch(req)
        if body is not None:
            _respond(body)

    def _poll_waiters(self):
        now = time.monotonic()
        watched = set()
        for waiter in list(self.waiters):
            task = waiter.get("task") or waiter.get("old")
            if task is not None:
                watched.add(task.task_id)
            kind = waiter["kind"]
            if kind == "exec":
                self._poll_exec_waiter(waiter, now)
            elif kind == "preempt":
                self._poll_preempt_waiter(waiter, now)
            elif kind == "interrupt":
                self._poll_interrupt_waiter(waiter, now)
            elif kind == "timeout":
                self._poll_timeout_waiter(waiter, now)
        # Detached tasks nobody watches: drop their lines once done, or a
        # forgotten background task pins its megabytes until eviction.
        with self.lock:
            unwatched = [
                task
                for tid, task in self.tasks.items()
                if task.done.is_set() and tid not in watched
            ]
        for task in unwatched:
            lines, _ = task.buffer.snapshot()
            if lines:
                task.buffer.clear()

    def _complete_lines(self, task):
        """Snapshot lines for a terminal observation, then drop them.

        Finished tasks keep result/error/totals/metadata only; the lines
        are unrecoverable after this point by design (bounded memory)."""
        lines, dropped = task.buffer.snapshot()
        task.buffer.clear()
        return lines, dropped

    def _poll_exec_waiter(self, waiter, now):
        task = waiter["task"]
        if task.done.is_set():
            lines, dropped = self._complete_lines(task)
            payload = self._task_payload(task, include_lines=True, _lines=(lines, dropped))
            if waiter["preempted"] is not None:
                payload["preempted"] = waiter["preempted"]
            self.waiters.remove(waiter)
            _respond({**payload, "id": waiter["req_id"]})
        elif now >= waiter["deadline"]:
            self.waiters.remove(waiter)
            if waiter.get("on_timeout", "interrupt") == "detach":
                _respond(
                    {
                        "status": "running",
                        "task_id": task.task_id,
                        "n": task.n,
                        "message": "still running; use read to poll or interrupt to stop",
                        **({"preempted": waiter["preempted"]} if waiter["preempted"] is not None else {}),
                        "id": waiter["req_id"],
                    }
                )
            else:
                # Timeout means interrupt: phase-1 signals now, async later
                # via the timeout waiter if the task survives.
                self._signal_task(task)
                self.waiters.append(
                    {
                        "kind": "timeout",
                        "task": task,
                        "deadline": time.monotonic() + config.INTERRUPT_WAIT_S,
                        "req_id": waiter["req_id"],
                        "preempted": waiter["preempted"],
                        "async_armed": False,
                        "signalled_at": time.monotonic(),
                    }
                )

    def _poll_timeout_waiter(self, waiter, now):
        task = waiter["task"]
        if task.done.is_set():
            lines, dropped = self._complete_lines(task)
            payload = self._task_payload(task, include_lines=True, _lines=(lines, dropped))
            if waiter["preempted"] is not None:
                payload["preempted"] = waiter["preempted"]
            self.waiters.remove(waiter)
            _respond({**payload, "id": waiter["req_id"]})
            return
        if now >= waiter["deadline"]:
            # Still running: snapshot WITHOUT clearing (the sweep drops it
            # once done). Clearing here would eat lines a later read needs.
            self.waiters.remove(waiter)
            lines, dropped = task.buffer.snapshot()
            payload = self._task_payload(task, include_lines=True, _lines=(lines, dropped))
            payload["message"] = (
                f"timeout fired and task {task.task_id} ignored the interrupt "
                "(swallows signals and _TaskKill, e.g. except BaseException loop?); "
                "interrupt with mode=kill or re-init to respawn"
            )
            if waiter["preempted"] is not None:
                payload["preempted"] = waiter["preempted"]
            _respond({**payload, "id": waiter["req_id"]})
            return
        self._maybe_phase2(waiter, now)

    def _poll_preempt_waiter(self, waiter, now):
        old = waiter["old"]
        with old.lock:
            still_running = old.status == "running"
            old_status = old.status
        if not still_running:
            # A sibling preempt may have already converted and spawned while
            # this one waited: never run two tasks at once, tell the loser
            # to retry instead (mirrors the old spawn-epoch busy reply).
            rival = self._running_task()
            if rival is not None:
                self.waiters.remove(waiter)
                _respond(
                    {
                        "status": "busy",
                        "task_id": rival.task_id,
                        "message": "another execute spawned while this one waited; retry",
                        "id": waiter["req_id"],
                    }
                )
                return
            preempted = {"task_id": old.task_id, "status": old_status}
            task = self._spawn_task(waiter["task_id"], waiter["code"])
            self.waiters.remove(waiter)
            self.waiters.append(
                {
                    "kind": "exec",
                    "task": task,
                    "deadline": time.monotonic() + waiter["new_wait_s"],
                    "req_id": waiter["req_id"],
                    "preempted": preempted,
                    "on_timeout": waiter.get("on_timeout", "interrupt"),
                }
            )
        elif now >= waiter["deadline"]:
            self.waiters.remove(waiter)
            _respond(
                {
                    "status": "preempt_failed",
                    "task_id": old.task_id,
                    "message": f"task {old.task_id} ignored the interrupt (swallows signals and _TaskKill, e.g. except BaseException loop?); re-init to respawn",
                    "id": waiter["req_id"],
                }
            )
        self._maybe_phase2(waiter, now)

    def _poll_interrupt_waiter(self, waiter, now):
        task = waiter["task"]
        if task.done.is_set():
            lines, dropped = self._complete_lines(task)
            self.waiters.remove(waiter)
            _respond(
                {**self._task_payload(task, include_lines=True, _lines=(lines, dropped)), "id": waiter["req_id"]}
            )
        elif now >= waiter["deadline"]:
            self.waiters.remove(waiter)
            lines, dropped = task.buffer.snapshot()
            _respond(
                {
                    **self._task_payload(task, include_lines=True, _lines=(lines, dropped)),
                    "id": waiter["req_id"],
                }
            )
            return
        self._maybe_phase2(waiter, now)

    def _begin_shutdown(self, detail="server is shutting down; the task will not complete"):
        """Answer in-flight waiters, stop the executor, break the loop."""
        if self._exiting:
            return
        self._exiting = True
        for waiter in list(self.waiters):
            kind = waiter["kind"]
            task = waiter.get("task") or waiter.get("old")
            if task is not None and task.done.is_set() and kind in ("exec", "timeout", "interrupt"):
                lines, dropped = self._complete_lines(task)
                payload = self._task_payload(task, include_lines=True, _lines=(lines, dropped))
                if waiter.get("preempted") is not None:
                    payload["preempted"] = waiter["preempted"]
            elif kind == "interrupt":
                payload = self._task_payload(task, include_lines=True)
            else:
                payload = {
                    "status": "running",
                    "task_id": task.task_id if task is not None else "?",
                    "n": task.n if task is not None else 0,
                    "message": detail,
                }
            _respond({**payload, "id": waiter["req_id"]})
        self.waiters.clear()
        self.work.put(None)
        # Break the executor out of user code promptly (a no-op when idle;
        # a stray SIGINT there is swallowed by the executor loop).
        self._signal_main()

    def _signal_main(self):
        """Best-effort SIGINT to the executor (main) thread. Never raises."""
        try:
            if _HAVE_PTHREAD_KILL and self.main_ident is not None:
                signal.pthread_kill(self.main_ident, signal.SIGINT)
        except Exception:
            pass

    def _kill_now(self, task, req_id):
        """Respond (to the killer first, then matching waiters) with the
        partial payload, then SIGKILL the process.

        State is wiped by design; the client respawns fresh on next use.
        Unrelated waiters die unanswered with the pipe (bounded client
        timeouts cover them)."""
        partial = self._task_payload(task, include_lines=True)
        partial["message"] = (
            f"task {task.task_id} killed with the whole server; all state lost. "
            "The next exec respawns fresh."
        )
        _respond({**partial, "id": req_id})
        for waiter in list(self.waiters):
            t = waiter.get("task") or waiter.get("old")
            if t is task:
                self.waiters.remove(waiter)
                _respond({**partial, "id": waiter["req_id"]})
        try:
            sys.__stdout__.flush()
        except Exception:
            pass
        # Own process group (we made ourselves leader at boot): one SIGKILL
        # takes self plus the task's child subprocesses, so kill leaves no
        # orphans behind. Falls back to self-only where killpg is missing.
        try:
            if self._own_pgid is not None and hasattr(os, "killpg"):
                os.killpg(self._own_pgid, signal.SIGKILL)
            else:
                os.kill(os.getpid(), signal.SIGKILL)
        except Exception:
            pass
        # Unreachable on POSIX; on platforms without SIGKILL semantics the
        # task keeps running and the caller sees the partial output above.

    def _spawn_task(self, task_id, code):
        self.exec_count += 1
        task = Task(task_id, code, self.exec_count)
        self._register(task)
        # Claim ownership BEFORE handing off: an interrupt arriving in the
        # same tick must see a running task, not a startup race.
        self.current = task
        self.work.put(task)
        return task

    def handle_execute(self, req):
        """Dispatches an execute: spawns immediately or defers via a waiter.
        Returns a response dict for an immediate reply, else None."""
        code = req.get("code", "")
        task_id = req.get("task_id") or f"t_{self.exec_count + 1}"
        wait_ms = req.get("wait_ms", 30000)
        preempt = bool(req.get("preempt", False))
        on_timeout = req.get("on_timeout", "interrupt")
        if on_timeout not in ("interrupt", "detach"):
            return {"status": "error", "message": f"bad on_timeout: {on_timeout!r}"}
        running = self._running_task()
        if running is not None:
            if not preempt:
                return {
                    "status": "busy",
                    "task_id": running.task_id,
                    "message": "another task is running; read or interrupt it first",
                }
            err = self._signal_task(running)
            if err is not None and err != "already finished":
                return {
                    "status": "preempt_failed",
                    "task_id": running.task_id,
                    "message": f"could not interrupt task {running.task_id}: {err}; re-init to respawn",
                }
            with running.lock:
                already_done = running.status != "running"
            if already_done:
                preempted = {"task_id": running.task_id, "status": running.status}
                task = self._spawn_task(task_id, code)
                self.waiters.append(
                    {
                        "kind": "exec",
                        "task": task,
                        "deadline": time.monotonic() + max(0, wait_ms) / 1000.0,
                        "req_id": req.get("id"),
                        "preempted": preempted,
                        "on_timeout": on_timeout,
                    }
                )
                return None
            self.waiters.append(
                {
                    "kind": "preempt",
                    "old": running,
                    "task_id": task_id,
                    "code": code,
                    "new_wait_s": max(0, wait_ms) / 1000.0,
                    "deadline": time.monotonic() + config.INTERRUPT_WAIT_S,
                    "req_id": req.get("id"),
                    "on_timeout": on_timeout,
                    "async_armed": False,
                    "signalled_at": time.monotonic(),
                }
            )
            return None
        task = self._spawn_task(task_id, code)
        self.waiters.append(
            {
                "kind": "exec",
                "task": task,
                "deadline": time.monotonic() + max(0, wait_ms) / 1000.0,
                "req_id": req.get("id"),
                "preempted": None,
                "on_timeout": on_timeout,
            }
        )
        return None

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

    def _task_payload(self, task, include_lines=False, offset=0, limit=200, _lines=None):
        if _lines is None:
            lines, dropped = task.buffer.snapshot()
        else:
            lines, dropped = _lines
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
        if task.rss_bytes is not None:
            payload["rss_bytes"] = task.rss_bytes
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
        # Monotone lifetime counter, not ring length: eviction keeps len()
        # flat at capacity while new lines arrive, which would report 0.
        new_orphan = self.orphan_buffer.total_lines - self.orphan_reported
        if new_orphan > 0:
            payload["orphan_new"] = new_orphan
            self.orphan_reported = self.orphan_buffer.total_lines
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
        # The orphan ring is process-wide, not per-task: readable any time,
        # even for finished tasks.
        if target == "orphan":
            lines, dropped = self.orphan_buffer.snapshot()
            if pattern is not None:
                lines = [(s, line) for s, line in lines if pattern.search(line)]
            tail_lines = req.get("tail_lines")
            if tail_lines:
                lines = lines[-tail_lines:]
            payload = self._task_payload(task)
            payload["lines"] = [{"stream": s, "line": line} for s, line in lines]
            payload["returned"] = len(lines)
            payload["orphan_truncated_lines"] = dropped
            return payload
        # Lines are dropped at the first terminal observation: finished
        # tasks expose result/totals/metadata only, never lines again.
        if task.status != "running":
            payload = self._task_payload(task)
            payload["lines"] = []
            payload["returned"] = 0
            payload["note"] = (
                "output lines were dropped when the task finished; "
                "totals and result (if any) above are still available"
            )
            return payload
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
        return payload

    def _inject_target(self, task):
        """Shared guard: only the live task on the executor may be touched.
        Returns the main thread id, or an "already finished"-style reason."""
        with task.lock:
            if task.status != "running" or self.current is not task:
                return None, "already finished"
            if self.main_ident is None:
                return None, "executor not started"
            return self.main_ident, None

    def _signal_task(self, task):
        """Phase 1: SIGINT to the executor thread plus the own process group
        (the task's child subprocesses die too instead of orphaning).

        Signals alone break syscalls (sleep/locks/sockets) but are catchable
        (except KeyboardInterrupt loops survive) and do nothing to pure C
        loops. No async arming here by design: see _arm_taskkill."""
        main_tid, err = self._inject_target(task)
        if err is not None:
            return err
        if not _HAVE_PTHREAD_KILL:
            return "signals unavailable on this platform"
        try:
            # Precise delivery to the executor thread (a process-directed
            # kill could land anywhere).
            signal.pthread_kill(main_tid, signal.SIGINT)
        except Exception as exc:
            return f"signal failed: {exc}"
        # Own process group only (we made ourselves leader at boot).
        if self._own_pgid is not None:
            try:
                os.killpg(self._own_pgid, signal.SIGINT)
            except Exception:
                pass
        return None

    def _arm_taskkill(self, task):
        """Phase 2 (only if still running ~ASYNC_DELAY_S after phase 1): arm
        _TaskKill via SetAsyncExc. Fires at the next bytecode the executor
        runs and escapes except KeyboardInterrupt.

        MUST run alone, never together with a fresh signal: an armed async
        firing inside an error-recording call setup aborts it (no error
        dict), and firing inside a lock acquisition leaks the lock (silent
        gridlock of both threads). The phase gap guarantees phase-1 trips
        are consumed-or-irrelevant first; a bounded retry helper absorbs the
        residual overlap. Returns None on delivery, else an error string."""
        main_tid, err = self._inject_target(task)
        if err is not None:
            return err
        try:
            # CPython-only: other interpreters lack pythonapi.
            # 3.14+ only accepts a class here; an instance raises
            # SystemError. The message is attached by the except
            # _TaskKill handler instead.
            res = ctypes.pythonapi.PyThreadState_SetAsyncExc(
                ctypes.c_ulong(main_tid), ctypes.py_object(_TaskKill)
            )
        except (AttributeError, ctypes.ArgumentError, OverflowError, TypeError) as exc:
            return f"interrupt failed: {exc}"
        if res == 0:
            return "invalid thread id"
        if res > 1:
            try:
                ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(main_tid), None)
            except Exception:
                pass
            return "failed to deliver interrupt to one thread"
        return None

    def _maybe_phase2(self, waiter, now):
        """Arm async once the task outlived phase 1 by ASYNC_DELAY_S."""
        if waiter.get("async_armed"):
            return
        if now - waiter.get("signalled_at", now) < ASYNC_DELAY_S:
            return
        task = waiter.get("task") or waiter.get("old")
        if task is None or task.done.is_set():
            return
        waiter["async_armed"] = True
        self._arm_taskkill(task)

    def handle_interrupt(self, req):
        """Interrupts a task: phase-1 signals now, async at +ASYNC_DELAY_S if
        still running, reply at done or grace. mode=kill SIGKILLs the whole
        server instead. Returns an immediate response only for settled
        outcomes, else None."""
        task = self._get_task(req.get("task_id", ""))
        if task is None:
            return {"status": "not_found", "message": "unknown task_id"}
        mode = req.get("mode", "cooperative")
        if mode not in ("cooperative", "kill"):
            return {"status": "error", "message": f"bad mode: {mode!r}"}
        if mode == "kill":
            with task.lock:
                running = task.status == "running"
            if not running:
                payload = self._task_payload(task, include_lines=True)
                payload["message"] = "task already finished; nothing to kill"
                return payload
            self._kill_now(task, req.get("id"))
            return None
        err = self._signal_task(task)
        if err == "already finished":
            payload = self._task_payload(task, include_lines=True)
            payload["message"] = "task already finished"
            return payload
        async_armed = False
        if err is not None:
            # No signals on this platform (e.g. Windows): fall back to the
            # async channel alone instead of failing outright. Pure-C loops
            # stay unkillable there, same as before this fallback.
            if "signals unavailable" not in err:
                return {"status": "error", "message": err}
            err = self._arm_taskkill(task)
            if err is not None:
                return {"status": "error", "message": err}
            async_armed = True
        wait_s = req.get("wait_s", config.INTERRUPT_WAIT_S)
        try:
            wait_s = float(wait_s)
            if not math.isfinite(wait_s):
                raise ValueError
            wait_s = min(300, max(0, wait_s))
        except (TypeError, ValueError):
            wait_s = config.INTERRUPT_WAIT_S
        self.waiters.append(
            {
                "kind": "interrupt",
                "task": task,
                "deadline": time.monotonic() + wait_s,
                "req_id": req.get("id"),
                "async_armed": async_armed,
                "signalled_at": time.monotonic(),
            }
        )
        return None

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

    def handle_vars(self, req):
        """List namespace entries (name/type/size/preview) or inspect one.

        Read-only and best-effort: every per-name probe is guarded so one
        hostile object (raising __repr__/__len__) cannot fail the listing.
        Sizes are shallow sys.getsizeof (an estimate for containers)."""
        pattern = None
        grep = req.get("pattern")
        if grep:
            if len(grep) > config.MAX_GREP_CHARS:
                return {
                    "status": "error",
                    "message": f"pattern too long ({len(grep)} > {config.MAX_GREP_CHARS} chars)",
                }
            try:
                pattern = re.compile(grep)
            except re.error as exc:
                return {"status": "error", "message": f"invalid pattern regex: {exc}"}
        try:
            limit = int(req.get("limit", 200) or 200)
        except (TypeError, ValueError):
            limit = 200
        limit = min(max(limit, 1), 5000)
        sort = req.get("sort", "name")
        if sort not in ("name", "size"):
            return {"status": "error", "message": f"bad sort: {sort!r}"}
        name = req.get("name")
        try:
            names = list(self.namespace)
        except Exception as exc:
            return {"status": "error", "message": f"cannot list namespace: {exc}"}
        if name is not None:
            names = [name] if name in self.namespace else []
        entries = []
        for var_name in names:
            if var_name != name and var_name.startswith("__") and pattern is None:
                continue
            if pattern is not None and not pattern.search(var_name):
                continue
            try:
                value = self.namespace[var_name]
            except Exception as exc:
                entries.append({"name": var_name, "type": "?", "size": None, "preview": f"<unreadable: {exc}>"})
                continue
            entries.append(self._describe_var(var_name, value))
        if sort == "size":
            entries.sort(key=lambda e: e["size"] if e["size"] is not None else -1, reverse=True)
        else:
            entries.sort(key=lambda e: e["name"])
        total = len(entries)
        entries = entries[:limit]
        body: dict = {"status": "ok", "count": total, "vars": entries}
        if total > limit:
            body["truncated"] = True
        if name is not None and entries:
            body["full"] = entries[0]["preview_full"]
        return body

    @staticmethod
    def _describe_var(var_name, value):
        """Describe one namespace entry. Never raises."""
        entry: dict = {"name": var_name, "type": "?", "size": None, "length": None, "preview": "?"}
        entry["type"] = type(value).__name__
        try:
            import sys as _sys

            entry["size"] = _sys.getsizeof(value)
        except Exception:
            pass
        for attr in ("shape", "dtype"):
            try:
                attr_value = getattr(value, attr)
                if attr == "shape" and isinstance(attr_value, tuple):
                    entry["length"] = f"shape={attr_value}"
                elif attr == "dtype":
                    entry["dtype"] = str(attr_value)
            except Exception:
                pass
        if entry["length"] is None:
            try:
                entry["length"] = len(value)
            except Exception:
                pass
        try:
            text = repr(value)
        except Exception:
            text = f"<repr failed: {type(value).__name__}>"
        if len(text) > 100000:
            text = text[:100000] + f"\n... [inspect truncated at 100000 chars, total {len(text)}]"
            entry["truncated"] = True
        entry["preview_full"] = text
        entry["preview"] = text if len(text) <= 200 else text[:200] + "..."
        return entry

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
                if body is None:
                    return None
            elif op == "read":
                body = self.handle_read(req)
            elif op == "interrupt":
                body = self.handle_interrupt(req)
                if body is None:
                    return None
            elif op == "reset":
                body = self.handle_reset()
            elif op == "vars":
                body = self.handle_vars(req)
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
                self._begin_shutdown()
                return None
            else:
                body = {"status": "error", "message": f"unknown op: {op!r}"}
        except Exception as exc:  # protocol boundary must never crash
            body = {"status": "error", "message": f"server error: {exc}"}
        body["id"] = req_id
        return body

    def serve(self):
        self.main_ident = threading.get_ident()
        # Unhandled thread exceptions must bypass the orphan sink (a dead
        # dispatcher with swallowed traceback looks exactly like a hang).
        def _loud_hook(args):
            try:
                traceback.print_exception(
                    args.exc_type, args.exc_value, args.exc_traceback, file=sys.__stderr__
                )
                sys.__stderr__.flush()
            except Exception:
                pass

        def _loud_main_hook(typ, val, tb):
            try:
                traceback.print_exception(typ, val, tb, file=sys.__stderr__)
                sys.__stderr__.flush()
            except Exception:
                pass

        threading.excepthook = _loud_hook
        sys.excepthook = _loud_main_hook
        threading.Thread(target=self._reader_loop, daemon=True).start()
        threading.Thread(target=self._dispatch_loop, daemon=True).start()
        self._executor_loop()


def main():
    ReplServer().serve()


if __name__ == "__main__":
    main()
