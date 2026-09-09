import type { ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadMergedConfig } from "../config.ts"
import { rpc } from "../rpc.ts"
import { contextRoots, ensureSession, resolveBin, sessions } from "../session.ts"
import type { TaskListResponse } from "../types.ts"
import { GUIDE, type ToolDeps } from "./common.ts"

export function createInitTool(_deps: ToolDeps) {
  return tool({
    description:
      "Initialize the persistent Python REPL for this session with a chosen interpreter. Optional; pyrepl_exec auto-initializes with auto-detected python if you skip this. Use when you need a specific venv or global python (like VSCode interpreter picker). WARNING: init with a different interpreter wipes all state; refused while a task is running (interrupt it first)." +
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
      if (existing && !existing.dead) {
        // Different interpreter means a respawn that wipes everything:
        // refuse while a task runs instead of killing it silently. An
        // unresponsive server fails CLOSED (no wipe on unknown state).
        let runningId: string | null = null
        let responsive = false
        try {
          const list = await rpc<TaskListResponse>(existing, { op: "list" }, loaded.config.rpc_timeout_ms)
          responsive = true
          runningId = list?.tasks?.find((t) => t.task_status === "running")?.task_id ?? null
        } catch {
          responsive = false
        }
        if (!responsive) {
          return (
            `init refused: REPL on ${existing.bin} is not responding, state unknown; ` +
            `re-run pyrepl_init when it recovers, or start a new opencode session. ` +
            `Refusing to wipe blindly.`
          )
        }
        if (runningId) {
          return (
            `init refused: task ${runningId} is still running on ${existing.bin}; ` +
            `pyrepl_interrupt it first, then retry init (switching interpreter wipes all state).`
          )
        }
      }
      const { session } = await ensureSession(key, bin, context, loaded)
      return `REPL ready on ${session.bin} (${session.version}). First pyrepl_exec will note it is a fresh session. State is lost when opencode closes.`
    },
  })
}
