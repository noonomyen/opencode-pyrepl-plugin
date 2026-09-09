/** Config tests: pyrepl.jsonc discovery, merge, validation, transport.
 * Fast, no subprocesses (except one tool-level e2e). Run: bun test tests/config.test.ts
 */
import { test, expect, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DEFAULT_CONFIG,
  collectIgnoredEnv,
  getConfig,
  loadMergedConfig,
  resolveServerFile,
  stripJsonc,
  toPythonEnv,
} from "../src/config.ts"
import { buildServerEnv, resolveBin } from "../src/session.ts"
import { fakeCtx, loadPlugin } from "./helpers.ts"

const savedEnv: Record<string, string | undefined> = {}
function pinEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})

function isolatedGlobal(): string {
  const d = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-global-"))
  pinEnv("OPENCODE_CONFIG_DIR", d)
  pinEnv("XDG_CONFIG_HOME", mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-xdg-")))
  return d
}

function writeProjectConfig(dir: string, body: string): void {
  mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  writeFileSync(path.join(dir, ".opencode", "pyrepl.jsonc"), body)
}

test("stripJsonc keeps strings, drops comments and trailing commas", () => {
  const out = stripJsonc(`{
    // line comment
    "a": 1, /* block
    comment */ "b": "x // not a comment",
    "c": "/* nor this */",
    "d": [1, 2,],
  }`)
  expect(JSON.parse(out)).toEqual({ a: 1, b: "x // not a comment", c: "/* nor this */", d: [1, 2] })
})

test("missing files resolve to defaults with no sources", async () => {
  isolatedGlobal()
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-empty-"))
  const loaded = await loadMergedConfig({ worktree: dir, directory: dir })
  expect(loaded.config.timeout_s).toBe(60)
  expect(loaded.config.max_mem_mb).toBe(4096)
  expect(loaded.sources).toEqual([])
  expect(loaded.warnings).toEqual([])
})

test("global base, project override wins per key", async () => {
  const g = isolatedGlobal()
  writeFileSync(path.join(g, "pyrepl.jsonc"), `{"timeout_s": 7, "preview_lines": 11}`)
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-proj-"))
  writeProjectConfig(dir, `{"timeout_s": 9}`)
  const loaded = await loadMergedConfig({ worktree: dir, directory: dir })
  expect(loaded.config.timeout_s).toBe(9)
  expect(loaded.config.preview_lines).toBe(11)
  expect(loaded.sources).toEqual(["global", "project"])
})

test("bad values fall back with warnings, unknown keys flagged", async () => {
  isolatedGlobal()
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-bad-"))
  writeProjectConfig(dir, `{"timeout_s": -5, "notify_agent": "maybe", "nope_key": 1}`)
  const loaded = await loadMergedConfig({ worktree: dir, directory: dir })
  expect(loaded.config.timeout_s).toBe(60)
  expect(loaded.config.notify_agent).toBe(true)
  expect(loaded.warnings.join("\n")).toMatch(/timeout_s/)
  expect(loaded.warnings.join("\n")).toMatch(/notify_agent/)
  expect(loaded.warnings.join("\n")).toMatch(/nope_key/)
})

test("bad project value keeps the global layer, not defaults", async () => {
  const g = isolatedGlobal()
  writeFileSync(path.join(g, "pyrepl.jsonc"), `{"timeout_s": 7, "notify_agent": false}`)
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-layer-"))
  writeProjectConfig(dir, `{"timeout_s": -5, "notify_agent": "maybe"}`)
  const loaded = await loadMergedConfig({ worktree: dir, directory: dir })
  expect(loaded.config.timeout_s).toBe(7)
  expect(loaded.config.notify_agent).toBe(false)
  expect(loaded.warnings.join("\n")).toMatch(/timeout_s/)
})

test("__proto__ key is rejected as unknown, prototype untouched", async () => {
  isolatedGlobal()
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-proto-"))
  writeProjectConfig(dir, `{"__proto__": {"timeout_s": 1}, "timeout_s": 12}`)
  const loaded = await loadMergedConfig({ worktree: dir, directory: dir })
  expect(loaded.config.timeout_s).toBe(12)
  expect(({} as any).timeout_s).toBeUndefined()
  expect(loaded.warnings.join("\n")).toMatch(/unknown config key/)
})

test("buildServerEnv scrubs operator env, injects transport only", () => {
  isolatedGlobal()
  pinEnv("PYREPL_MAX_MEM_MB", "1")
  pinEnv("PYREPL_TIMEOUT_S", "1")
  pinEnv("PYREPL_NOTIFY_AGENT", "0")
  pinEnv("PYREPL_PREVIEW_LINES", "1")
  pinEnv("PYREPL_PYTHON", "/nope/python")
  pinEnv("PYREPL_ANYTHING", "")
  const env = buildServerEnv({ ...DEFAULT_CONFIG, max_mem_mb: 512 })
  expect(env.PYREPL_MAX_MEM_MB).toBe("512")
  expect(env.PYREPL_MAX_BYTES).toBe(String(DEFAULT_CONFIG.max_bytes))
  expect(env.PYREPL_TIMEOUT_S).toBeUndefined()
  expect(env.PYREPL_NOTIFY_AGENT).toBeUndefined()
  expect(env.PYREPL_PREVIEW_LINES).toBeUndefined()
  expect(env.PYREPL_PYTHON).toBeUndefined()
  expect(env.PYREPL_ANYTHING).toBeUndefined()
  expect(env.PATH).toBe(process.env.PATH)
})

test("resolveServerFile returns null when no engine exists", () => {
  expect(resolveServerFile("file:///nonexistent-dir-xyz-123/file.js")).toBeNull()
})

test("package version matches engine VERSION", () => {
  const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf-8"))
  const init = readFileSync(path.resolve("src", "pyrepl", "__init__.py"), "utf-8")
  const m = init.match(/^VERSION = "([^"]+)"$/m)
  expect(m?.[1]).toBe(pkg.version)
})

