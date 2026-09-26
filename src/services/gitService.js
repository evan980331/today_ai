// P3-5 Git Integration service: fixed, safe git operations only.
//
// Layers:
//   git_* tool
//     -> gitService.<op>()
//     -> WorkspaceService (owner/session scoped, derived rootPath)
//     -> commandService.execute()
//     -> commandPolicy
//     -> git process
//
// Rules:
// - No free-form git command: every op builds a FIXED executable/args
//   shape. There is no run()/executeRaw()/push/reset/clean/checkout.
// - No spawn/exec/execFile/shell here; no second timeout/kill/env
//   system — timeoutMs + AbortSignal pass straight to commandService.
//   ABORTED is rethrown, never swallowed.
// - cwd is always the workspace root (never caller input).
// - git_add paths are workspace-relative, validated + realpath-contained;
//   empty paths, ".", globs, option-like, absolute, traversal and symlink
//   escapes are rejected. No default `git add .`.
// - Results are agent-friendly and leak-free: no absolute paths, no env.
const fs = require('fs/promises');
const path = require('path');
const { WorkspaceService } = require('./workspaceService');

const MAX_LOG_LIMIT = 50;
const MAX_COMMIT_MESSAGE = 200;

function gitError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function checkAborted(signal) {
    if (signal && signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

function checkOwner(owner) {
    if (!owner || typeof owner !== 'string' || !owner.trim()) {
        throw gitError(400, 'TOOL_INVALID_INPUT', 'authenticated owner is required');
    }
    return owner;
}

function checkTimeout(timeoutMs) {
    if (timeoutMs === undefined || timeoutMs === null) return null;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
        throw gitError(400, 'TOOL_INVALID_INPUT', 'timeoutMs must be a number');
    }
    return timeoutMs;
}

async function resolveWorkspace({ workspaceId = null, sessionId = null, owner, workspaceService = null }) {
    const who = checkOwner(owner);
    const svc = workspaceService || WorkspaceService.default();
    if (workspaceId !== undefined && workspaceId !== null) {
        if (typeof workspaceId !== 'string' || !workspaceId) {
            throw gitError(400, 'TOOL_INVALID_INPUT', 'workspaceId must be a non-empty string');
        }
        return svc.getById(workspaceId, who);
    }
    if (sessionId !== undefined && sessionId !== null) {
        if (typeof sessionId !== 'string' || !sessionId) {
            throw gitError(400, 'TOOL_INVALID_INPUT', 'sessionId must be a non-empty string');
        }
        return svc.getCurrent(sessionId, who);
    }
    throw gitError(400, 'TOOL_INVALID_INPUT', 'workspaceId or sessionId is required');
}

// Validate git_add / git_diff pathspec args. Shared containment rules:
// relative only, no traversal/UNC/absolute/glob/option-like, and
// realpath-contained when the path already exists (symlink escape).
async function validatePaths(rootReal, paths, { allowEmpty = false } = {}) {
    if (paths === undefined || paths === null) {
        if (!allowEmpty) throw gitError(400, 'INVALID_PATH', 'paths must be a non-empty array');
        return [];
    }
    if (!Array.isArray(paths)) {
        throw gitError(400, 'INVALID_PATH', 'paths must be an array of strings');
    }
    if (paths.length === 0) {
        if (!allowEmpty) throw gitError(400, 'INVALID_PATH', 'paths must not be empty');
        return [];
    }
    const out = [];
    for (let i = 0; i < paths.length; i += 1) {
        const p = paths[i];
        if (typeof p !== 'string' || !p.trim()) {
            throw gitError(400, 'INVALID_PATH', `paths[${i}] must be a non-empty string`);
        }
        const t = p.trim();
        if (t === '.' || t === './' || t === '.\\') {
            throw gitError(400, 'INVALID_PATH', `paths[${i}] must not stage the whole workspace`);
        }
        if (t.startsWith('-') || t === '--') {
            throw gitError(400, 'INVALID_PATH', `paths[${i}] must not be option-like`);
        }
        if (path.isAbsolute(t) || /^[a-zA-Z]:/.test(t) || t.startsWith('\\\\')) {
            throw gitError(400, 'INVALID_PATH', `paths[${i}] must be workspace-relative`);
        }
        if (t.includes('\0') || t.includes('..')) {
            throw gitError(400, 'INVALID_PATH', `paths[${i}] must not contain traversal`);
        }
        if (/[*?[\]{}!#%~^$`"';|&<>]/.test(t)) {
            throw gitError(400, 'INVALID_PATH', `paths[${i}] must not contain glob or shell characters`);
        }
        const candidate = path.resolve(rootReal, t);
        const rel = path.relative(rootReal, candidate);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw gitError(400, 'INVALID_PATH', `paths[${i}] escapes the workspace`);
        }
        // Symlink escape: an existing path whose real location is outside
        // the workspace is rejected. Missing paths (new files) skip this.
        try {
            const real = await fs.realpath(candidate);
            const rel2 = path.relative(rootReal, real);
            if (rel2.startsWith('..') || path.isAbsolute(rel2)) {
                throw gitError(400, 'INVALID_PATH', `paths[${i}] escapes the workspace`);
            }
        } catch (e) {
            if (e && e.code === 'INVALID_PATH') throw e;
            if (e && e.code === 'ABORTED') throw e;
            // ENOENT or unreadable -> lexical check above is sufficient.
        }
        out.push(t);
    }
    return out;
}

function validateLimit(limit) {
    if (limit === undefined || limit === null) return 10;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
        throw gitError(400, 'TOOL_INVALID_INPUT', `limit must be an integer between 1 and ${MAX_LOG_LIMIT}`);
    }
    return limit;
}

