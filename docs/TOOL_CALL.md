# pyrepl Tool Calls

Stateful Python REPL. Variables, imports, and functions survive across
calls. The first `pyrepl_exec` starts the session automatically; state is
lost when opencode closes.

Rules that apply to all tools:

- One task runs at a time. A second `exec` returns `busy`; use
  `pyrepl_read` or `pyrepl_interrupt` first, or `exec` with `preempt`.
- End code with a bare expression to see its value; print sparingly.
- Finished tasks keep their value, not their printed lines.

## pyrepl_init

Choose the Python interpreter. Optional; `exec` auto-detects when skipped.

| Param | Default | Description |
| ----- | ------- | ----------- |
| `bin_path` | `python` in config, then `.venv`, then `python3` | e.g. `/usr/bin/python3` or `<proj>/.venv/bin/python` |

Same interpreter keeps state. Switching wipes state and is refused while
a task runs.

## pyrepl_exec

Run Python code.

| Param | Default | Description |
| ----- | ------- | ----------- |
| `code` | required | Python source to run. |
| `reset` | `false` | Clear all state first, then run as the first task. |
| `timeout_s` | `30` | How long to wait before `on_timeout` applies. |
| `on_timeout` | `"interrupt"` | `interrupt` stops the task with partial output; `detach` leaves it running and notifies you when done. |
| `preempt` | `false` | Stop the running task first, then run this code. |
| `progress_s` | off | Still-running notice every N seconds. |

Long tasks return `task t_N`; poll with `pyrepl_read` or wait for the
auto-notify.

## pyrepl_read

Read a task's output or value.

| Param | Default | Description |
| ----- | ------- | ----------- |
| `task_id` | required | e.g. `t_3`. |
| `target` | `"combined"` | `combined`, `stdout`, `stderr`, `result` (full value), or `orphan` (late background output). |
| `offset` / `limit` | `0` / `200` | Page through lines. |
| `tail_lines` | off | Last N lines only. |
| `grep` | off | Regex filter on lines. |

## pyrepl_status

Health check, no params. Shows interpreter, working directory, uptime,
memory, and whether a task is running.

## pyrepl_tasks

List recent tasks. Includes a short variable list.

| Param | Default | Description |
| ----- | ------- | ----------- |
| `task_id` | off | Show one task only. |
| `limit` | `10` | How many recent tasks to show. |
| `filter` | `"all"` | `all`, `running`, or `failed`. |

## pyrepl_vars

Inspect variables. Read-only.

| Param | Default | Description |
| ----- | ------- | ----------- |
| `pattern` | off | Regex on names, e.g. `^df`. |
| `limit` | `200` | Max entries. |
| `sort` | `"name"` | `name` or `size` (largest first). |
| `name` | off | Full value of one variable (up to 100 KB). |

## pyrepl_interrupt

Stop a running task. The session survives.

| Param | Default | Description |
| ----- | ------- | ----------- |
| `task_id` | required | Running task id. |
| `wait_s` | `5` | How long to wait for it to stop. |
| `mode` | `"cooperative"` | `kill` restarts the whole server (wipes state); use only when cooperative reports the task still running. |

## Examples

```text
pyrepl_exec(code="import math\nmath.sqrt(2)")
pyrepl_exec(code="x = 41 + 1\nx")
pyrepl_exec(code="import time\ntime.sleep(120)", timeout_s=5, on_timeout="detach")
pyrepl_read(task_id="t_3", tail_lines=20)
pyrepl_vars(pattern="^df", sort="size")
```
