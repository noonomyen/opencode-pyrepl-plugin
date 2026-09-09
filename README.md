# opencode-pyrepl-plugin

Stateful Python REPL plugin for opencode. One Python subprocess per
opencode session; variables, imports, and functions survive across calls,
so the agent can iterate like a notebook instead of re-running everything
from scratch.

> Note: this repo is driven by AI behind the scenes. The codebase may
> change drastically between versions; read the docs in this repo rather
> than assuming past behavior.

## What for

- Iterative data work: define once, call many times across turns.
- Long-running tasks: detach, get notified on completion, read the value.
- Session inspection: check health, list tasks, inspect variables.

## Install

Requirements: Bun and Python 3.

Point opencode at this repo (no copy needed):

```json
{ "plugin": ["file:///path/to/opencode-pyrepl-plugin"] }
```

Or install the bundled artifacts (`pyrepl.js` + `pyrepl.pyz`):

```sh
bun run deploy                 # build + install globally
bun src/install.ts --project   # project-local: ./.opencode/plugins/
bun src/install.ts --link      # symlink dist/ instead of copy (rebuild to update)
bun src/install.ts --init-config  # also write a commented pyrepl.jsonc template
```

Restart opencode so it picks up the `pyrepl_*` tools. No `npm install`
needed; `@opencode-ai/plugin` is provided by opencode itself.

## Build

```sh
bun run build       # dist/pyrepl.js + dist/pyrepl.pyz
bun run build:js    # JS bundle only
bun run build:py    # Python zipapp only
```

Checks before sending changes:

```sh
bun run typecheck   # tsc --noEmit
bun run lint        # ruff check src/
bun test tests/     # full suite (fast + slow)
bun run test:fast   # protocol/tools/config/dist
```

## Docs

- [docs/TOOL_CALL.md](docs/TOOL_CALL.md) - tools, params, examples.
- [docs/CONFIG.md](docs/CONFIG.md) - `pyrepl.jsonc` locations and settings.

Config is file-only (`pyrepl.jsonc`); `PYREPL_*` env vars are ignored.