function validateMessage(message) {
    if (typeof message !== 'string' || !message.trim()) {
        throw gitError(400, 'INVALID_COMMIT_MESSAGE', 'commit message must be a non-empty string');
    }
    const t = message.trim();
    if (t.length > MAX_COMMIT_MESSAGE) {
        throw gitError(400, 'INVALID_COMMIT_MESSAGE', `commit message must be at most ${MAX_COMMIT_MESSAGE} characters`);
    }
    if (/[\0\r\n]/.test(t)) {
        throw gitError(400, 'INVALID_COMMIT_MESSAGE', 'commit message must be a single line');
    }
    return t;
}

function isNotRepo(out) {
    const text = `${out.stdout || ''}\n${out.stderr || ''}`;
    return /not a git repository/i.test(text);
}

function baseResult(operation, ws, out) {
    return {
        ok: out.ok === true,
        operation,
        workspaceId: ws.workspaceId,
        exitCode: out.exitCode,
        stdout: typeof out.stdout === 'string' ? out.stdout : '',
        stderr: typeof out.stderr === 'string' ? out.stderr : '',
        timedOut: out.timedOut === true,
        durationMs: typeof out.durationMs === 'number' ? out.durationMs : 0,
        truncated: out.stdoutTruncated === true || out.stderrTruncated === true
    };
}

function failResult(operation, ws, out) {
    const base = baseResult(operation, ws, out);
    base.ok = false;
    base.code = isNotRepo(out) ? 'GIT_NOT_REPOSITORY' : 'GIT_FAILED';
    return base;
}

async function callGit({ ws, owner, args, timeoutMs, signal, commandService }) {
    const cmd = commandService || require('./commandService');
    try {
        return await cmd.execute({
            workspaceId: ws.workspaceId,
            owner,
            executable: 'git',
            args,
            cwd: null,
            timeoutMs,
            signal: signal || null
        });
    } catch (e) {
        if (e && e.code === 'ABORTED') throw e;
        if (e && e.code === 'TIMEOUT') {
            return {
                ok: false,
                code: 'TIMEOUT',
                workspaceId: ws.workspaceId,
                exitCode: null,
                stdout: '',
                stderr: '',
                timedOut: true,
                durationMs: 0,
                truncated: false
            };
        }
        throw e;
    }
}

function checkTimeoutResult(operation, ws, out) {
    if (out && out.code === 'TIMEOUT') {
        return { ...out, operation };
    }
    return null;
}

async function status({ workspaceId = null, sessionId = null, owner = null, timeoutMs = null, signal = null, workspaceService = null, commandService = null } = {}) {
    checkAborted(signal);
    const ws = await resolveWorkspace({ workspaceId, sessionId, owner, workspaceService });
    checkAborted(signal);
    const limit = checkTimeout(timeoutMs);
    const out = await callGit({ ws, owner, args: ['status', '--short', '--branch'], timeoutMs: limit, signal, commandService });
    const timedOut = checkTimeoutResult('status', ws, out);
    if (timedOut) return timedOut;
    checkAborted(signal);
    if (!out.ok) return failResult('status', ws, out);
    let branch = null;
    const entries = [];
    for (const line of out.stdout.split('\n')) {
        if (line.startsWith('## ')) {
            let head = line.slice(3);
            if (head.startsWith('No commits yet on ')) head = head.slice('No commits yet on '.length);
            const dot = head.indexOf('...');
            branch = (dot === -1 ? head : head.slice(0, dot)).trim() || null;
            continue;
        }
        if (!line.trim()) continue;
        const indexStatus = line[0] === ' ' ? null : line[0];
        const worktreeStatus = line[1] === ' ' ? null : line[1];
        const file = line.slice(3).trim();
        if (!file) continue;
        entries.push({ indexStatus, worktreeStatus, path: file });
    }
    return { ...baseResult('status', ws, out), code: 'GIT_OK', branch, entries };
}

