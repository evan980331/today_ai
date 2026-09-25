// Filesystem sandbox resolver — P2-E read-only foundation.
//
// Single source of truth for the sandbox root: workspace.getWorkspaceRoot()
// (WORKSPACE_ROOT env, production OS-tmpdir fallback, dev ./.workspaces).
// No new fallback is invented here.
//
// Every user-supplied path goes through resolveSandboxPath(), which enforces:
// - string input, no null bytes
// - no absolute paths escaping the root (absolute paths are rejected unless
//   they resolve inside the root)
// - no raw or percent-encoded traversal (.., %2e, %2f, %5c, %00)
// - post-normalization containment via path.relative (never bare startsWith)
// - post-realpath containment, so symlinks cannot escape the root
//
// Returns { absolutePath, displayPath } where displayPath is always
// root-relative ('.' for the root itself) — the absolute root never leaks
// into tool results or error messages.
const fs = require('fs/promises');
const path = require('path');
const { getWorkspaceRoot } = require('../workspace');

function fsError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function isTraversalText(s) {
    // Raw '..' segments or percent-encoded dot/slash/backslash/NUL.
    if (/(^|[\/\\])\.\.([\/\\]|$)/.test(s)) return true;
    return /%(2e|2f|5c|00)/i.test(s);
}

// root override exists only as a test seam (temporary workspace roots).
async function resolveSandboxPath(userPath, opts = {}) {
    if (typeof userPath !== 'string') {
        throw fsError(400, 'FILESYSTEM_INVALID_INPUT', 'path must be a string');
    }
    if (userPath.includes('\0')) {
        throw fsError(400, 'FILESYSTEM_SANDBOX_VIOLATION', 'path contains null byte');
    }
    const root = opts.root || getWorkspaceRoot();
    let realRoot;
    try {
        realRoot = await fs.realpath(root);
    } catch {
        throw fsError(400, 'FILESYSTEM_CONFIG_MISSING', 'workspace root is unavailable');
    }
    const text = userPath.trim();
    if (isTraversalText(text)) {
        throw fsError(400, 'FILESYSTEM_SANDBOX_VIOLATION', 'path traversal is not allowed');
    }
    // Absolute paths are only accepted when they land inside the root.
    const candidate = path.isAbsolute(text) ? path.normalize(text) : path.resolve(realRoot, text || '.');
    let rel = path.relative(realRoot, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw fsError(400, 'FILESYSTEM_SANDBOX_VIOLATION', 'path escapes the workspace');
    }
    // Symlink check: resolve the nearest existing ancestor, then re-anchor.
    let probe = candidate;
    let tail = [];
    for (;;) {
        try {
            const st = await fs.lstat(probe);
            void st;
            break;
        } catch (e) {
            if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) {
                // Never leak the absolute path carried by raw fs errors.
                if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
                    throw fsError(400, 'FILESYSTEM_PERMISSION_DENIED', 'permission denied inside the workspace');
                }
                throw fsError(400, 'FILESYSTEM_UPSTREAM', 'filesystem request failed');
            }
            const parent = path.dirname(probe);
            if (parent === probe) {
                probe = realRoot;
                break;
            }
            tail.unshift(path.basename(probe));
            probe = parent;
            if (probe.length < realRoot.length && !realRoot.startsWith(probe)) {
                throw fsError(400, 'FILESYSTEM_SANDBOX_VIOLATION', 'path escapes the workspace');
            }
        }
    }
    let realProbe;
    try {
        realProbe = await fs.realpath(probe);
    } catch {
        throw fsError(400, 'FILESYSTEM_NOT_FOUND', 'path does not exist');
    }
    const realFinal = path.join(realProbe, ...tail);
    rel = path.relative(realRoot, realFinal);
    if (rel === '') {
        return { absolutePath: realRoot, displayPath: '.' };
    }
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw fsError(400, 'FILESYSTEM_SANDBOX_VIOLATION', 'path escapes the workspace');
    }
    const displayPath = rel.split(path.sep).join('/');
    return { absolutePath: realFinal, displayPath };
}

module.exports = { resolveSandboxPath };
