import type { Plugin } from "@opencode-ai/plugin"
import { loadMergedConfig } from "./config.ts"
import { extractSessionId, flushPendingNotify } from "./notify.ts"
import { killSession } from "./rpc.ts"
import { pendingNotify, sessions } from "./session.ts"
import { createExecTool } from "./tools/exec.ts"
import { createInitTool } from "./tools/init.ts"
import { createInterruptTool } from "./tools/interrupt.ts"
import { createReadTool } from "./tools/read.ts"
import { createStatusTool } from "./tools/status.ts"
import { createTasksTool } from "./tools/tasks.ts"
import { createVarsTool } from "./tools/vars.ts"
import type { NotifyClient } from "./types.ts"

export const PyReplPlugin: Plugin = async (ctx) => {
  const client = (ctx?.client ?? null) as NotifyClient | null
  const deps = { client }
  return {
    event: async (input: { event: unknown }) => {
      const event = input.event as { type?: string; properties?: Record<string, any> }
      if (event?.type === "session.deleted") {
        const id = extractSessionId(event.properties ?? {})
        if (id === undefined) return
        const session = sessions.get(id)
        if (session) {
          killSession(session)
          sessions.delete(id)
        }
        pendingNotify.delete(id)
        return
      }
      // Retry wake-up prompts that failed while the session was busy.
      if (event?.type !== "session.idle" || client === null) return
      const id = extractSessionId(event.properties ?? {})
      if (id === undefined) return
      // Event path has no ToolContext, but the live session remembers the
      // discovery roots from spawn, so the check honors the same merged
      // file config the exec path used (not global-only).
      const session = sessions.get(id)
      if (!session) return
      const cfg = (await loadMergedConfig(session.roots)).config
      if (!cfg.notify_agent) return
      await flushPendingNotify(client, id)
    },
    tool: {
      pyrepl_init: createInitTool(deps),
      pyrepl_exec: createExecTool(deps),
      pyrepl_read: createReadTool(deps),
      pyrepl_status: createStatusTool(deps),
      pyrepl_tasks: createTasksTool(deps),
      pyrepl_vars: createVarsTool(deps),
      pyrepl_interrupt: createInterruptTool(deps),
    },
  }
}
