#!/usr/bin/env bun
/** Installs the pyrepl plugin into an opencode plugin directory.
 *
 * Builds dist/ first (bun bundle pyrepl.js + zipapp pyrepl.pyz), then
 * installs both artifacts as siblings so the install is self-contained:
 * no dependency on this repo's location. (opencode only loads *.{ts,js},
 * the .pyz sibling is ignored by the loader.)
 *
 * Usage:
 *   bun src/install.ts [--global|--project] [--link] [--no-build] [--init-config]
 *
 *   --global       install to ~/.config/opencode/plugins/ (default, all projects)
 *   --project      install to ./.opencode/plugins/ of the current directory
 *   --link         symlink instead of copy (tracks this repo's dist/; rebuild to update)
 *   --no-build     skip the build, install the existing dist/ as-is
 *   --init-config  write a commented pyrepl.jsonc template if none exists yet
 */

import { spawnSync } from "node:child_process"
import { access, copyFile, mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CONFIG_TEMPLATE, globalConfigDir } from "./config.ts"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST_FILES = ["pyrepl.js", "pyrepl.pyz"]
// Prefer the current runtime for the build step (works when bun lives
// outside PATH); fall back to a PATH lookup otherwise.
const BUN = path.basename(process.execPath).startsWith("bun") ? process.execPath : "bun"

function fail(message: string): never {
  console.error(`install: ${message}`)
  process.exit(1)
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function main() {
  const args = process.argv.slice(2)
  const link = args.includes("--link")
  const project = args.includes("--project")
  const isGlobal = args.includes("--global")
  const noBuild = args.includes("--no-build")
  const initConfig = args.includes("--init-config")
  if (project && isGlobal) fail("pass only one of --global or --project")
  const known = new Set(["--link", "--project", "--global", "--no-build", "--init-config"])
  if (args.some((a) => !known.has(a))) {
    fail("usage: bun src/install.ts [--global|--project] [--link] [--no-build] [--init-config]")
  }

  if (!noBuild) {
    const r = spawnSync(BUN, [path.join(ROOT, "src", "build.ts")], { stdio: "inherit", cwd: ROOT })
    if (r.status !== 0) fail(`build failed with code ${r.status}`)
  }
  for (const f of DIST_FILES) {
    if (!(await exists(path.join(ROOT, "dist", f)))) {
      fail(`dist/${f} missing (run without --no-build, or run bun run build first)`)
    }
  }

  // A custom config dir replaces the global config home (same layout).
  const customDir = process.env.OPENCODE_CONFIG_DIR?.trim() || null
  const dest = project
    ? path.join(process.cwd(), ".opencode", "plugins")
    : customDir
      ? path.join(customDir, "plugins")
      : path.join(globalConfigDir(), "opencode", "plugins")

  // Guard: --project anywhere inside this repo would clobber its own shim
  // layout (exact repo root or any subdirectory of it).
  const rel = path.relative(ROOT, process.cwd())
  if (project && (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))) {
    fail("cwd is inside the plugin repo itself; nothing to install (the shim already points at src/)")
  }

  try {
    await mkdir(dest, { recursive: true })

    for (const file of DIST_FILES) {
      const from = path.join(ROOT, "dist", file)
      const to = path.join(dest, file)
      // Write-then-rename so a crash/disk-full never leaves dest half-new.
      const tmp = `${to}.tmp-${process.pid}`
      await unlink(tmp).catch(() => {})
      if (link) {
        // Relative target: moving the repo does not break the link.
        await symlink(path.relative(path.dirname(to), from), tmp)
      } else {
        await copyFile(from, tmp)
      }
      await unlink(to).catch(() => {})
      await rename(tmp, to)
      console.log(`${link ? "linked" : "copied"} ${from} -> ${to}`)
    }

    if (initConfig) {
      const target = project
        ? path.join(process.cwd(), ".opencode", "pyrepl.jsonc")
        : customDir
          ? path.join(customDir, "pyrepl.jsonc")
          : path.join(globalConfigDir(), "opencode", "pyrepl.jsonc")
      if (await exists(target)) {
        console.log(`config exists, left alone: ${target}`)
      } else {
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, CONFIG_TEMPLATE)
        console.log(`wrote template config: ${target}`)
      }
    }
  } catch (e) {
    fail(`install failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  console.log(`done. Restart opencode so it picks up the pyrepl_* tools.`)
}

await main()