test("on_timeout enum accepts known values, rejects the rest", async () => {
  isolatedGlobal()
  // Separate dirs per case: the file cache keys on mtime+size, so rapid
  // same-dir rewrites of same-size content could read stale.
  const okDir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-enumok-"))
  writeProjectConfig(okDir, `{"on_timeout": "detach"}`)
  expect((await getConfig({ worktree: okDir, directory: okDir })).on_timeout).toBe("detach")
  const caseDir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-enumcase-"))
  writeProjectConfig(caseDir, `{"on_timeout": "DETACH"}`)
  const bad = await loadMergedConfig({ worktree: caseDir, directory: caseDir })
  expect(bad.config.on_timeout).toBe("interrupt")
  expect(bad.warnings.join("\n")).toMatch(/on_timeout/)
  const numDir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-enumnum-"))
  writeProjectConfig(numDir, `{"on_timeout": 1}`)
  expect((await getConfig({ worktree: numDir, directory: numDir })).on_timeout).toBe("interrupt")
})

test("on_timeout layers like other keys (project beats global)", async () => {
  const g = isolatedGlobal()
  writeFileSync(path.join(g, "pyrepl.jsonc"), `{"on_timeout": "detach"}`)
  const plain = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-enuml-"))
  expect((await getConfig({ worktree: plain, directory: plain })).on_timeout).toBe("detach")
  const over = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-enumo-"))
  writeProjectConfig(over, `{"on_timeout": "bogus"}`)
  expect((await getConfig({ worktree: over, directory: over })).on_timeout).toBe("detach")
})

test("invalid JSONC is ignored with a warning, defaults survive", async () => {
  isolatedGlobal()
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-invalid-"))
  writeProjectConfig(dir, `{"timeout_s": `)
  const loaded = await loadMergedConfig({ worktree: dir, directory: dir })
  expect(loaded.config.timeout_s).toBe(60)
  expect(loaded.warnings.join("\n")).toMatch(/invalid JSONC/)
})

test("user env is file-only: ignored by resolution, reported for the note", async () => {
  isolatedGlobal()
  pinEnv("PYREPL_TIMEOUT_S", "5")
  pinEnv("PYREPL_PYTHON", "/nope/python")
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-env-"))
  expect((await getConfig({ worktree: dir, directory: dir })).timeout_s).toBe(60)
  expect(collectIgnoredEnv()).toContain("PYREPL_TIMEOUT_S")
  expect(collectIgnoredEnv()).toContain("PYREPL_PYTHON")
})

test("toPythonEnv maps engine knobs, leaves TS knobs out", () => {
  isolatedGlobal()
  const env = toPythonEnv({ ...DEFAULT_CONFIG, timeout_s: 9, max_mem_mb: 512, notify_agent: false })
  expect(env.PYREPL_MAX_MEM_MB).toBe("512")
  expect(env.PYREPL_TIMEOUT_S).toBeUndefined()
})

test("resolveBin honors the python key over auto-detect", async () => {
  isolatedGlobal()
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-bin-"))
  const cfg = await getConfig({ worktree: dir, directory: dir })
  expect(await resolveBin(undefined, { worktree: dir, directory: dir }, cfg)).toBe("python3")
  expect(await resolveBin(undefined, { worktree: dir, directory: dir }, { ...cfg, python: "/custom/python" })).toBe(
    "/custom/python",
  )
})

test("resolveServerFile prefers pyz in dist, shim in src", () => {
  const viaSrc = resolveServerFile("file://" + path.resolve("src", "config.ts"))
  expect(viaSrc?.endsWith("pyrepl_server.py")).toBe(true)
  if (existsSync(path.resolve("dist", "pyrepl.pyz"))) {
    const viaDist = resolveServerFile("file://" + path.resolve("dist", "pyrepl.js"))
    expect(viaDist?.endsWith("pyrepl.pyz")).toBe(true)
  }
})

test("project config surfaces in the fresh note", async () => {
  const g = isolatedGlobal()
  expect(g.length).toBeGreaterThan(0)
  const hooks: any = await loadPlugin()
  const ctx = fakeCtx("config-sess-note")
  writeProjectConfig(ctx.directory, `{"timeout_s": 30, "//": "marker"}`)
  const r: string = await hooks.tool.pyrepl_exec.execute({ code: "1+1" }, ctx)
  expect(r).toContain("config: project")
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "config-sess-note" } } } })
})

test("template config parses to defaults", async () => {
  isolatedGlobal()
  const { CONFIG_TEMPLATE } = await import("../src/config.ts")
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-tpl-"))
  writeProjectConfig(dir, CONFIG_TEMPLATE)
  const loaded = await loadMergedConfig({ worktree: dir, directory: dir })
  expect(loaded.config.timeout_s).toBe(60)
  expect(loaded.config.max_mem_mb).toBe(4096)
  expect(loaded.warnings).toEqual([])
})

test("template covers every config key with its default", async () => {
  isolatedGlobal()
  const { CONFIG_TEMPLATE } = await import("../src/config.ts")
  const dir = mkdtempSync(path.join(tmpdir(), "pyrepl-cfg-tplkeys-"))
  writeProjectConfig(dir, CONFIG_TEMPLATE)
  const loaded = await loadMergedConfig({ worktree: dir, directory: dir })
  expect(loaded.warnings).toEqual([])
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    expect(loaded.config[k as keyof typeof loaded.config]).toBe(v)
  }
})
