import type { ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadMergedConfig } from "../config.ts"
import { contextRoots, ensureSession, resolveBin, sessions } from "../session.ts"
import { GUIDE, type ToolDeps } from "./common.ts"

export function createInitTool(_deps: ToolDeps) {
  return tool({
    description:
      "Initialize the persistent Python REPL for this session with a chosen interpreter. Optional; pyrepl_exec auto-initializes with auto-detected python if you skip this. Use when you need a specific venv or global python (like VSCode interpreter picker). WARNING: init with a different interpreter kills any running task immediately and all state is lost." +
      GUIDE,
    args: {
      bin_path: tool.schema
        .string()
        .optional()
        .describe(
          'Python interpreter path, e.g. /usr/bin/python3 or /proj/.venv/bin/python. If omitted: pyrepl.jsonc "python", then .venv in worktree/directory, then python3.',
        ),
    },
    async execute(args, context: ToolContext) {
      context.metadata({ title: "pyrepl init" })
      const key = context.sessionID
      const loaded = await loadMergedConfig(context)
      const bin = await resolveBin(args.bin_path ?? undefined, context, loaded.config)
      const existing = sessions.get(key)
      if (existing && !existing.dead && existing.bin === bin) {
        existing.config = loaded.config
        existing.roots = contextRoots(context)
        return `REPL already running on ${bin} (${existing.version}). State preserved, exec count ${existing.execCount}.`
      }
      const { session } = await ensureSession(key, bin, context, loaded)
      return `REPL ready on ${session.bin} (${session.version}). First pyrepl_exec will note it is a fresh session. State is lost when opencode closes.`
    },
  })
}
