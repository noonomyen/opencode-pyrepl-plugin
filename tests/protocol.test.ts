/** Protocol-level tests: drive src/pyrepl_server.py over NDJSON stdio.
 * Fast and deterministic (ubuntu only). Timing-sensitive suites live in
 * slow.test.ts. Run: bun test tests/protocol.test.ts
 */
import { test, expect } from "bun:test"
import { ProcClient, sleep, waitForTask } from "./helpers.ts"

test("orphan sink: late bg print cannot corrupt the stream", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({
      op: "execute", task_id: "t_bg", wait_ms: 4000,
      code: "import threading, time\ndef bg():\n    time.sleep(1.0)\n    print('LATE-BG-PRINT')\nthreading.Thread(target=bg, daemon=True).start()\nprint('task-done')",
    })
    expect(r.status).toBe("done")
    await sleep(2000)
    expect((await c.call({ op: "ping" }, 5000)).status).toBe("ok")
    const r2 = await c.call({ op: "execute", task_id: "t_after", wait_ms: 5000, code: "40 + 2" })
    expect(r2.status).toBe("done")
    expect(r2.result_preview).toBe("42")
    expect(c.badLines).toEqual([])
  } finally {
    await c.close()
  }
}, 15000)

test("interrupt answered during execute wait", async () => {
  const c = new ProcClient()
  try {
    const box: any = {}
    const th = (async () => {
      try {
        box.res = await c.call(
          { op: "execute", task_id: "t_long", wait_ms: 25000, code: "while True:\n    pass" }, 30000)
      } catch (e) {
        box.err = e
      }
    })()
    await waitForTask(c, "t_long")
    const t1 = Date.now()
    const r = await c.call({ op: "interrupt", task_id: "t_long" }, 15000)
    expect(r.status).toBe("interrupted")
    expect(Date.now() - t1).toBeLessThan(8000)
    await th
    expect(box.res?.status).toBe("interrupted")
  } finally {
    await c.close()
  }
}, 30000)

test("interrupt TOCTOU: finished and unknown tasks are safe", async () => {
  const c = new ProcClient()
  try {
    expect((await c.call({ op: "execute", task_id: "t_quick", wait_ms: 5000, code: "1 + 1" })).status).toBe("done")
    const r = await c.call({ op: "interrupt", task_id: "t_quick" })
    expect(r.status).toBe("done")
    expect(r.message).toMatch(/already finished/)
    expect((await c.call({ op: "interrupt", task_id: "t_nope" })).status).toBe("not_found")
    const healthy = await c.call({ op: "execute", task_id: "t_ok", wait_ms: 5000, code: "2 * 21" })
    expect(healthy.status).toBe("done")
    expect(healthy.result_preview).toBe("42")
  } finally {
    await c.close()
  }
}, 15000)

test("list op reports tasks", async () => {
  const c = new ProcClient()
  try {
    await c.call({ op: "execute", task_id: "t_a", wait_ms: 5000, code: "1" })
    await c.call({ op: "execute", task_id: "t_b", wait_ms: 5000, code: "2" })
    const r = await c.call({ op: "list" })
    const ids = (r.tasks ?? []).map((t: any) => [t.task_id, t.n, t.task_status])
    expect(ids).toContainEqual(["t_a", 1, "done"])
    expect(ids).toContainEqual(["t_b", 2, "done"])
  } finally {
    await c.close()
  }
}, 15000)

test("reset busy names the task, works after interrupt", async () => {
  const c = new ProcClient()
  try {
    const pending = c.call(
      { op: "execute", task_id: "t_run", wait_ms: 15000, code: "while True:\n    pass" }, 20000)
    pending.catch(() => {})
    await waitForTask(c, "t_run")
    const r = await c.call({ op: "reset" })
    expect(r.status).toBe("busy")
    expect(r.task_id).toBe("t_run")
    await c.call({ op: "interrupt", task_id: "t_run" }, 15000)
    await pending
    expect((await c.call({ op: "reset" })).status).toBe("ok")
  } finally {
    await c.close()
  }
}, 30000)

