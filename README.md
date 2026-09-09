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
in place. Or install the bundled artifacts outright:

```sh
bun run deploy            # global: ~/.config/opencode/plugins/
bun src/install.ts --project   # project-local: ./.opencode/plugins/
bun src/install.ts --link      # symlink dist/ instead of copy (rebuild to update)
```

The installer builds `dist/` first (gitignored), then installs the two
bundled artifacts (`pyrepl.js` + `pyrepl.pyz`) as siblings. Restart
opencode so it picks up the `pyrepl_*` tools. No `npm install` needed;
the only runtime dependency (`@opencode-ai/plugin`) is provided by
opencode itself.

```sh
bun src/install.ts --init-config   # also write a commented pyrepl.jsonc template
bun src/install.ts --no-build      # install existing dist/ as-is (skip build)
```

## Config (`pyrepl.jsonc`, file-only)

All tuning lives in `pyrepl.jsonc` (JSON with comments); `PYREPL_*` env
vars are ignored. Resolution order per key: project
`<worktree|directory>/.opencode/pyrepl.jsonc` overrides global
`~/.config/opencode/pyrepl.jsonc` (or `$OPENCODE_CONFIG_DIR/pyrepl.jsonc`),
which overrides built-in defaults. Missing files are fine.

```jsonc
{
  "python": null,         // interpreter; null = auto (.venv, then python3)
  "timeout_s": 30,        // per-exec wait; the task keeps running after it
  "wait_grace_ms": 15000,
  "rpc_timeout_ms": 15000,
  "preview_lines": 100, "preview_head": 1000, "preview_tail": 2500,
  "notify_agent": true,   // wake the agent when a background task finishes
  "notify_poll_ms": 5000, "notify_progress_s": 0,  // 0 = off
  "max_lines": 5000, "max_bytes": 1000000, "max_line_chars": 10000,
  "max_grep_chars": 500, "result_max_chars": 4000, "result_max_store": 1000000,
  "recent_tasks": 20, "interrupt_wait_s": 5,
  "max_mem_mb": 4096,     // 0 = off; overuse raises MemoryError in the task
  "max_cpu_s": 0,         // 0 = off; overuse kills the server (respawned fresh)
  "max_nproc": 0,         // 0 = off; UID-wide anti fork-bomb cap
  "mem_warn_pct": 80      // warn-only past this % of max_mem_mb, 0 = off
}
```

TS-side knobs (`timeout_s`, `preview_*`, `notify_*`) apply live;
engine knobs (`max_*`, `mem_*`, `recent_tasks`, `interrupt_wait_s`)
apply at server boot. The TS side reads the files and injects the
engine knobs into the subprocess; the engine itself never reads files.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `pyrepl_init` | Pick an interpreter (`bin_path`, else `python` in `pyrepl.jsonc`, `.venv`, `python3`). Optional; `exec` auto-initializes. |
| `pyrepl_exec` | Run code. `reset: true` wipes state and runs in one step. `preempt: true` interrupts the running task first, then runs. `progress_s` sends interim still-running notices. Long runs return a `task_id` instead of blocking. |
| `pyrepl_read` | Poll a running task or page truncated output (`offset`/`limit`, `grep`, `tail_lines`, targets `stdout/stderr/combined/result/orphan`). |
| `pyrepl_status` | Show live session state (`task_id` drills into one task; `limit`/`filter` opt into task history, otherwise live info only). |
| `pyrepl_interrupt` | Stop a running task (`wait_s` bounds the wait), keep the session. |

The first `exec` of a session notes it is fresh (state is new and dies with
opencode). Timeouts never kill: the task keeps running until read or
interrupted. When a background task finishes, the agent is automatically
notified in its own session with the result, so it wakes up on its own
instead of polling (disable via `notify_agent` in `pyrepl.jsonc`).

## How it works

`src/server.ts` (bundled to `dist/pyrepl.js`) owns one engine subprocess
per opencode session: `dist/pyrepl.pyz` in prod, `src/pyrepl/` package
(or its `pyrepl_server.py` shim) in dev. The engine is stdlib-only and
speaks newline-delimited JSON over stdio (`ping`, `execute`, `read`,
`list`, `interrupt`, `reset`, `shutdown`); responses carry the request
`id`. Source layout: `src/config|types|rpc|session|format|notify.ts`,
`src/tools/*.ts` assembled by `src/plugin.ts`;
`src/pyrepl/{config,metrics,buffers,tasks,protocol,server}.py`.

## Limits

- No sandbox: code runs as your user. No state across opencode restarts.
- Single-flight: one task per session at a time. A second `exec` returns
  `busy` (retry after `read`/`interrupt`, or `exec` with `preempt: true`).
- Resource caps (Unix only, reported as unenforced elsewhere):
  `max_mem_mb` via `RLIMIT_AS` (overuse raises `MemoryError` in the
  task, the session survives), `max_cpu_s` via `RLIMIT_CPU`
  (overuse kills the server; the next call respawns fresh), `max_nproc`
  via `RLIMIT_NPROC` (UID-wide anti fork-bomb, off by default; a cap below
  ambient usage is refused with a reason instead of breaking boot).
  CPU accounting is process-lifetime cumulative, not per task.
  Past `mem_warn_pct` (default 80%) of the mem cap the task output
  carries a `[warn: ...]` line; warn-only, never kills.
- Every task output ends with a machine-readable resource line
  (`[resources: wall=..ms cpu=..ms alloc=+.. peak=+..MB/4096MB vars=..]`);
  `alloc` is net Python bytes (negative = freed, misses native allocs),
  fields are omitted where the platform cannot measure them.
- No magics, no inline plots (`Agg` + save-to-file), no `input()`/`pdb`.
- `interrupt` injects a private `_TaskKill` exception (escapes
  `except KeyboardInterrupt`, unlike SIGINT); Python-level loops die at once,
  native calls (e.g. `time.sleep`) take effect when they return, and calls
  that never return need a respawn.

## Development

```sh
bun run typecheck   # tsc --noEmit (typescript is a devDependency)
bun run build       # dist/pyrepl.js (bun bundle) + dist/pyrepl.pyz (zipapp)
bun run deploy      # build + install to ~/.config/opencode/plugins/
bun test tests/     # bun:test suites (protocol/tools/config fast, slow every run)
ruff check src/     # Python lint (rule set pinned in ruff.toml)
```
