#!/usr/bin/env bun
/** Builds distributable artifacts into dist/ (gitignored, built at install).
 *
 * - dist/pyrepl.js: bun-bundled plugin (single ESM file, node target,
 *   @opencode-ai/plugin kept external - opencode provides it).
 * - dist/pyrepl.pyz: zipapp of src/pyrepl/ (stdlib only). Staged so the
 *   package keeps relative imports: stage/pyrepl/*.py + stage/__main__.py.
 *
 * Usage: bun src/build.ts [--js-only|--py-only]
 */

import { spawnSync } from "node:child_process"
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, "dist")

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT })
  if (r.status !== 0) {
    console.error(`build: ${cmd} ${args.join(" ")} failed with code ${r.status}`)
    process.exit(r.status ?? 1)
  }
}

async function buildJs(): Promise<void> {
  run("bun", [
    "build",
    "src/server.ts",
    "--outfile",
    "dist/pyrepl.js",
    "--target",
    "node",
    "--format",
    "esm",
    "--external",
    "@opencode-ai/plugin",
  ])
}

async function buildPy(): Promise<void> {
  const stage = path.join(DIST, "stage")
  await rm(stage, { recursive: true, force: true })
  await mkdir(path.join(stage, "pyrepl"), { recursive: true })
  await cp(path.join(ROOT, "src", "pyrepl"), path.join(stage, "pyrepl"), {
    recursive: true,
    // Never ship bytecode: stale .pyc bloats the pyz and can shadow fresh
    // sources if timestamps skew inside the archive.
    filter: (src) => !src.includes("__pycache__"),
  })
  await writeFile(path.join(stage, "__main__.py"), "from pyrepl.server import main\nmain()\n")
  run("python3", ["-m", "zipapp", stage, "-o", path.join(DIST, "pyrepl.pyz"), "-p", "/usr/bin/env python3", "-c"])
  await rm(stage, { recursive: true, force: true })
}

async function report(): Promise<void> {
  for (const f of ["pyrepl.js", "pyrepl.pyz"]) {
    try {
      const s = await stat(path.join(DIST, f))
      console.log(`build: dist/${f} ${(s.size / 1024).toFixed(1)}KB`)
    } catch {
      console.error(`build: dist/${f} missing`)
      process.exit(1)
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const jsOnly = args.includes("--js-only")
  const pyOnly = args.includes("--py-only")
  if (args.some((a) => a !== "--js-only" && a !== "--py-only")) {
    console.error("usage: bun src/build.ts [--js-only|--py-only]")
    process.exit(1)
  }
  await mkdir(DIST, { recursive: true })
  if (!pyOnly) await buildJs()
  if (!jsOnly) await buildPy()
  await report()
}

await main()