test("oversize grep rejected", async () => {
  const c = new ProcClient()
  try {
    await c.call({ op: "execute", task_id: "t_g", wait_ms: 5000, code: "print('hi')" })
    const r = await c.call({ op: "read", task_id: "t_g", grep: "x".repeat(501) })
    expect(r.status).toBe("error")
    expect(r.message).toMatch(/too long/)
  } finally {
    await c.close()
  }
}, 15000)

test("big result: head+tail preview, full via read", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({ op: "execute", task_id: "t_big", wait_ms: 10000, code: "[i for i in range(3000)]" })
    expect(r.status).toBe("done")
    expect(r.result_truncated).toBe(true)
    expect(r.result_chars).toBeGreaterThan(4000)
    expect(r.result_preview).toMatch(/omitted/)
    expect(r.result_preview).toContain("2999]")
    const full = await c.call({ op: "read", task_id: "t_big", target: "result" })
    expect(full.result_full?.length).toBe(full.result_chars)
    expect(full.result_full?.endsWith("2999]")).toBe(true)
  } finally {
    await c.close()
  }
}, 15000)

test("registry keeps recent tasks", async () => {
  const c = new ProcClient()
  try {
    for (let i = 1; i <= 7; i++) {
      await c.call({ op: "execute", task_id: `t_${i}`, wait_ms: 5000, code: String(i) })
    }
    expect((await c.call({ op: "read", task_id: "t_1" })).status).toBe("done")
  } finally {
    await c.close()
  }
}, 20000)

test("byte cap drops oldest, lines unrecoverable after finish", async () => {
  const c = new ProcClient({ PYREPL_MAX_BYTES: "2000" })
  try {
    const r = await c.call({ op: "execute", task_id: "t_fat", wait_ms: 10000, code: "for i in range(30):\n    print('x' * 100)" })
    expect(r.truncated_lines).toBeGreaterThan(0)
    // The completion payload still carries the surviving preview...
    expect((r.lines ?? []).length).toBeGreaterThan(0)
    // ...but lines are dropped at the first terminal observation by design.
    const rd = await c.call({ op: "read", task_id: "t_fat" })
    expect(rd.status).toBe("done")
    expect(rd.returned).toBe(0)
    expect(rd.note ?? "").toMatch(/dropped/)
    expect(rd.output_lines).toBe(30)
  } finally {
    await c.close()
  }
}, 15000)

test("long lines split into chunks", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({ op: "execute", task_id: "t_long", wait_ms: 10000, code: "print('Z' * 25000)" })
    const lines = (r.lines ?? []).map((e: any) => e.line)
    expect(lines.some((l: string) => l.endsWith("[line split]"))).toBe(true)
    expect(lines.every((l: string) => l.length <= 10030)).toBe(true)
  } finally {
    await c.close()
  }
}, 15000)

test("orphan output readable via target=orphan", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({
      op: "execute", task_id: "t_o", wait_ms: 4000,
      code: "import threading, time\nthreading.Thread(target=lambda: (time.sleep(1.0), print('ORPHAN-LATE-LINE')), daemon=True).start()\nprint('task-done')",
    })
    expect(r.status).toBe("done")
    await sleep(2000)
    const rd = await c.call({ op: "read", task_id: "t_o", target: "orphan" })
    expect((rd.lines ?? []).some((e: any) => e.line.includes("ORPHAN-LATE-LINE"))).toBe(true)
  } finally {
    await c.close()
  }
}, 15000)

test("reset clears registry, ids restart", async () => {
  const c = new ProcClient()
  try {
    await c.call({ op: "execute", task_id: "t_1", wait_ms: 5000, code: "9" })
    expect((await c.call({ op: "reset" })).status).toBe("ok")
    expect((await c.call({ op: "read", task_id: "t_1" })).status).toBe("not_found")
    const r = await c.call({ op: "execute", task_id: "t_1", wait_ms: 5000, code: "8" })
    expect(r.status).toBe("done")
    expect(r.n).toBe(1)
    expect(r.result_preview).toBe("8")
  } finally {
    await c.close()
  }
}, 15000)

