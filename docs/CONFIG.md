# pyrepl Configuration

All settings live in `pyrepl.jsonc` (JSON with comments). `PYREPL_*`
environment variables are ignored.

## Where the file lives

- Global: `~/.config/opencode/pyrepl.jsonc`
  (`$OPENCODE_CONFIG_DIR/pyrepl.jsonc` when that dir is set).
- Project: `<worktree>/.opencode/pyrepl.jsonc` or
  `<directory>/.opencode/pyrepl.jsonc` (overrides global, per key).

Missing files are fine; defaults apply. Create a template with:

```sh
bun src/install.ts --init-config
```

## Common settings

| Key | Default | Description |
| --- | ------- | ----------- |
| `python` | `null` (auto) | Interpreter path. Auto means `.venv` in worktree/directory, then `python3`. |
| `timeout_s` | `60` | Per-exec wait before `on_timeout` applies. |
| `on_timeout` | `"interrupt"` | `interrupt` stops the task; `detach` leaves it running and notifies on completion. |
| `notify_agent` | `true` | Notify you in-session when a background task finishes. `false` means poll manually. |
| `preview_lines` / `preview_head` / `preview_tail` | `100` / `1000` / `2500` | Output preview size. |

These apply immediately; no restart needed.

## Limits and engine settings

These apply when the session starts; restart opencode (or respawn via
`mode=kill`) to pick up changes.

| Key | Default | Description |
| --- | ------- | ----------- |
| `max_lines` / `max_bytes` | `5000` / `1000000` | Output kept per running task. |
| `result_max_chars` / `result_max_store` | `4000` / `1000000` | Expression value preview / stored size. |
| `recent_tasks` | `20` | How many past tasks are remembered. |
| `max_mem_mb` | `4096` | `0` = off. Overuse raises `MemoryError` in the task. Unix only. |
| `max_cpu_s` | `0` | `0` = off. Overuse restarts the server (state lost). Unix only. |
| `max_nproc` | `0` | `0` = off. Fork-bomb guard. Unix only. |
| `mem_warn_pct` | `80` | Warn-only threshold; `0` = off. |

Advanced timing knobs (`wait_grace_ms`, `rpc_timeout_ms`,
`notify_poll_ms`, `interrupt_wait_s`, `max_line_chars`,
`max_grep_chars`) keep their defaults unless you have a reason to tune.

## Full template

```jsonc
{
  "python": null,
  "timeout_s": 60,
  "on_timeout": "interrupt",
  "wait_grace_ms": 15000,
  "rpc_timeout_ms": 15000,
  "preview_lines": 100,
  "preview_head": 1000,
  "preview_tail": 2500,
  "notify_agent": true,
  "notify_poll_ms": 5000,
  "max_lines": 5000,
  "max_bytes": 1000000,
  "max_line_chars": 10000,
  "max_grep_chars": 500,
  "result_max_chars": 4000,
  "result_max_store": 1000000,
  "recent_tasks": 20,
  "interrupt_wait_s": 5,
  "max_mem_mb": 4096,
  "max_cpu_s": 0,
  "max_nproc": 0,
  "mem_warn_pct": 80
}
```
