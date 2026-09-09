/** Dist tests: the shipped artifacts behave like src (needs `bun run build` first).
 * CI builds before testing; locally the pyz test fails fast with a hint.
 * Run: bun run build && bun test tests/dist.test.ts
 */
import { test, expect } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { ProcClient } from "./helpers.ts"

const PYZ = path.resolve("dist", "pyrepl.pyz")
const JS = path.resolve("dist", "pyrepl.js")

function requireBuild(): void {
  if (!existsSync(PYZ) || !existsSync(JS)) {
    throw new Error("dist/ missing: run `bun run build` first")
  }
}

test("pyz answers ping with version and limits", async () => {
  requireBuild()
  const c = new ProcClient(undefined, [PYZ])
  try {
    const r = await c.call({ op: "ping" }, 10000)
    expect(r.status).toBe("ok")
    expect(r.version).toBe("0.1.0")
    expect(r.limits?.mem_limit_mb).toBe(4096)
    expect(c.badLines).toEqual([])
  } finally {
    await c.close()
  }
}, 15000)

test("pyz executes code and keeps state", async () => {
  requireBuild()
  const c = new ProcClient(undefined, [PYZ])
  try {
    const r = await c.call({ op: "execute", task_id: "t_1", wait_ms: 8000, code: "dv = 40\ndv + 2" })
    expect(r.status).toBe("done")
    expect(r.result_preview).toBe("42")
    const r2 = await c.call({ op: "execute", task_id: "t_2", wait_ms: 8000, code: "dv * 2" })
    expect(r2.result_preview).toBe("80")
    expect(c.badLines).toEqual([])
  } finally {
    await c.close()
  }
}, 15000)

test("package runs via python -m pyrepl", async () => {
  const c = new ProcClient({ PYTHONPATH: "src" }, ["-m", "pyrepl"])
  try {
    const r = await c.call({ op: "execute", task_id: "t_1", wait_ms: 8000, code: "6 * 7" })
    expect(r.status).toBe("done")
    expect(r.result_preview).toBe("42")
  } finally {
    await c.close()
  }
}, 15000)