test("task meta: elapsed_ms, output_bytes, output_lines", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({
      op: "execute", task_id: "t_meta", wait_ms: 8000,
      code: "import time\ntime.sleep(1)\nprint('ab')\nprint('cdef', end='')",
    })
    expect(r.status).toBe("done")
    expect(typeof r.elapsed_ms === "number" && r.elapsed_ms >= 900).toBe(true)
    expect(r.output_bytes).toBe(6)
    expect(r.output_lines).toBe(2)
    const rd = await c.call({ op: "read", task_id: "t_meta" })
    expect(rd.elapsed_ms).toBe(r.elapsed_ms)
    expect(rd.output_bytes).toBe(6)
    expect(rd.output_lines).toBe(2)
  } finally {
    await c.close()
  }
}, 15000)

test("per-task metrics: cpu, alloc, vars, mem limit", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({ op: "execute", task_id: "t_m", wait_ms: 8000, code: "v = [i for i in range(50000)]\nlen(v)" })
    expect(typeof r.cpu_ms === "number" && r.cpu_ms >= 0).toBe(true)
    expect(typeof r.rss_bytes === "number" && r.rss_bytes > 0).toBe(true)
    expect(typeof r.alloc_bytes === "number" && r.alloc_bytes > 0).toBe(true)
    expect(typeof r.vars === "number" && r.vars >= 1).toBe(true)
    expect(r.mem_limit_mb).toBe(0)
    const rd = await c.call({ op: "read", task_id: "t_m" })
    expect(typeof rd.cpu_ms === "number").toBe(true)
    expect(typeof rd.alloc_bytes === "number").toBe(true)
  } finally {
    await c.close()
  }
}, 15000)

test("alloc goes negative when the task frees memory", async () => {
  const c = new ProcClient()
  try {
    await c.call({ op: "execute", task_id: "t_a1", wait_ms: 8000, code: "tmp = bytearray(2 * 1024 * 1024)\n1" })
    const r = await c.call({ op: "execute", task_id: "t_a2", wait_ms: 8000, code: "del tmp\n0" })
    expect(typeof r.alloc_bytes === "number" && r.alloc_bytes < 0).toBe(true)
  } finally {
    await c.close()
  }
}, 15000)

test("list carries live stats, proc block, limits block", async () => {
  const c = new ProcClient()
  try {
    const pending = c.call(
      { op: "execute", task_id: "t_live", wait_ms: 15000, code: "while True:\n    pass" }, 20000)
    pending.catch(() => {})
    await waitForTask(c, "t_live")
    const r = await c.call({ op: "list" })
    const live = (r.tasks ?? []).filter((x: any) => x.task_id === "t_live")
    expect(live.length).toBe(1)
    expect(typeof live[0].elapsed_ms === "number" && live[0].elapsed_ms >= 0).toBe(true)
    await sleep(400)
    const r2 = await c.call({ op: "list" })
    const live2 = (r2.tasks ?? []).filter((x: any) => x.task_id === "t_live")
    expect(live2[0].elapsed_ms).toBeGreaterThan(live[0].elapsed_ms)
    expect(typeof r.proc?.rss_bytes === "number").toBe(true)
    expect(typeof r.proc?.cpu_total_ms === "number").toBe(true)
    expect(typeof r.proc?.pid === "number" && (r.proc?.pid ?? 0) > 0).toBe(true)
    expect(typeof r.proc?.vars === "number").toBe(true)
    expect(r.limits?.mem_limit_mb).toBe(0)
    expect(r.limits?.mem_enforced).toBe(false)
    await c.call({ op: "interrupt", task_id: "t_live" }, 15000)
    await pending
    const done = (await c.call({ op: "list" })).tasks?.filter((x: any) => x.task_id === "t_live") ?? []
    expect(done[0]?.task_status).toBe("interrupted")
  } finally {
    await c.close()
  }
}, 30000)

test("preempt interrupts old task and runs new code", async () => {
  const c = new ProcClient()
  try {
    const pending = c.call(
      { op: "execute", task_id: "t_old", wait_ms: 15000, code: "while True:\n    pass" }, 20000)
    pending.catch(() => {})
    await waitForTask(c, "t_old")
    const r = await c.call({ op: "execute", task_id: "t_new", wait_ms: 15000, code: "40 + 2", preempt: true }, 25000)
    expect(r.status).toBe("done")
    expect(r.result_preview).toBe("42")
    expect(r.preempted?.task_id).toBe("t_old")
    expect(r.preempted?.status).toBe("interrupted")
    await pending
    expect((await c.call({ op: "read", task_id: "t_old" })).status).toBe("interrupted")
  } finally {
    await c.close()
  }
}, 30000)

