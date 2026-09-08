#!/usr/bin/env node
/** Typechecks the project without hardcoded toolchain paths.
 *
 * Locates tsc in order: ./node_modules/.bin/tsc, tsc on PATH, then the
 * newest typescript in the Bun install cache. Fails clearly if none found.
 */

import { access, readdir } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"

const ROOT = path.dirname(fileURLToPath(new URL(".", import.meta.url)))

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findTsc(): Promise<string | null> {
  const local = path.join(ROOT, "node_modules", ".bin", "tsc")
  if (await exists(local)) return local
  try {
    const which = spawnSync(process.platform === "win32" ? "where" : "which", ["tsc"], {
      encoding: "utf-8",
    })
    const onPath = (which.stdout ?? "").trim().split("\n")[0]
    if (which.status === 0 && onPath && (await exists(onPath))) return onPath
  } catch {
  }
  const bunHome = process.env.BUN_INSTALL?.trim() || path.join(homedir(), ".bun")
  const cache = path.join(bunHome, "install", "cache", "typescript")
  try {
    const entries = (await readdir(cache)).filter((e) => !e.startsWith(".")).sort()
    for (const entry of entries.reverse()) {
      const tsc = path.join(cache, entry, "bin", "tsc")
      if (await exists(tsc)) return tsc
    }
  } catch {
  }
  return null
}

const tsc = await findTsc()
if (!tsc) {
  console.error("typecheck: no tsc found (node_modules, PATH, or Bun cache)")
  process.exit(1)
}
console.log(`typecheck: using ${tsc}`)
// Run under the current runtime instead of hardcoding `node`.
const proc = spawn(process.execPath, [tsc, "--noEmit"], {
  cwd: ROOT,
  stdio: "inherit",
})
proc.on("exit", (code) => process.exit(code ?? 1))
