import type { PluginModule } from "@opencode-ai/plugin"
import { PyReplPlugin } from "./plugin.ts"

// Bundle entry (bun build src/server.ts) and package export target.
// Dev/shim entry src/pyrepl.ts re-exports from here.
export { PyReplPlugin }

// Default export for package-style loading (opencode.json `plugin` field,
// local or npm). Path plugins must export an id.
const PyReplPluginModule: PluginModule = {
  id: "pyrepl",
  server: PyReplPlugin,
}
export default PyReplPluginModule