// A nested try-around-everything swallower catches every delivery channel:
// the inner loop's only checkpoint (its back-edge) sits INSIDE the try, so
// trips and async kills alike land where they are caught. It is the shape
// that still defeats interrupt deterministically (ladder, then respawn).
const SWALLOW_ALL = "while True:\n    try:\n        while True:\n            x = 1\n    except BaseException:\n        continue"

test("sleep dies to preempt (signals break syscalls)", async () => {
  const c = new ProcClient()
  try {
    const pending = c.call(
      { op: "execute", task_id: "t_sleep", wait_ms: 30000, code: "import time\ntime.sleep(30)" }, 35000)
    pending.catch(() => {})
    await waitForTask(c, "t_sleep")
    const t0 = Date.now()
    const r = await c.call({ op: "execute", task_id: "t_next", wait_ms: 8000, code: "40 + 2", preempt: true }, 15000)
    expect(r.status).toBe("done")
    expect(r.result_preview).toBe("42")
    expect(r.preempted?.task_id).toBe("t_sleep")
    expect(Date.now() - t0).toBeLessThan(8000)
    await pending
  } finally {
    await c.close()
  }
}, 30000)

test("preempt_failed on swallowing loop, then ladder", async () => {
  const c = new ProcClient({ PYREPL_INTERRUPT_WAIT_S: "1" })
  try {
    const pending = c.call(
      { op: "execute", task_id: "t_sw", wait_ms: 30000, code: SWALLOW_ALL }, 35000)
    pending.catch(() => {})
    await waitForTask(c, "t_sw")
    const r = await c.call({ op: "execute", task_id: "t_next", wait_ms: 8000, code: "1", preempt: true }, 15000)
    expect(r.status).toBe("preempt_failed")
    expect(r.task_id).toBe("t_sw")
  } finally {
    await c.close()
  }
}, 30000)

test("concurrent double preempt keeps single flight", async () => {
  const c = new ProcClient({ PYREPL_INTERRUPT_WAIT_S: "5" })
  try {
    const victim = c.call(
      { op: "execute", task_id: "t_victim", wait_ms: 30000, code: SWALLOW_ALL }, 35000)
    victim.catch(() => {})
    await waitForTask(c, "t_victim")
    const box: Record<string, any> = {}
    const run = async (tid: string) => {
      try {
        box[tid] = await c.call({ op: "execute", task_id: tid, wait_ms: 12000, code: "1", preempt: true }, 15000)
      } catch (e) {
        box[tid] = { status: "client-error", message: String(e) }
      }
    }
    await Promise.all([run("t_p1"), run("t_p2")])
    expect([box.t_p1?.status, box.t_p2?.status].sort()).toEqual(["preempt_failed", "preempt_failed"])
    const tasks = (await c.call({ op: "list" })).tasks ?? []
    expect(tasks.some((x: any) => x.task_id === "t_victim" && x.task_status === "running")).toBe(true)
  } finally {
    await c.close()
  }
}, 40000)

test("no double spawn on the same interruptible victim", async () => {
  const c = new ProcClient()
  try {
    const victim = c.call(
      { op: "execute", task_id: "t_loop", wait_ms: 30000, code: "while True:\n    pass" }, 35000)
    victim.catch(() => {})
    await waitForTask(c, "t_loop")
    const box: Record<string, any> = {}
    const run = async (tid: string) => {
      try {
        box[tid] = await c.call({ op: "execute", task_id: tid, wait_ms: 15000, code: "1", preempt: true }, 20000)
      } catch (e) {
        box[tid] = { status: "client-error", message: String(e) }
      }
    }
    await Promise.all([run("t_q1"), run("t_q2")])
    const r1 = box.t_q1 ?? {}
    const r2 = box.t_q2 ?? {}
    const claims = [r1, r2].map((r) => r.preempted?.task_id === "t_loop")
    expect(claims.every(Boolean)).toBe(false)
    expect(r1.status === "done" || r2.status === "done").toBe(true)
  } finally {
    await c.close()
  }
}, 40000)

