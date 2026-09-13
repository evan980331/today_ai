// Registry for Tool implementations (gmail / github / calendar / ...).
// Intentionally empty in production this round: it is the extension point,
// not a feature. Callers validate requested tool names here so unknown
// tools fail fast with 400 instead of reaching a runtime.
const { defineTool } = require('./tool');

const tools = new Map(); // name -> frozen tool

function register(toolDef) {
    const tool = toolDef && typeof toolDef.execute === 'function' && Object.isFrozen(toolDef)
        ? toolDef
        : defineTool(toolDef);
    if (tools.has(tool.name)) {
        throw Object.assign(new Error(`tool already registered: ${tool.name}`), { status: 409 });
    }
    tools.set(tool.name, tool);
    return tool;
}

function get(name) {
    return tools.get(name) || null;
}

function has(name) {
    return tools.has(name);
}

function list() {
    return Array.from(tools.values()).map((t) => ({ name: t.name, description: t.description }));
}

// Throws 400 listing every unknown name. Empty input is valid (no tools).
function validateAll(names) {
    const list = names === undefined || names === null ? [] : names;
    if (!Array.isArray(list)) throw Object.assign(new Error('tools must be an array of names'), { status: 400 });
    const unknown = list.filter((n) => typeof n !== 'string' || !tools.has(n));
    if (unknown.length) {
        throw Object.assign(new Error(`unknown tools: ${unknown.join(', ')}`), { status: 400 });
    }
    return list.slice();
}

function _clearForTests() {
    tools.clear();
}

module.exports = { register, get, has, list, validateAll, _clearForTests };
