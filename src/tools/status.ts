import type { ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadMergedConfig } from "../config.ts"
import { formatLimitsLine, formatProcLine, formatTaskLine } from "../format.ts"
import { rpc } from "../rpc.ts"
import { sessions } from "../session.ts"
import type { TaskListResponse } from "../types.ts"
import { GUIDE, type ToolDeps } from "./common.ts"

export function createStatusTool(_deps: ToolDeps) {
  return tool({
    description:
      "Check the Python runtime is healthy without executing code: where it runs from (interpreter, cwd), uptime, memory vs caps, CPU appetite, namespace size, and any running task. Task history lives in pyrepl_tasks; variable listing in pyrepl_vars. Use to re-orient after compaction." +
      GUIDE,
    args: {},
    async execute(_args, context: ToolContext) {
      context.metadata({ title: "pyrepl status" })
      const session = sessions.get(context.sessionID)
      if (!session || session.dead) {
        return `no REPL session active. pyrepl_exec will auto-initialize one; sessions do not survive opencode restarts.`
      }
      session.config = (await loadMergedConfig(context)).config
      let list: TaskListResponse
      try {
        list = await rpc<TaskListResponse>(session, { op: "list" }, session.config.rpc_timeout_ms)
      } catch {
        return `REPL on ${session.bin} (${session.version}) is not responding. Re-run pyrepl_init to respawn.`
      }
      const proc = list?.proc
      const out = [
        `REPL on ${session.bin} (${session.version}), exec count ${session.execCount}` +
          (proc?.vars !== undefined ? `, vars=${proc.vars}` : ""),
        ...formatLimitsLine(list?.limits ?? session.limits),
        ...formatProcLine(proc),
      ]
      const running = (list?.tasks ?? []).filter((t) => t.task_status === "running")
      for (const t of running) out.push(`running: ${formatTaskLine(t, false)}`)
      if (running.length === 0) out.push("idle: no task running")
      return out.join("\n")
    },
  })
}
