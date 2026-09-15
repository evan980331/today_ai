// P0-5: adapter normalization layer.
// Maps raw OpenCode `--format json` events to the platform SSE schema.
// Raw OpenCode schema is NEVER exposed to the frontend.
//
// Platform events:
//   session.started  { sessionId, agentSessionId }
//   message.started  { sessionId }
//   text.delta       { content }
//   tool.started     { tool, callId }
//   tool.completed   { tool, callId }
//   message.completed{ sessionId, mcpTools }
//   error            { message }
//
// Raw OpenCode event types (verified, opencode 1.18.30):
//   step_start { part.type: step-start }
//   text       { part.type: text, part.text }
//   tool_use   { part.type: tool, part.tool, part.callID }
//   step_finish{ part.type: step-finish, part.reason: stop|tool-calls }
const PLATFORM_TYPES = [
    'session.started', 'message.started', 'text.delta',
    'tool.started', 'tool.completed',
    'command.started', 'command.completed',
    'message.completed', 'error'
];

function normalizeOpenCodeEvent(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
        return null; // malformed: caller skips, never crashes
    }
    const part = raw.part && typeof raw.part === 'object' ? raw.part : {};
    const sessionId = typeof raw.sessionID === 'string' ? raw.sessionID : null;
    switch (raw.type) {
        case 'step_start':
            return { type: 'message.started', sessionId };
        case 'text':
            if (typeof part.text !== 'string' || !part.text) return null;
            return { type: 'text.delta', content: part.text };
        case 'tool_use':
        case 'tool':
            if (!part.tool) return null;
            return {
                type: 'tool.started',
                tool: String(part.tool).toLowerCase(),
                callId: part.callID || part.callId || null
            };
        case 'tool_result':
        case 'tool_result_update':
            return {
                type: 'tool.completed',
                tool: part.tool ? String(part.tool).toLowerCase() : null,
                callId: part.callID || part.callId || null
            };
        case 'step_finish': {
            const reason = part.reason || 'stop';
            if (reason === 'stop') {
                return { type: 'message.completed', sessionId };
            }
            // reason tool-calls / aborted etc: step boundary, not final
            return null;
        }
        default:
            return null; // unknown future event: ignore, never crash
    }
}

// Parse one stdout line from `opencode run --format json`.
// Returns { event } | { malformed: true } | { empty: true } — never throws.
function parseStreamLine(line) {
    if (line === null || line === undefined) return { empty: true };
    const trimmed = String(line).trim();
    if (!trimmed) return { empty: true };
    if (!trimmed.startsWith('{')) return { malformed: true };
    try {
        return { event: JSON.parse(trimmed) };
    } catch {
        return { malformed: true };
    }
}

// Server-transport normalizer for GET /event objects (verified 1.18.30).
// partTypes is a caller-owned map partID -> part.type, filled from
// message.part.updated snapshots so deltas from non-text parts
// (reasoning/tool input) are never shown as AI text.
function normalizeServerEvent(raw, partTypes = {}) {
    if (!raw || typeof raw.type !== 'string') return null;
    const props = raw.properties && typeof raw.properties === 'object' ? raw.properties : {};
    switch (raw.type) {
        case 'message.part.delta': {
            if (props.field !== 'text' || typeof props.delta !== 'string' || !props.delta) return null;
            const known = partTypes[props.partID];
            if (known && known !== 'text') return null;
            return { type: 'text.delta', content: props.delta, partId: props.partID || null, messageId: props.messageID || null };
        }
        case 'message.part.updated': {
            const part = props.part && typeof props.part === 'object' ? props.part : null;
            if (!part) return null;
            if (part.id) partTypes[part.id] = part.type || 'unknown';
            if (part.type === 'tool') {
                return {
                    type: 'tool.started',
                    tool: String(part.tool || part.name || 'unknown').toLowerCase(),
                    callId: part.callID || part.id || null
                };
            }
            return null;
        }
        case 'message.updated': {
            const info = props.info && typeof props.info === 'object' ? props.info : null;
            if (info && info.role === 'assistant') {
                return { type: 'message.started', messageId: info.id || null };
            }
            return null;
        }
        default:
            return null;
    }
}

// Stateful SSE tool collector. Feeds RAW server /event objects through the
// single normalizeServerEvent() parser (no second parser) and accumulates
// distinct MCP tool names in first-seen order. Text deltas, idle frames and
// malformed events never count as tools.
function createToolCollector() {
    const partTypes = {};
    const tools = new Set();
    return {
        onRawEvent(raw) {
            const norm = normalizeServerEvent(raw, partTypes);
            if (norm && norm.type === 'tool.started' && norm.tool) {
                tools.add(norm.tool);
            }
        },
        tools() {
            return Array.from(tools);
        }
    };
}

// Union of MCP tool name lists: deduped (case-insensitive, already
// lowercased by the normalizers), first-seen order, non-strings dropped.
// Empty/absent inputs yield [].
function mergeMcpTools(...lists) {
    const out = [];
    const seen = new Set();
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const t of list) {
            if (typeof t !== 'string') continue;
            const name = t.toLowerCase();
            if (!name || seen.has(name)) continue;
            seen.add(name);
            out.push(name);
        }
    }
    return out;
}

module.exports = { PLATFORM_TYPES, normalizeOpenCodeEvent, normalizeServerEvent, parseStreamLine, createToolCollector, mergeMcpTools };
