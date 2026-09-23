// P0-2: Workspace abstraction.
// Every agent execution gets an isolated workspace directory under WORKSPACE_ROOT.
// No hardcoded paths: root comes from env, default is OS temp in production-safe
// form and ./.workspaces for local Windows dev.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function getWorkspaceRoot() {
    if (process.env.WORKSPACE_ROOT && process.env.WORKSPACE_ROOT.trim()) {
        return path.resolve(process.env.WORKSPACE_ROOT.trim());
    }
    if (process.env.NODE_ENV === 'production') {
        return path.join(os.tmpdir(), 'today-ai-workspaces');
    }
    return path.resolve(process.cwd(), '.workspaces');
}

function validateWorkspaceId(id) {
    if (!id || typeof id !== 'string') throw Object.assign(new Error('workspace id is required'), { status: 400 });
    if (!WORKSPACE_ID_RE.test(id)) throw Object.assign(new Error('Invalid workspace id format'), { status: 400 });
    if (id === '.' || id === '..') throw Object.assign(new Error('Invalid workspace id'), { status: 400 });
    return id;
}

// Resolve <root>/<id> and guarantee it stays inside root (traversal protection).
function getWorkspacePath(id) {
    validateWorkspaceId(id);
    const root = getWorkspaceRoot();
    const resolved = path.resolve(root, id);
    const rel = path.relative(root, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw Object.assign(new Error('Workspace path escapes root'), { status: 400 });
    }
    return resolved;
}

// Resolve an arbitrary sub-path inside a workspace (for git ops etc.).
function resolveInWorkspace(id, subPath = '.') {
    const base = getWorkspacePath(id);
    const resolved = path.resolve(base, subPath || '.');
    const rel = path.relative(base, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw Object.assign(new Error('Path escapes workspace'), { status: 400 });
    }
    return resolved;
}

async function createWorkspace(id) {
    const dir = getWorkspacePath(id);
    await fs.promises.mkdir(dir, { recursive: true });
    // Each worker workspace owns its OpenCode config (mcp section only,
    // secrets stay in process env) so `opencode serve` started with
    // cwd=workspace can discover MCP servers.
    try {
        require('./workerMcpConfig').ensureWorkerOpenCodeConfig(dir);
    } catch (e) {
        console.warn(`[Workspace] could not write worker opencode.json: ${(e && e.message) || e}`);
    }
    return dir;
}

async function getWorkspace(id) {
    const dir = getWorkspacePath(id);
    try {
        const stat = await fs.promises.stat(dir);
        if (!stat.isDirectory()) throw new Error('not a directory');
        return { id, path: dir, created: false };
    } catch (e) {
        if (e.status === 400) throw e;
        throw Object.assign(new Error(`Workspace not found: ${id}`), { status: 404 });
    }
}

// Symlink-safe variant: resolves real paths (no symlink escape) before
// containment checks. Used by the worker API for untrusted sub-paths.
async function resolveRealInWorkspace(id, subPath = '.') {
    const base = getWorkspacePath(id);
    const realBase = await fs.promises.realpath(base).catch(() => base);
    const candidate = path.resolve(base, subPath || '.');
    const realCandidate = await fs.promises.realpath(candidate).catch(() => null);
    if (!realCandidate) {
        throw Object.assign(new Error('Path does not exist in workspace'), { status: 404 });
    }
    const rel = path.relative(realBase, realCandidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw Object.assign(new Error('Path escapes workspace'), { status: 400 });
    }
    return realCandidate;
}

async function removeWorkspace(id) {
    const dir = getWorkspacePath(id);
    await fs.promises.rm(dir, { recursive: true, force: true });
    return { ok: true, id };
}

async function cleanupWorkspace(id, maxAgeMs) {
    const dir = getWorkspacePath(id);
    try {
        const stat = await fs.promises.stat(dir);
        if (maxAgeMs && (Date.now() - stat.mtimeMs > maxAgeMs)) {
            await removeWorkspace(id);
            return { ok: true, id, removed: true };
        }
        return { ok: true, id, removed: false };
    } catch (e) {
        if (e.status === 400) throw e;
        return { ok: true, id, removed: false, missing: true };
    }
}

module.exports = {
    getWorkspaceRoot,
    validateWorkspaceId,
    getWorkspacePath,
    resolveInWorkspace,
    resolveRealInWorkspace,
    createWorkspace,
    getWorkspace,
    removeWorkspace,
    cleanupWorkspace
};