test("mem limit: overuse is MemoryError, session survives", async () => {
  const c = new ProcClient({ PYREPL_MAX_MEM_MB: "512" })
  try {
    const ping = await c.call({ op: "ping" }, 10000)
    if (!ping.limits?.mem_enforced) {
      console.log("skip: mem cap unenforced here (boot VSZ above cap)")
      return
    }
    expect(ping.limits?.mem_limit_mb).toBe(512)
    const r = await c.call({ op: "execute", task_id: "t_fat", wait_ms: 15000, code: "bytearray(2 * 1024 * 1024 * 1024)" })
    expect(r.status).toBe("error")
    expect(r.error?.type).toBe("MemoryError")
    const ok = await c.call({ op: "execute", task_id: "t_ok", wait_ms: 8000, code: "40 + 2" })
    expect(ok.status).toBe("done")
    expect(ok.result_preview).toBe("42")
  } finally {
    await c.close()
  }
}, 30000)

test("MEM=0 disables the cap", async () => {
  const c = new ProcClient({ PYREPL_MAX_MEM_MB: "0" })
  try {
    const ping = await c.call({ op: "ping" }, 10000)
    expect(ping.limits?.mem_limit_mb).toBe(0)
    expect(ping.limits?.mem_enforced).toBe(false)
    const r = await c.call({ op: "execute", task_id: "t_big", wait_ms: 15000, code: "bytearray(2 * 1024 * 1024 * 1024)\n1" })
    expect(r.status).toBe("done")
  } finally {
    await c.close()
  }
}, 30000)

test("mem warn fires past threshold, absent otherwise", async () => {
  const c = new ProcClient({ PYREPL_MAX_MEM_MB: "512", PYREPL_MEM_WARN_PCT: "10" })
  try {
    // Completion-time evaluation: no sleep needed, delivery never depends
    // on dispatcher polls (a starved dispatcher must not lose the warn).
    const r = await c.call({
      op: "execute", task_id: "t_w", wait_ms: 8000,
      code: "big = bytearray(100 * 1024 * 1024)\n1",
    })
    expect(r.status).toBe("done")
    expect(typeof r.mem_warn === "string" && r.mem_warn.includes("10%")).toBe(true)
    const small = await c.call({ op: "execute", task_id: "t_nw", wait_ms: 8000, code: "1 + 1" })
    expect(small.mem_warn ?? null).toBeNull()
    // Delta semantics: an innocent task after a big hoard must not warn
    // by association with the stale high-water mark.
    const innocent = await c.call({ op: "execute", task_id: "t_in", wait_ms: 8000, code: "2" })
    expect(innocent.status).toBe("done")
    expect(innocent.mem_warn ?? null).toBeNull()
  } finally {
    await c.close()
  }
}, 30000)

test("nproc knob: roomy cap enforces, tiny cap refuses honestly", async () => {
  const c = new ProcClient({ PYREPL_MAX_NPROC: "100000" })
  try {
    const ping = await c.call({ op: "ping" }, 10000)
    expect(ping.limits?.nproc_enforced).toBe(true)
  } finally {
    await c.close()
  }
  const c2 = new ProcClient({ PYREPL_MAX_NPROC: "10" })
  try {
    const ping = await c2.call({ op: "ping" }, 10000)
    const lim = ping.limits ?? {}
    const r = await c2.call({
      op: "execute", task_id: "t_t", wait_ms: 8000,
      code: "import threading\nts = [threading.Thread(target=lambda: None) for _ in range(5)]\n[t.start() for t in ts]\n[t.join() for t in ts]\nlen(ts)",
    })
    expect(r.status).toBe("done")
    if (lim.nproc_enforced === false) {
      expect(lim.nproc_limit).toBe(10)
      expect(lim.reason ?? "").toMatch(/not enforced/)
    } else {
      expect(lim.nproc_limit).toBe(10)
    }
  } finally {
    await c2.close()
  }
}, 30000)

test("registry eviction: old ids report not_found", async () => {
  const c = new ProcClient()
  try {
    for (let i = 1; i <= 23; i++) {
      await c.call({ op: "execute", task_id: `t_${i}`, wait_ms: 5000, code: String(i) })
    }
    expect((await c.call({ op: "read", task_id: "t_1" })).status).toBe("not_found")
    expect((await c.call({ op: "read", task_id: "t_23" })).status).toBe("done")
  } finally {
    await c.close()
  }
}, 30000)

