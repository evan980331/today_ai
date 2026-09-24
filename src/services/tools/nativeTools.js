// Central Native Tool registration.
//
// registerNativeTools(registry) registers every bundled read-only native
// tool (calculator + gmail.*) idempotently: already-registered names are
// skipped so tests and future startup wiring can call it safely.
//
// The ToolRegistry itself never imports concrete tools (dependency
// inversion); this module is the single composition point instead.
// Agent Core stays unaware of all implementations — it only sees the
// registry contract.
const { calculator } = require('./calculator');
const { gmailSearch, gmailGetMessage, gmailListThreads } = require('./gmail');

const NATIVE_TOOLS = [calculator, gmailSearch, gmailGetMessage, gmailListThreads];
const NATIVE_TOOL_NAMES = NATIVE_TOOLS.map((t) => t.name);

function registerNativeTools(registry) {
    const reg = registry || require('./toolRegistry');
    const registered = [];
    const skipped = [];
    for (const tool of NATIVE_TOOLS) {
        if (reg.has(tool.name)) {
            skipped.push(tool.name);
            continue;
        }
        reg.register(tool);
        registered.push(tool.name);
    }
    return { registered, skipped };
}

module.exports = { registerNativeTools, NATIVE_TOOLS, NATIVE_TOOL_NAMES };
