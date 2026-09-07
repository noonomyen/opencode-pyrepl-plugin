# opencode-pyrepl-plugin

Local opencode plugin giving the agent a stateful Python REPL. Variables,
imports and functions survive across calls, so the agent can iterate like a
notebook instead of re-running everything from scratch.

> Note: implemented and tested on the Bun runtime. The TypeScript side uses
> Bun APIs (`Bun.spawn`, `Bun.FileSink`); running under plain Node.js is not
> supported.

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
`PYREPL_WAIT_GRACE_MS`, `PYREPL_PREVIEW_LINES`, `PYREPL_PREVIEW_HEAD`,
`PYREPL_PREVIEW_TAIL`, `PYREPL_MAX_LINES`, `PYREPL_MAX_BYTES`,
`PYREPL_MAX_LINE_CHARS`, `PYREPL_RESULT_MAX_CHARS`, `PYREPL_RESULT_MAX_STORE`,
`PYREPL_RECENT_TASKS`.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `pyrepl_init` | Pick an interpreter (`bin_path`, else `PYREPL_PYTHON`, `.venv`, `python3`). Optional; `exec` auto-initializes. |
| `pyrepl_exec` | Run code. `reset: true` wipes state and runs in one step. Long runs return a `task_id` instead of blocking. |
| `pyrepl_read` | Poll a running task or page truncated output (`offset`/`limit`, `grep`, `tail_lines`, targets `stdout/stderr/combined/result/orphan`). |
| `pyrepl_status` | Show session state without executing code: interpreter, exec count, running and recent tasks. |
| `pyrepl_interrupt` | Stop a running task, keep the session. |

The first `exec` of a session notes it is fresh (state is new and dies with
opencode). Timeouts never kill: the task keeps running until read or
interrupted.

## How it works

`src/pyrepl.ts` (Bun) owns one `src/pyrepl_server.py` subprocess (stdlib
only, NDJSON over stdio) per opencode session. The server speaks
newline-delimited JSON (`ping`, `execute`, `read`, `list`, `interrupt`,
`reset`, `shutdown`); responses carry the request `id`.

## Limits

- No sandbox: code runs as your user. No state across opencode restarts.
- No magics, no inline plots (`Agg` + save-to-file), no `input()`/`pdb`.
- `interrupt` stops Python-level loops instantly; stuck native calls
  (e.g. `time.sleep`) need a respawn.
