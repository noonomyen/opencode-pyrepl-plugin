#!/usr/bin/env bun
/** Installs the pyrepl plugin into an opencode plugin directory.
 *
 * Copies both runtime files (pyrepl.ts + pyrepl_server.py) as siblings so
 * the install is self-contained: no dependency on this repo's location.
 * (opencode only loads *.{ts,js}, the .py sibling is ignored by the loader.)
 *
 * Usage:
 *   bun src/install.ts [--global|--project] [--link]
 *
 *   --global   install to ~/.config/opencode/plugins/ (default, all projects)
 *   --project  install to ./.opencode/plugins/ of the current directory
 *   --link     symlink instead of copy (tracks this repo; copy is default)
 */

import { copyFile, mkdir, symlink, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

function configDir(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config")
}

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url))
const FILES = ["pyrepl.ts", "pyrepl_server.py"]

function fail(message: string): never {
  console.error(`install: ${message}`)
  process.exit(1)
}

async function main() {
  const args = process.argv.slice(2)
  const link = args.includes("--link")
  const project = args.includes("--project")
  const global = args.includes("--global")
  if (project && global) fail("pass only one of --global or --project")
  if (args.some((a) => a !== "--link" && a !== "--project" && a !== "--global")) {
    fail("usage: bun src/install.ts [--global|--project] [--link]")
  }

  const dest = project
    ? path.join(process.cwd(), ".opencode", "plugins")
    : path.join(configDir(), "opencode", "plugins")

  // Guard: --project inside this repo would clobber its own shim layout.
  const repoPlugins = path.join(path.dirname(SRC_DIR), ".opencode", "plugins")
  if (path.resolve(dest) === path.resolve(repoPlugins)) {
    fail("cwd is the plugin repo itself; nothing to install (the shim already points at src/)")
  }

  await mkdir(dest, { recursive: true })

  for (const file of FILES) {
    const from = path.join(SRC_DIR, file)
    const to = path.join(dest, file)
    await unlink(to).catch(() => {})
    if (link) {
      await symlink(from, to)
    } else {
      await copyFile(from, to)
    }
    console.log(`${link ? "linked" : "copied"} ${from} -> ${to}`)
  }
  console.log(`done. Restart opencode so it picks up the pyrepl_* tools.`)
}

await main()
