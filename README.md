# opencode-pyrepl-plugin

Local opencode plugin giving the agent a stateful Python REPL. Variables,
imports and functions survive across calls, so the agent can iterate like a
notebook instead of re-running everything from scratch.

> Note: developed with Bun, runtime is Node-compatible (only `node:` built-ins, no Bun APIs).

## Install

Via opencode config (`opencode.json`), no copy needed:

```json
{ "plugin": ["file:///path/to/opencode-pyrepl"] }
```

opencode resolves the package entry (`exports["./server"]`) and loads it
in place. Or copy the runtime files outright:

```sh
bun run deploy            # global: ~/.config/opencode/plugins/
bun src/install.ts --project   # project-local: ./.opencode/plugins/
bun src/install.ts --link      # symlink instead of copy (tracks this repo)
```

Both runtime files (`pyrepl.ts` + `pyrepl_server.py`) are installed as
siblings. Restart opencode so it picks up the `pyrepl_*` tools. No `npm
install` needed; the only runtime dependency (`@opencode-ai/plugin`) is
provided by opencode itself.

Env knobs (all optional): `PYREPL_PYTHON`, `PYREPL_TIMEOUT_S`,
`PYREPL_WAIT_GRACE_MS`, `PYREPL_RPC_TIMEOUT_MS`, `PYREPL_PREVIEW_LINES`,
`PYREPL_PREVIEW_HEAD`, `PYREPL_PREVIEW_TAIL`, `PYREPL_MAX_LINES`,
`PYREPL_MAX_BYTES`, `PYREPL_MAX_LINE_CHARS`, `PYREPL_MAX_GREP_CHARS`,
`PYREPL_RESULT_MAX_CHARS`, `PYREPL_RESULT_MAX_STORE`, `PYREPL_RECENT_TASKS`,
`PYREPL_INTERRUPT_WAIT_S`, `PYREPL_NOTIFY_AGENT`, `PYREPL_NOTIFY_POLL_MS`,
`PYREPL_MAX_MEM_MB` (default 4096, 0 = off), `PYREPL_MAX_CPU_S` (default 0 = off).

## Tools

| Tool | Purpose |
| ---- | ------- |
| `pyrepl_init` | Pick an interpreter (`bin_path`, else `PYREPL_PYTHON`, `.venv`, `python3`). Optional; `exec` auto-initializes. |
| `pyrepl_exec` | Run code. `reset: true` wipes state and runs in one step. `preempt: true` interrupts the running task first, then runs. Long runs return a `task_id` instead of blocking. |
| `pyrepl_read` | Poll a running task or page truncated output (`offset`/`limit`, `grep`, `tail_lines`, targets `stdout/stderr/combined/result/orphan`). |
| `pyrepl_status` | Show session state: interpreter, exec count, resource limits, process counters, running task and recent tasks. |
| `pyrepl_interrupt` | Stop a running task, keep the session. |

The first `exec` of a session notes it is fresh (state is new and dies with
opencode). Timeouts never kill: the task keeps running until read or
interrupted. When a background task finishes, the agent is automatically
notified in its own session with the result, so it wakes up on its own
instead of polling (`PYREPL_NOTIFY_AGENT=0` disables this).

## How it works

`src/pyrepl.ts` (Bun) owns one `src/pyrepl_server.py` subprocess (stdlib
only, NDJSON over stdio) per opencode session. The server speaks
newline-delimited JSON (`ping`, `execute`, `read`, `list`, `interrupt`,
`reset`, `shutdown`); responses carry the request `id`.

## Limits

- No sandbox: code runs as your user. No state across opencode restarts.
- Single-flight: one task per session at a time. A second `exec` returns
  `busy` (retry after `read`/`interrupt`, or `exec` with `preempt: true`).
- Resource caps (Unix only, reported as unenforced elsewhere):
  `PYREPL_MAX_MEM_MB` via `RLIMIT_AS` (overuse raises `MemoryError` in the
  task, the session survives), `PYREPL_MAX_CPU_S` via `RLIMIT_CPU`
  (overuse kills the server; the next call respawns fresh). CPU accounting
  is process-lifetime cumulative, not per task.
- Every task output ends with a machine-readable resource line
  (`[resources: wall=..ms cpu=..ms peak=+..MB/4096MB vars=..]`); fields are
  omitted where the platform cannot measure them.
- No magics, no inline plots (`Agg` + save-to-file), no `input()`/`pdb`.
- `interrupt` stops Python-level loops instantly; stuck native calls
  (e.g. `time.sleep`) need a respawn.

## Development

```sh
bun run typecheck   # tsc --noEmit (typescript is a devDependency)
bun run deploy      # install to ~/.config/opencode/plugins/
ruff check src/     # Python lint (rule set pinned in ruff.toml)
```
