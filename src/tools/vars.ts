import type { ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadMergedConfig } from "../config.ts"
import { fmtSize } from "../format.ts"
import { rpc } from "../rpc.ts"
import { sessions } from "../session.ts"
import type { VarsEntry, VarsResponse } from "../types.ts"
import { GUIDE, type ToolDeps } from "./common.ts"

function formatVar(v: VarsEntry): string[] {
  const bits = [`${v.name}: ${v.type}`]
  if (typeof v.length === "number") bits.push(`len=${v.length}`)
  else if (typeof v.length === "string") bits.push(v.length)
  if (v.dtype) bits.push(`dtype=${v.dtype}`)
  // Sizes are shallow sys.getsizeof: exact for flat buffers, an estimate
  // for nested containers.
  if (typeof v.size === "number") bits.push(`~${fmtSize(v.size)}`)
  const out = [bits.join(" | ")]
  if (v.preview !== undefined) out.push(`  ${v.preview}`)
  return out
}

export function createVarsTool(_deps: ToolDeps) {
  return tool({
    description:
      "List namespace variables (name, type, length, approximate size, preview) or inspect one variable in full. Read-only: nothing is modified or deleted (use exec to change things, reset=true to wipe). Use to spot stale variables from earlier tasks before trusting a result." +
      GUIDE,
    args: {
      pattern: tool.schema
        .string()
        .optional()
        .describe("Regex filter on variable names (e.g. ^df). Omit to list all."),
      limit: tool.schema.number().optional().describe("Max entries to return (default 200)."),
      sort: tool.schema
        .enum(["name", "size"])
        .optional()
        .describe("Sort by name (default) or approximate size descending (finds memory hogs)."),
      name: tool.schema
        .string()
        .optional()
        .describe("Inspect one variable in full (repr up to 100KB)."),
    },
    async execute(args, context: ToolContext) {
      context.metadata({ title: "pyrepl vars" })
      const session = sessions.get(context.sessionID)
      if (!session || session.dead) {
        return `no REPL session active. pyrepl_exec will auto-initialize one; sessions do not survive opencode restarts.`
      }
      session.config = (await loadMergedConfig(context)).config
      const rawLimit = args.limit ?? 200
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 200
      let res: VarsResponse
      try {
        res = await rpc<VarsResponse>(
          session,
          {
            op: "vars",
            pattern: args.pattern ?? null,
            limit,
            sort: args.sort ?? "name",
            name: args.name ?? null,
          },
          session.config.rpc_timeout_ms,
        )
      } catch {
        return `REPL on ${session.bin} (${session.version}) is not responding. Re-run pyrepl_init to respawn.`
      }
      if (res?.status === "error") return `vars error: ${res.message ?? "unknown"}`
      const entries = res?.vars ?? []
      if (args.name) {
        if (entries.length === 0) return `unknown variable ${args.name}`
        const v = entries[0]
        const out = [...formatVar(v)]
        if (res.full !== undefined && res.full !== v.preview) out.push(res.full)
        if (v.truncated) out.push(`[inspect truncated at 100KB]`)
        return out.join("\n")
      }
      const out: string[] = [`vars (${res?.count ?? entries.length}):`]
      for (const v of entries) out.push(...formatVar(v))
      if (res?.truncated) out.push(`... truncated, narrow with pattern/limit`)
      if (entries.length === 0) {
        out.push(
          args.pattern
            ? `(no variables match ${JSON.stringify(args.pattern)})`
            : `(empty namespace - run pyrepl_exec first or reset=true wiped it)`,
        )
      }
      return out.join("\n")
    },
  })
}
