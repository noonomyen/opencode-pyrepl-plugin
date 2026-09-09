// Backward-compatible entry. The implementation now lives in domain
// modules (config/types/rpc/session/format/notify/tools) assembled by
// src/plugin.ts and exported via src/server.ts (the bun build entry).
export { PyReplPlugin } from "./server.ts"
export { default } from "./server.ts"