test("KeyboardInterrupt-swallowing tight loop still dies fast", async () => {
  // Delivery lands on the loop back-edge (the only eval checkpoint, outside
  // the inner try), so the swallower never sees it: deterministic kill via
  // the signal trip, reported as KeyboardInterrupt.
  const c = new ProcClient()
  try {
    const pending = c.call({
      op: "execute", task_id: "t_sw", wait_ms: 15000,
      code: "i = 0\nwhile True:\n    try:\n        i += 1\n    except KeyboardInterrupt:\n        continue",
    }, 20000)
    pending.catch(() => {})
    await waitForTask(c, "t_sw")
    const t0 = Date.now()
    const r = await c.call({ op: "interrupt", task_id: "t_sw" }, 15000)
    expect(r.status).toBe("interrupted")
    expect(r.error?.type).toBe("KeyboardInterrupt")
    expect(Date.now() - t0).toBeLessThan(8000)
    await pending
  } finally {
    await c.close()
  }
}, 30000)

test("sleep dies fast via phase-1 signals", async () => {
  const c = new ProcClient()
  try {
    const pending = c.call(
      { op: "execute", task_id: "t_sl", wait_ms: 30000, code: "import time\ntime.sleep(30)" }, 35000)
    pending.catch(() => {})
    await waitForTask(c, "t_sl")
    const t0 = Date.now()
    const r = await c.call({ op: "interrupt", task_id: "t_sl", wait_s: 5 }, 15000)
    expect(r.status).toBe("interrupted")
    expect(r.error?.type).toBe("KeyboardInterrupt")
    expect(Date.now() - t0).toBeLessThan(8000)
    await pending
  } finally {
    await c.close()
  }
}, 30000)

test("on_timeout interrupt stops the task, detach leaves it running", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({
      op: "execute", task_id: "t_to", wait_ms: 1500,
      code: "import time\ntime.sleep(30)", on_timeout: "interrupt",
    }, 15000)
    expect(r.status).toBe("interrupted")
    const r2 = await c.call({
      op: "execute", task_id: "t_td", wait_ms: 1500,
      code: "import time\ntime.sleep(30)", on_timeout: "detach",
    }, 15000)
    expect(r2.status).toBe("running")
    const rk = await c.call({ op: "interrupt", task_id: "t_td", mode: "kill" }, 15000)
    expect(rk.message ?? "").toMatch(/killed/)
    await expect(c.call({ op: "ping" }, 5000)).rejects.toThrow()
  } finally {
    await c.close()
  }
}, 30000)

test("vars op lists namespace and inspects one var", async () => {
  const c = new ProcClient()
  try {
    await c.call({ op: "execute", task_id: "t_v", wait_ms: 8000, code: "qv_thing = [1, 2, 3]\nqv_n = 9" })
    const r = await c.call({ op: "vars", pattern: "^qv_", limit: 200, sort: "name" })
    expect(r.status).toBe("ok")
    const names = (r.vars ?? []).map((v: any) => v.name)
    expect(names).toContain("qv_thing")
    expect(names).toContain("qv_n")
    expect(names.some((n: string) => n.startsWith("__"))).toBe(false)
    const one = await c.call({ op: "vars", name: "qv_thing" })
    expect(one.vars?.[0]?.type).toBe("list")
    expect(one.full).toContain("[1, 2, 3]")
    expect((await c.call({ op: "vars", name: "qv_nope" })).vars).toEqual([])
  } finally {
    await c.close()
  }
}, 20000)

test("empty code completes with no output", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({ op: "execute", task_id: "t_e", wait_ms: 5000, code: "" })
    expect(r.status).toBe("done")
    expect(r.output_lines).toBe(0)
  } finally {
    await c.close()
  }
}, 15000)

test("null byte code errors without killing the server", async () => {
  const c = new ProcClient()
  try {
    // CPython rejects NUL in source deterministically (SyntaxError).
    const r = await c.call({ op: "execute", task_id: "t_n", wait_ms: 5000, code: "x=\x00" })
    expect(r.status).toBe("error")
    expect((await c.call({ op: "execute", task_id: "t_n2", wait_ms: 5000, code: "40 + 2" })).result_preview).toBe("42")
  } finally {
    await c.close()
  }
}, 15000)

