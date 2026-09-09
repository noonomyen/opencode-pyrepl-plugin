import type { ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadMergedConfig } from "../config.ts"
import {
  formatErrorLines,
  formatOutputPreview,
  formatResources,
  formatWarn,
} from "../format.ts"
import { killSession, rpc } from "../rpc.ts"
import { sessions } from "../session.ts"
import { GUIDE, clampWaitS, type ToolDeps } from "./common.ts"

export function createInterruptTool(_deps: ToolDeps) {
  return tool({
    description:
      "Interrupt a running REPL task (signals plus an uncatchable-by-KeyboardInterrupt exception; sleeps, locks, subprocess waits and plain loops die). Returns partial output. The session survives; only that task stops. mode=kill instead SIGKILLs the whole server: all state is wiped and the next exec respawns fresh. Use kill when cooperative reports the task still running (signal-immune code like except-BaseException loops)." +
      GUIDE,
    args: {
      task_id: tool.schema.string().describe("Running task id from pyrepl_exec."),
      wait_s: tool.schema
        .number()
        .optional()
        .describe("Seconds to wait for the task to stop after injection (default 5). Longer for tasks with heavy cleanup."),
      mode: tool.schema
        .enum(["cooperative", "kill"])
        .optional()
        .describe('How to stop it (default cooperative). "kill" SIGKILLs the whole server when cooperative fails: wipes all state.'),
    },
    async execute(args, context: ToolContext) {
      context.metadata({ title: `pyrepl interrupt ${args.task_id}` })
      const session = sessions.get(context.sessionID)
      if (!session || session.dead) return `no REPL session active (task ${args.task_id} unknown)`
      session.config = (await loadMergedConfig(context)).config
      const res = await rpc(
        session,
        {
          op: "interrupt",
          task_id: args.task_id,
          wait_s: clampWaitS(args.wait_s),
          mode: args.mode ?? "cooperative",
        },
        session.config.rpc_timeout_ms,
      )
      if (res?.status === "not_found") return `unknown task ${args.task_id}`
      if (res?.status === "error") return `interrupt error: ${res.message ?? "unknown"}; re-init via pyrepl_init with the same bin_path to respawn`
      if (args.mode === "kill" && res?.task_id) {
        // Kill only wipes when it actually killed: a finished task answers
        // without SIGKILL ("already finished; nothing to kill"), and wiping
        // that healthy session would trash the namespace for nothing.
        if (res.status !== "not_found" && !res.message?.includes("already finished")) {
          // The server is SIGKILLed and cannot report its own death: drop
          // it here, otherwise the next exec races the process-exit event
          // and reuses the dying session (pipe-data always precedes exit
          // events).
          killSession(session)
          sessions.delete(context.sessionID)
        }
      }
      // The agent is present and got the partial output inline; no
      // wake-up needed if the waiter has not fired yet.
      if (res?.task_id) session.consumed.add(res.task_id)
      const out: string[] = [`task ${res.task_id}: ${res.status}`]
      if (res.message) out.push(res.message)
      if (res.status === "running") {
        out.push("[interrupt pending: task ignores signals and _TaskKill; retry with mode=kill or re-init to respawn]")
      }
      out.push(
        ...formatOutputPreview(
          res,
          "partial output",
          `... [preview truncated, use pyrepl_read with task_id=${res.task_id}]`,
          false,
          session.config,
        ),
      )
      out.push(...formatErrorLines(res, false))
      out.push(...formatWarn(res))
      out.push(formatResources(res))
      return out.join("\n")
    },
  })
}
