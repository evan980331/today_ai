// Gmail Native Tools (read-only): gmail.search / gmail.getMessage / gmail.listThreads.
//
// Built with defineTool() per the P2-A contract. The Agent Core never imports
// this file — tools reach execution only via Planner -> ToolRegistry.
//
// Test seam: setGmailClientFactory(fn) injects a mock client factory;
// resetGmailClientFactory() restores the real Gmail REST client.
const { defineTool } = require('./tool');

let clientFactory = null;

function setGmailClientFactory(fn) {
    clientFactory = fn;
}

function resetGmailClientFactory() {
    clientFactory = null;
}

function getClient() {
    if (clientFactory) return clientFactory();
    const { createGmailClient } = require('../gmail/client');
    return createGmailClient();
}

function inputError(toolName, message) {
    return Object.assign(new Error(`${toolName}: ${message}`), { status: 400, code: 'TOOL_INVALID_INPUT' });
}

function checkMaxResults(toolName, value, def) {
    if (value === undefined || value === null) return def;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) {
        throw inputError(toolName, 'maxResults must be an integer between 1 and 50');
    }
    return value;
}

function checkAborted(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

// --- MIME helpers ---------------------------------------------------------

function decodeBody(data) {
    if (typeof data !== 'string' || !data) return '';
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    try {
        return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
        return '';
    }
}

function collectParts(part, out) {
    if (!part || typeof part !== 'object') return;
    out.push(part);
    if (Array.isArray(part.parts)) {
        for (const p of part.parts) collectParts(p, out);
    }
}

function stripHtml(html) {
    if (typeof html !== 'string') return '';
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);
}

// text/plain preferred; otherwise first text/html stripped to text.
function extractBody(payload) {
    const parts = [];
    collectParts(payload, parts);
    for (const p of parts) {
        if (p.mimeType === 'text/plain' && p.body && p.body.data) {
            const text = decodeBody(p.body.data).trim();
            if (text) return { body: text.slice(0, 4000), bodyMimeType: 'text/plain' };
        }
    }
    for (const p of parts) {
        if (p.mimeType === 'text/html' && p.body && p.body.data) {
            const text = stripHtml(decodeBody(p.body.data));
            if (text) return { body: text, bodyMimeType: 'text/html' };
        }
    }
    return { body: '', bodyMimeType: null };
}

function headerOf(headers, name) {
    if (!Array.isArray(headers)) return '';
    const h = headers.find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === name);
    return h && typeof h.value === 'string' ? h.value : '';
}

// --- Tool definitions -----------------------------------------------------

const gmailSearch = defineTool({
    name: 'gmail.search',
    capabilities: ['email.read', 'email.search'],
    description: 'Search Gmail messages (read-only) by query string',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Gmail search query, e.g. "from:boss newer_than:1d"' },
            maxResults: { type: 'number', description: 'max messages to return (1-50, default 10)' }
        },
        required: ['query']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: the deterministic planner passes the raw prompt string
        // as step input, so a bare string is treated as { query: input }.
        if (typeof input === 'string') input = { query: input };
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw inputError('gmail.search', 'input must be an object with query');
        }
        if (typeof input.query !== 'string' || !input.query.trim()) {
            throw inputError('gmail.search', 'query must be a non-empty string');
        }
        const maxResults = checkMaxResults('gmail.search', input.maxResults, 10);
        const client = getClient();
        const data = await client.searchMessages({
            query: input.query.trim().slice(0, 500),
            maxResults,
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        const messages = Array.isArray(data && data.messages)
            ? data.messages.map((m) => ({ id: String(m.id), threadId: String(m.threadId) }))
            : [];
        return {
            result: {
                query: input.query.trim(),
                messages,
                resultSizeEstimate: data && typeof data.resultSizeEstimate === 'number' ? data.resultSizeEstimate : messages.length
            },
            mcpTools: ['gmail.search']
        };
    }
});

const gmailGetMessage = defineTool({
    name: 'gmail.getMessage',
    capabilities: ['email.read'],
    description: 'Get a Gmail message by id (read-only), text/plain preferred',
    inputSchema: {
        type: 'object',
        properties: {
            messageId: { type: 'string', description: 'Gmail message id' }
        },
        required: ['messageId']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: a bare string is treated as { messageId: input }.
        if (typeof input === 'string') input = { messageId: input };
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw inputError('gmail.getMessage', 'input must be an object with messageId');
        }
        if (typeof input.messageId !== 'string' || !input.messageId.trim()) {
            throw inputError('gmail.getMessage', 'messageId must be a non-empty string');
        }
        const client = getClient();
        const data = await client.getMessage({
            messageId: input.messageId.trim(),
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        const headers = data && data.payload && Array.isArray(data.payload.headers) ? data.payload.headers : [];
        const { body, bodyMimeType } = extractBody(data ? data.payload : null);
        return {
            result: {
                id: String(data.id),
                threadId: String(data.threadId),
                labelIds: Array.isArray(data.labelIds) ? data.labelIds.slice() : [],
                subject: headerOf(headers, 'subject'),
                from: headerOf(headers, 'from'),
                date: headerOf(headers, 'date'),
                snippet: typeof data.snippet === 'string' ? data.snippet : '',
                body,
                bodyMimeType
            },
            mcpTools: ['gmail.getMessage']
        };
    }
});

const gmailListThreads = defineTool({
    name: 'gmail.listThreads',
    capabilities: ['email.read'],
    description: 'List Gmail threads (read-only), optional query filter',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'optional Gmail search query' },
            maxResults: { type: 'number', description: 'max threads to return (1-50, default 10)' }
        }
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: a bare string is treated as { query: input }.
        if (typeof input === 'string') input = { query: input };
        const obj = input === undefined || input === null ? {} : input;
        if (typeof obj !== 'object' || Array.isArray(obj)) {
            throw inputError('gmail.listThreads', 'input must be an object');
        }
        if (obj.query !== undefined && (typeof obj.query !== 'string' || !obj.query.trim())) {
            throw inputError('gmail.listThreads', 'query must be a non-empty string when provided');
        }
        const maxResults = checkMaxResults('gmail.listThreads', obj.maxResults, 10);
        const client = getClient();
        const data = await client.listThreads({
            query: typeof obj.query === 'string' ? obj.query.trim().slice(0, 500) : '',
            maxResults,
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        const threads = Array.isArray(data && data.threads)
            ? data.threads.map((t) => ({ id: String(t.id), snippet: typeof t.snippet === 'string' ? t.snippet : '' }))
            : [];
        return {
            result: {
                query: typeof obj.query === 'string' ? obj.query.trim() : '',
                threads,
                resultSizeEstimate: data && typeof data.resultSizeEstimate === 'number' ? data.resultSizeEstimate : threads.length
            },
            mcpTools: ['gmail.listThreads']
        };
    }
});

module.exports = {
    gmailSearch,
    gmailGetMessage,
    gmailListThreads,
    setGmailClientFactory,
    resetGmailClientFactory
};