test("deeply nested AST fails fast instead of hanging", async () => {
  const c = new ProcClient()
  try {
    const t0 = Date.now()
    const r = await c.call({ op: "execute", task_id: "t_ast", wait_ms: 10000, code: "(".repeat(2000) + ")".repeat(2000) }, 15000)
    expect(r.status).toBe("error")
    expect(Date.now() - t0).toBeLessThan(10000)
    expect((await c.call({ op: "ping" }, 5000)).status).toBe("ok")
  } finally {
    await c.close()
  }
}, 20000)

test("negative offset/limit clamp to sane paging on a live task", async () => {
  const c = new ProcClient()
  try {
    const pending = c.call({
      op: "execute", task_id: "t_c", wait_ms: 15000,
      code: "import time\nfor i in range(5):\n    print(f'ln-{i}')\ntime.sleep(30)",
    }, 20000)
    pending.catch(() => {})
    await waitForTask(c, "t_c")
    await sleep(500)
    const clamped = await c.call({ op: "read", task_id: "t_c", offset: -5, limit: -10 })
    expect((clamped.lines ?? []).length).toBe(5)
    const mid = await c.call({ op: "read", task_id: "t_c", offset: 1, limit: 200 })
    expect((mid.lines ?? []).map((e: any) => e.line)).toEqual(["ln-1", "ln-2", "ln-3", "ln-4"])
    await c.call({ op: "interrupt", task_id: "t_c" }, 15000)
    await pending
  } finally {
    await c.close()
  }
}, 30000)

test("2MB repr is store-truncated, session survives", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({
      op: "execute", task_id: "t_repr", wait_ms: 15000,
      code: "class Big:\n    def __repr__(self):\n        return 'x' * (2 * 1024 * 1024)\nBig()",
    })
    expect(r.status).toBe("done")
    expect(r.result_truncated).toBe(true)
    expect((await c.call({ op: "execute", task_id: "t_ok", wait_ms: 5000, code: "1" })).status).toBe("done")
  } finally {
    await c.close()
  }
}, 20000)

test("lone surrogate output round-trips through NDJSON", async () => {
  const c = new ProcClient()
  try {
    // Lines live only in the completion payload now (dropped after finish).
    const r = await c.call({ op: "execute", task_id: "t_su", wait_ms: 5000, code: "print('A\\ud800B')" })
    expect(r.status).toBe("done")
    const got = (r.lines ?? []).map((e: any) => e.line).join("")
    expect(got).toContain("A")
    expect(got).toContain("B")
    expect(c.badLines).toEqual([])
    expect(c.unknownIds).toEqual([])
  } finally {
    await c.close()
  }
}, 15000)

test("asyncio.run inside a task works", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({
      op: "execute", task_id: "t_aio", wait_ms: 8000,
      code: "import asyncio\nasync def m():\n    return 7\nasyncio.run(m())",
    })
    expect(r.status).toBe("done")
    expect(r.result_preview).toBe("7")
  } finally {
    await c.close()
  }
}, 15000)

test("BaseExceptionGroup takes the error path, server survives", async () => {
  const c = new ProcClient()
  try {
    // Mixed children keep it a BaseExceptionGroup (pure-Exception children
    // auto-narrow to ExceptionGroup).
    const r = await c.call({
      op: "execute", task_id: "t_eg", wait_ms: 8000,
      code: "raise BaseExceptionGroup('g', [ValueError(1), KeyboardInterrupt()])",
    })
    expect(r.status).toBe("error")
    expect(r.error?.type).toBe("BaseExceptionGroup")
    expect((await c.call({ op: "ping" }, 5000)).status).toBe("ok")
  } finally {
    await c.close()
  }
}, 15000)

test("recursionlimit poisoning does not kill the server", async () => {
  const c = new ProcClient()
  try {
    await c.call({ op: "execute", task_id: "t_p", wait_ms: 8000, code: "import sys\nsys.setrecursionlimit(50)\n1" })
    const r = await c.call({ op: "execute", task_id: "t_p2", wait_ms: 8000, code: "40 + 2" })
    expect(["done", "error"]).toContain(r.status)
    expect((await c.call({ op: "ping" }, 5000)).status).toBe("ok")
  } finally {
    await c.close()
  }
}, 15000)