async function diff({ workspaceId = null, sessionId = null, owner = null, paths = null, timeoutMs = null, signal = null, workspaceService = null, commandService = null } = {}) {
    checkAborted(signal);
    const ws = await resolveWorkspace({ workspaceId, sessionId, owner, workspaceService });
    let rootReal;
    try {
        rootReal = await fs.realpath(ws.rootPath);
    } catch (e) {
        if (e && e.code === 'ABORTED') throw e;
        throw gitError(400, 'TOOL_INVALID_INPUT', 'workspace directory is missing');
    }
    const valid = await validatePaths(rootReal, paths === undefined ? null : paths, { allowEmpty: true });
    checkAborted(signal);
    const limit = checkTimeout(timeoutMs);
    const args = valid.length ? ['diff', '--', ...valid] : ['diff'];
    const out = await callGit({ ws, owner, args, timeoutMs: limit, signal, commandService });
    const timedOut = checkTimeoutResult('diff', ws, out);
    if (timedOut) return timedOut;
    checkAborted(signal);
    if (!out.ok) return failResult('diff', ws, out);
    return { ...baseResult('diff', ws, out), code: 'GIT_OK', diff: out.stdout };
}

async function log({ workspaceId = null, sessionId = null, owner = null, limit = null, timeoutMs = null, signal = null, workspaceService = null, commandService = null } = {}) {
    checkAborted(signal);
    const ws = await resolveWorkspace({ workspaceId, sessionId, owner, workspaceService });
    const n = validateLimit(limit === undefined ? null : limit);
    checkAborted(signal);
    const t = checkTimeout(timeoutMs);
    const out = await callGit({ ws, owner, args: ['log', '--oneline', '-n', String(n)], timeoutMs: t, signal, commandService });
    const timedOut = checkTimeoutResult('log', ws, out);
    if (timedOut) return timedOut;
    checkAborted(signal);
    if (!out.ok) return failResult('log', ws, out);
    const entries = out.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
        const sp = line.indexOf(' ');
        return sp === -1 ? { hash: line, subject: '' } : { hash: line.slice(0, sp), subject: line.slice(sp + 1) };
    });
    return { ...baseResult('log', ws, out), code: 'GIT_OK', entries };
}

async function branch({ workspaceId = null, sessionId = null, owner = null, timeoutMs = null, signal = null, workspaceService = null, commandService = null } = {}) {
    checkAborted(signal);
    const ws = await resolveWorkspace({ workspaceId, sessionId, owner, workspaceService });
    checkAborted(signal);
    const t = checkTimeout(timeoutMs);
    const out = await callGit({ ws, owner, args: ['branch', '--show-current'], timeoutMs: t, signal, commandService });
    const timedOut = checkTimeoutResult('branch', ws, out);
    if (timedOut) return timedOut;
    checkAborted(signal);
    if (!out.ok) return failResult('branch', ws, out);
    return { ...baseResult('branch', ws, out), code: 'GIT_OK', branch: out.stdout.trim() || null };
}

async function add({ workspaceId = null, sessionId = null, owner = null, paths = null, timeoutMs = null, signal = null, workspaceService = null, commandService = null } = {}) {
    checkAborted(signal);
    const ws = await resolveWorkspace({ workspaceId, sessionId, owner, workspaceService });
    let rootReal;
    try {
        rootReal = await fs.realpath(ws.rootPath);
    } catch (e) {
        if (e && e.code === 'ABORTED') throw e;
        throw gitError(400, 'TOOL_INVALID_INPUT', 'workspace directory is missing');
    }
    const valid = await validatePaths(rootReal, paths, { allowEmpty: false });
    checkAborted(signal);
    const t = checkTimeout(timeoutMs);
    const out = await callGit({ ws, owner, args: ['add', '--', ...valid], timeoutMs: t, signal, commandService });
    const timedOut = checkTimeoutResult('add', ws, out);
    if (timedOut) return timedOut;
    checkAborted(signal);
    if (!out.ok) return failResult('add', ws, out);
    return { ...baseResult('add', ws, out), code: 'GIT_OK', paths: valid.slice() };
}

async function commit({ workspaceId = null, sessionId = null, owner = null, message = null, timeoutMs = null, signal = null, workspaceService = null, commandService = null } = {}) {
    checkAborted(signal);
    const ws = await resolveWorkspace({ workspaceId, sessionId, owner, workspaceService });
    const text = validateMessage(message);
    checkAborted(signal);
    const t = checkTimeout(timeoutMs);
    const out = await callGit({ ws, owner, args: ['commit', '-m', text], timeoutMs: t, signal, commandService });
    const timedOut = checkTimeoutResult('commit', ws, out);
    if (timedOut) return timedOut;
    checkAborted(signal);
    if (!out.ok) return failResult('commit', ws, out);
    return { ...baseResult('commit', ws, out), code: 'GIT_OK' };
}

module.exports = { status, diff, log, branch, add, commit, MAX_LOG_LIMIT, MAX_COMMIT_MESSAGE };
