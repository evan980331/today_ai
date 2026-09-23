// Worker workspace MCP config.
//
// Design: each isolated worker workspace owns its own opencode.json so the
// OpenCode Server started with cwd=workspacePath can discover MCP servers.
// Secrets NEVER enter the file: only the `mcp` section is copied from the
// project-root opencode.json (which uses "{env:VAR}" placeholders), and
// credentials continue to flow exclusively via the worker process env.
//
// Single source of truth: project-root opencode.json. Adding a new MCP
// there automatically propagates to future workers; no second hardcoded copy.
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_CONFIG_PATH = path.join(PROJECT_ROOT, 'opencode.json');
const WORKER_CONFIG_NAME = 'opencode.json';

const MCP_CREDENTIAL_VARS = [
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN'
];

function isPlaceholderValue(v) {
    if (typeof v !== 'string') return false;
    return v.includes('your_') || v.includes('example') || v.includes('{env:');
}

// Load only the `mcp` section from the project config. Returns {} when the
// file is missing/unparseable so worker startup never hard-fails on config.
function loadProjectMcp() {
    let raw;
    try {
        raw = fs.readFileSync(PROJECT_CONFIG_PATH, 'utf8');
    } catch {
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.mcp || typeof parsed.mcp !== 'object') {
        return {};
    }
    return JSON.parse(JSON.stringify(parsed.mcp));
}

// Safety net: refuse to write anything that looks like a real secret value
// (as opposed to "{env:VAR}" placeholders). Scans the mcp JSON for actual
// credential material sourced from the current process env.
function containsRealSecret(mcp) {
    const hay = JSON.stringify(mcp);
    for (const name of MCP_CREDENTIAL_VARS) {
        const val = process.env[name];
        if (val && val.trim() && !isPlaceholderValue(val) && hay.includes(val.trim())) {
            return name;
        }
    }
    // Common real-token shapes that must never be baked into a file.
    if (/(ghp_[A-Za-z0-9]{10,}|ya29\.[\w-]{10,}|xox[bap]-)/.test(hay)) return 'token-shape';
    return null;
}

// Ensure <workspacePath>/opencode.json exists with the project MCP section.
// Idempotent: merges missing `mcp` keys into an existing file, never
// overwrites unrelated user content. Never writes secrets.
function ensureWorkerOpenCodeConfig(workspacePath) {
    const mcp = loadProjectMcp();
    const target = path.join(workspacePath, WORKER_CONFIG_NAME);
    const leak = containsRealSecret(mcp);
    if (leak) {
        throw Object.assign(new Error(`refusing to write MCP config containing real secret (${leak})`), { code: 'MCP_SECRET_LEAK' });
    }
    let existing = null;
    try {
        existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
        existing = null;
    }
    if (existing && typeof existing === 'object' && existing.mcp && typeof existing.mcp === 'object') {
        let changed = false;
        for (const [k, v] of Object.entries(mcp)) {
            if (!(k in existing.mcp)) {
                existing.mcp[k] = v;
                changed = true;
            }
        }
        if (changed) {
            fs.writeFileSync(target, JSON.stringify(existing, null, 2));
        }
        return { path: target, written: changed, mcpNames: Object.keys(existing.mcp) };
    }
    const doc = { mcp };
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(doc, null, 2));
    return { path: target, written: true, mcpNames: Object.keys(mcp) };
}

// Check credential presence WITHOUT logging values. Missing creds only warn;
// worker startup must not fail (general workers may not need MCP).
function mcpCredentialStatus() {
    const missing = [];
    for (const name of MCP_CREDENTIAL_VARS) {
        const v = process.env[name];
        if (!v || !v.trim() || isPlaceholderValue(v.trim())) missing.push(name);
    }
    return {
        github: !missing.includes('GITHUB_PERSONAL_ACCESS_TOKEN'),
        google: !missing.includes('GOOGLE_CLIENT_ID') && !missing.includes('GOOGLE_CLIENT_SECRET') && !missing.includes('GOOGLE_REFRESH_TOKEN'),
        missing
    };
}

function warnMissingMcpCredentials() {
    const st = mcpCredentialStatus();
    if (st.missing.length) {
        // Names only — never values.
        console.warn(`[Worker] MCP credentials missing: ${st.missing.join(', ')} (corresponding MCP servers may stay disabled)`);
    }
    return st;
}

module.exports = {
    PROJECT_CONFIG_PATH,
    MCP_CREDENTIAL_VARS,
    loadProjectMcp,
    ensureWorkerOpenCodeConfig,
    mcpCredentialStatus,
    warnMissingMcpCredentials
};