test("sys.stdout=None is restored after the task", async () => {
  const c = new ProcClient()
  try {
    await c.call({ op: "execute", task_id: "t_so", wait_ms: 8000, code: "import sys\nsys.stdout = None\nsys.stderr = None\n1" })
    const r = await c.call({ op: "execute", task_id: "t_so2", wait_ms: 8000, code: "print('back')\n2" })
    expect(r.status).toBe("done")
    expect(r.result_preview).toBe("2")
  } finally {
    await c.close()
  }
}, 15000)

test("non-daemon sleeper does not hang close (SIGKILL fallback)", async () => {
  const c = new ProcClient()
  const t0 = Date.now()
  try {
    await c.call({
      op: "execute", task_id: "t_nd", wait_ms: 3000,
      code: "import threading, time\nthreading.Thread(target=lambda: time.sleep(9999), daemon=False).start()\n1",
    })
  } finally {
    await c.close()
  }
  expect(Date.now() - t0).toBeLessThan(30000)
}, 40000)

test("2MB no-newline print splits without losing the stream", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({ op: "execute", task_id: "t_nl", wait_ms: 15000, code: "print('y' * (2 * 1024 * 1024), end='')" })
    expect(r.status).toBe("done")
    const lines = (r.lines ?? []).map((e: any) => e.line)
    expect(lines.some((l: string) => l.endsWith("[line split]"))).toBe(true)
    expect(c.badLines).toEqual([])
  } finally {
    await c.close()
  }
}, 20000)

test("mem cap below boot address space refuses honestly", async () => {
  const c = new ProcClient({ PYREPL_MAX_MEM_MB: "10" })
  try {
    const ping = await c.call({ op: "ping" }, 10000)
    const lim = ping.limits ?? {}
    expect(lim.mem_enforced).toBe(false)
    expect(lim.mem_limit_mb).toBe(10)
    expect(lim.reason ?? "").toMatch(/below current address space|refused/)
    expect((await c.call({ op: "execute", task_id: "t_q", wait_ms: 5000, code: "1 + 1" })).status).toBe("done")
  } finally {
    await c.close()
  }
}, 15000)

test("calls after SIGKILL reject instead of hanging", async () => {
  const c = new ProcClient()
  try {
    await c.call({ op: "execute", task_id: "t_k", wait_ms: 5000, code: "1" })
    c.proc.kill("SIGKILL")
    await expect(c.call({ op: "ping" }, 5000)).rejects.toThrow()
  } finally {
    await c.close()
  }
}, 15000)

test("interrupt wait_s bounds swallowing loops", async () => {
  const c = new ProcClient()
  try {
    const pending = c.call(
      { op: "execute", task_id: "t_ns", wait_ms: 30000, code: SWALLOW_ALL }, 35000)
    pending.catch(() => {})
    await waitForTask(c, "t_ns")
    const t0 = Date.now()
    const r = await c.call({ op: "interrupt", task_id: "t_ns", wait_s: 1 }, 15000)
    expect(r.status).toBe("running")
    expect(Date.now() - t0).toBeLessThan(5000)
    const rk = await c.call({ op: "interrupt", task_id: "t_ns", mode: "kill" }, 15000)
    expect(rk.message ?? "").toMatch(/killed/)
    await pending.catch(() => {})
  } finally {
    await c.close()
  }
}, 30000)

test("error traceback shows user frames only, no engine paths", async () => {
  const c = new ProcClient()
  try {
    const r = await c.call({
      op: "execute", task_id: "t_tb", wait_ms: 5000,
      code: "def boom():\n    1/0\nboom()",
    })
    expect(r.status).toBe("error")
    expect(r.error?.type).toBe("ZeroDivisionError")
    const tb: string = r.error?.traceback ?? ""
    expect(tb).toContain('File "<repl>"')
    expect(tb).toContain("ZeroDivisionError")
    expect(tb).not.toContain("server.py")
    expect(tb).not.toMatch(/File "\//)
    const s = await c.call({
      op: "execute", task_id: "t_syn", wait_ms: 5000, code: "def f(:\n  pass",
    })
    expect(s.status).toBe("error")
    expect(s.error?.type).toBe("SyntaxError")
    expect(s.error?.traceback ?? "").not.toMatch(/File "\//)
  } finally {
    await c.close()
  }
}, 15000)
