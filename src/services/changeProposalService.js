// P3-7 Change Proposal service: agents never touch user files directly.
//
// A proposal is a read-only snapshot: { proposalId, workspaceId, sessionId,
// owner, changes[], createdAt, status }. Creation READS current contents
// and builds deterministic unified diffs — no writeFile/rm/rename runs in
// the creation phase, so proposing has no side effects.
//
// Writes happen only in apply(), and only when ALL of these hold:
//   1. proposal exists, is pending, unexpired, owner+session match;
//   2. every file re-read matches its recorded SHA-256 fingerprint
//      (external edits -> PROPOSAL_STALE, never overwritten);
//   3. every path re-passes workspace containment + the shared filesystem
//      sandbox (symlink escapes rejected);
//   4. the caller passed the ToolRegistry approval gate (change_apply has
//      needsApproval:true). Apply acts ONLY on the stored snapshot — the
//      client supplies a proposalId, never paths or contents — so an
//      approval can only ever mean "this exact proposal".
//
// Apply is atomic-ish: all changes re-validate first, then apply in order;
// on failure already-applied changes roll back (restore/unlink) without
// touching anything outside the proposal. No git reset/checkout involved.
//
// Storage is process-local (bounded TTL, lazy expiry). A restart wipes the
// store, so pre-restart ids resolve to PROPOSAL_NOT_FOUND — a proposal can
// never look approved after a restart.
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { WorkspaceService } = require('./workspaceService');
const { resolveSandboxPath } = require('./filesystem/sandbox');
const fsClient = require('./filesystem/client');

const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const MAX_CHANGES_PER_REQUEST = 10;
const MAX_FILES_PER_PROPOSAL = 20;
const MAX_FILE_SIZE = 20 * 1024;
const MAX_TOTAL_CHANGE_SIZE = 200 * 1024;
const MAX_DIFF_SIZE = 200 * 1024;

const STATUSES = ['pending', 'approved', 'rejected', 'applied', 'expired'];

const proposals = new Map(); // proposalId -> record (server-side only)

function proposalError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function checkAborted(signal) {
    if (signal && signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

function checkOwner(owner) {
    if (!owner || typeof owner !== 'string' || !owner.trim()) {
        throw proposalError(400, 'TOOL_INVALID_INPUT', 'authenticated owner is required');
    }
    return owner.trim();
}

// Secret-file predicate identical to codeContextService.isSecretFile
// (not exported there): exact .env plus credential-ish basenames.
function isSecretFile(basename) {
    const b = basename.toLowerCase();
    if (b === '.env') return true;
    return b.includes('secret') || b.includes('credential') || b.includes('creds') ||
        b.includes('token') || b.includes('passwd') || b.includes('password') ||
        b === 'id_rsa' || b.startsWith('id_rsa.') ||
        b.endsWith('.pem') || b.endsWith('.key') || b.endsWith('.p12') || b.endsWith('.pfx');
}

function fingerprint(oldContent) {
    return crypto.createHash('sha256').update(oldContent === null ? 'missing:' : `file:${oldContent}`, 'utf8').digest('hex');
}

function splitLines(text) {
    if (text === null || text === undefined) return null;
    return text.split('\n');
}

// Deterministic single-hunk unified diff for one file. Same
// (path, oldContent, newContent) always yields the same diff.
function buildDiff(relPath, oldContent, newContent) {
    const a = splitLines(oldContent) || [];
    const b = splitLines(newContent) || [];
    const header = `--- a/${relPath}\n+++ b/${relPath}\n@@ -${oldContent === null ? '0,0' : `1,${a.length}`} +${newContent === null ? '0,0' : `1,${b.length}`} @@\n`;
    let body = '';
    for (const line of a) body += `-${line}\n`;
    for (const line of b) body += `+${line}\n`;
    return header + body;
}

function decodeStrict(buf, rel) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        throw proposalError(400, 'INVALID_PATH', `not a UTF-8 text file: ${rel}`);
    }
}

// Workspace containment + shared sandbox verdict + secret policy.
// Returns { rel, resolved } where resolved is sandbox-resolved.
async function validatePath(rootReal, workspaceId, rel, index) {
    if (typeof rel !== 'string' || !rel.trim()) {
        throw proposalError(400, 'INVALID_PATH', `changes[${index}].path must be a non-empty string`);
    }
    const t = rel.trim().replace(/\\/g, '/');
    if (t === '.' || t === './' || t.startsWith('-') || t === '--') {
        throw proposalError(400, 'INVALID_PATH', `changes[${index}].path is not stageable`);
    }
    if (path.isAbsolute(t) || /^[a-zA-Z]:/.test(t) || t.startsWith('//')) {
        throw proposalError(400, 'INVALID_PATH', `changes[${index}].path must be workspace-relative`);
    }
    if (t.includes('\0') || /(^|\/)\.\.(\/|$)/.test(t)) {
        throw proposalError(400, 'INVALID_PATH', `changes[${index}].path must not contain traversal`);
    }
    if (/[*?[\]{}!#%~^$`"';|&<>]/.test(t)) {
        throw proposalError(400, 'INVALID_PATH', `changes[${index}].path must not contain glob or shell characters`);
    }
    if (isSecretFile(path.posix.basename(t))) {
        throw proposalError(400, 'INVALID_PATH', `changes[${index}].path is a secret file`);
    }
    const candidate = path.resolve(rootReal, t);
    const relCheck = path.relative(rootReal, candidate);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        throw proposalError(400, 'INVALID_PATH', `changes[${index}].path escapes the workspace`);
    }
    // Shared sandbox verdict (realpath containment: symlink escapes).
    let resolved;
    try {
        resolved = await resolveSandboxPath(`${workspaceId}/${relCheck.split(path.sep).join('/')}`);
    } catch (e) {
        if (e && e.code === 'ABORTED') throw e;
        throw proposalError(400, 'INVALID_PATH', `changes[${index}].path is outside the sandbox`);
    }
    // Scope the sandbox answer back to THIS workspace (the sandbox root
    // is broader than one workspace).
    const absReal = await fsp.realpath(resolved.absolutePath).catch(() => resolved.absolutePath);
    const scoped = path.relative(rootReal, absReal);
    if ((scoped.startsWith('..') || path.isAbsolute(scoped)) && scoped !== '') {
        throw proposalError(400, 'INVALID_PATH', `changes[${index}].path escapes the workspace`);
    }
    return { rel: relCheck.split(path.sep).join('/'), resolved };
}

async function readCurrent(resolved, rel) {
    let st;
    try {
        st = await fsp.lstat(resolved.absolutePath);
    } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        throw proposalError(400, 'INVALID_PATH', `cannot stat: ${rel}`);
    }
    if (!st.isFile()) {
        if (st.isDirectory()) throw proposalError(400, 'INVALID_PATH', `is a directory: ${rel}`);
        if (st.isSymbolicLink()) throw proposalError(400, 'INVALID_PATH', `is a symlink: ${rel}`);
        throw proposalError(400, 'INVALID_PATH', `not a regular file: ${rel}`);
    }
    if (st.size > MAX_FILE_SIZE) {
        throw proposalError(400, 'PROPOSAL_TOO_LARGE', `file exceeds size limit: ${rel}`);
    }
    const buf = await fsp.readFile(resolved.absolutePath);
    return decodeStrict(buf, rel);
}

async function resolveWorkspace({ workspaceId = null, sessionId = null, owner, workspaceService = null }) {
    const who = checkOwner(owner);
    const svc = workspaceService || WorkspaceService.default();
    if (workspaceId !== undefined && workspaceId !== null) {
        if (typeof workspaceId !== 'string' || !workspaceId) {
            throw proposalError(400, 'TOOL_INVALID_INPUT', 'workspaceId must be a non-empty string');
        }
        return svc.getById(workspaceId, who);
    }
    if (sessionId !== undefined && sessionId !== null) {
        if (typeof sessionId !== 'string' || !sessionId) {
            throw proposalError(400, 'TOOL_INVALID_INPUT', 'sessionId must be a non-empty string');
        }
        return svc.getCurrent(sessionId, who);
    }
    throw proposalError(400, 'TOOL_INVALID_INPUT', 'workspaceId or sessionId is required');
}

function publicCopy(rec) {
    return JSON.parse(JSON.stringify({
        proposalId: rec.proposalId,
        workspaceId: rec.workspaceId,
        sessionId: rec.sessionId,
        owner: rec.owner,
        changes: rec.changes,
        createdAt: rec.createdAt,
        status: rec.status
    }));
}

// Lazy expiry: touching an expired proposal marks it and reports expiry.
function loadProposal(proposalId, owner, sessionId) {
    if (typeof proposalId !== 'string' || !proposalId) {
        throw proposalError(400, 'TOOL_INVALID_INPUT', 'proposalId must be a non-empty string');
    }
    const who = checkOwner(owner);
    const rec = proposals.get(proposalId);
    if (!rec) {
        throw proposalError(404, 'PROPOSAL_NOT_FOUND', 'proposal not found');
    }
    if (rec.owner !== who) {
        throw proposalError(404, 'PROPOSAL_NOT_FOUND', 'proposal not found');
    }
    if (sessionId !== undefined && sessionId !== null && rec.sessionId !== sessionId) {
        throw proposalError(404, 'PROPOSAL_NOT_FOUND', 'proposal not found');
    }
    if (rec.status !== 'expired' && Date.now() - rec.createdAt > PROPOSAL_TTL_MS) {
        rec.status = 'expired';
    }
    if (rec.status === 'expired') {
        throw proposalError(400, 'PROPOSAL_EXPIRED', 'proposal has expired');
    }
    return rec;
}

async function propose({ workspaceId = null, sessionId = null, owner = null, changes = null, timeoutMs = null, signal = null, workspaceService = null } = {}) {
    checkAborted(signal);
    if (!Array.isArray(changes) || changes.length === 0) {
        throw proposalError(400, 'TOOL_INVALID_INPUT', 'changes must be a non-empty array');
    }
    if (changes.length > MAX_CHANGES_PER_REQUEST || changes.length > MAX_FILES_PER_PROPOSAL) {
        throw proposalError(400, 'PROPOSAL_TOO_LARGE', `at most ${Math.min(MAX_CHANGES_PER_REQUEST, MAX_FILES_PER_PROPOSAL)} changes per proposal`);
    }
    if (timeoutMs !== undefined && timeoutMs !== null && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs))) {
        throw proposalError(400, 'TOOL_INVALID_INPUT', 'timeoutMs must be a number');
    }
    const ws = await resolveWorkspace({ workspaceId, sessionId, owner, workspaceService });
    checkAborted(signal);
    let rootReal;
    try {
        rootReal = await fsp.realpath(ws.rootPath);
    } catch (e) {
        if (e && e.code === 'ABORTED') throw e;
        throw proposalError(400, 'TOOL_INVALID_INPUT', 'workspace directory is missing');
    }
    const seen = new Set();
    const built = [];
    let totalBytes = 0;
    for (let i = 0; i < changes.length; i += 1) {
        const c = changes[i];
        if (!c || typeof c !== 'object' || Array.isArray(c)) {
            throw proposalError(400, 'TOOL_INVALID_INPUT', `changes[${i}] must be an object`);
        }
        const { rel, resolved } = await validatePath(rootReal, ws.workspaceId, c.path, i);
        if (seen.has(rel)) {
            throw proposalError(400, 'TOOL_INVALID_INPUT', `changes[${i}] duplicates path: ${rel}`);
        }
        seen.add(rel);
        checkAborted(signal);
        const oldContent = await readCurrent(resolved, rel);
        let newContent = null;
        if (c.content !== undefined && c.content !== null) {
            if (typeof c.content !== 'string') {
                throw proposalError(400, 'TOOL_INVALID_INPUT', `changes[${i}].content must be a string or null`);
            }
            newContent = c.content;
        }
        if (oldContent === null && newContent === null) {
            throw proposalError(400, 'TOOL_INVALID_INPUT', `changes[${i}] deletes a file that does not exist`);
        }
        const newBytes = newContent === null ? 0 : Buffer.byteLength(newContent, 'utf8');
        if (newBytes > MAX_FILE_SIZE) {
            throw proposalError(400, 'PROPOSAL_TOO_LARGE', `changes[${i}] exceeds file size limit`);
        }
        totalBytes += newBytes;
        if (totalBytes > MAX_TOTAL_CHANGE_SIZE) {
            throw proposalError(400, 'PROPOSAL_TOO_LARGE', 'proposal exceeds total change size limit');
        }
        const operation = oldContent === null ? 'create' : (newContent === null ? 'delete' : 'update');
        const diff = buildDiff(rel, oldContent, newContent);
        if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_SIZE) {
            throw proposalError(400, 'PROPOSAL_TOO_LARGE', `changes[${i}] diff exceeds size limit`);
        }
        checkAborted(signal);
        built.push({ path: rel, operation, oldContent, newContent, diff, fingerprint: fingerprint(oldContent) });
    }
    const rec = {
        proposalId: `prop_${crypto.randomBytes(16).toString('hex')}`,
        workspaceId: ws.workspaceId,
        sessionId: ws.sessionId,
        owner: ws.owner,
        changes: built,
        createdAt: Date.now(),
        status: 'pending'
    };
    proposals.set(rec.proposalId, rec);
    return publicCopy(rec);
}

async function get({ proposalId = null, owner = null, sessionId = null, signal = null } = {}) {
    checkAborted(signal);
    const rec = loadProposal(proposalId, owner, sessionId === undefined ? null : sessionId);
    checkAborted(signal);
    return publicCopy(rec);
}

async function rejectProposal({ proposalId = null, owner = null, sessionId = null, signal = null } = {}) {
    checkAborted(signal);
    const rec = loadProposal(proposalId, owner, sessionId === undefined ? null : sessionId);
    if (rec.status !== 'pending') {
        throw proposalError(400, 'PROPOSAL_NOT_PENDING', `proposal is ${rec.status}`);
    }
    checkAborted(signal);
    rec.status = 'rejected';
    return publicCopy(rec);
}

async function applyProposal({ proposalId = null, owner = null, sessionId = null, signal = null, workspaceService = null } = {}) {
    checkAborted(signal);
    const rec = loadProposal(proposalId, owner, sessionId === undefined ? null : sessionId);
    if (rec.status !== 'pending') {
        throw proposalError(400, 'PROPOSAL_NOT_PENDING', `proposal is ${rec.status}`);
    }
    // The workspace must still exist and belong to the caller.
    const ws = await resolveWorkspace({ workspaceId: rec.workspaceId, owner, workspaceService });
    checkAborted(signal);
    let rootReal;
    try {
        rootReal = await fsp.realpath(ws.rootPath);
    } catch (e) {
        if (e && e.code === 'ABORTED') throw e;
        throw proposalError(400, 'TOOL_INVALID_INPUT', 'workspace directory is missing');
    }
    // Phase 1: re-validate everything (paths + fingerprints) before any write.
    const planned = [];
    for (let i = 0; i < rec.changes.length; i += 1) {
        const ch = rec.changes[i];
        const { resolved } = await validatePath(rootReal, ws.workspaceId, ch.path, i);
        checkAborted(signal);
        const current = await readCurrent(resolved, ch.path);
        if (fingerprint(current) !== ch.fingerprint) {
            throw proposalError(400, 'PROPOSAL_STALE', `file changed since proposal: ${ch.path}`);
        }
        planned.push({ change: ch, resolved, existed: current !== null, previous: current });
    }
    checkAborted(signal);
    // Approval milestone: validations passed under the registry gate.
    rec.status = 'approved';
    // Phase 2: apply in order; roll back this proposal's own changes on failure.
    const applied = [];
    try {
        for (const p of planned) {
            checkAborted(signal);
            if (p.change.operation === 'delete') {
                if (p.existed) await fsp.unlink(p.resolved.absolutePath);
            } else {
                await fsClient.writeFile(p.resolved, { content: p.change.newContent, signal });
            }
            applied.push(p);
        }
    } catch (e) {
        if (e && e.code === 'ABORTED') {
            // Abort still rolls back below; the abort itself propagates.
            // The proposal returns to pending so a later run may retry.
            try {
                await rollbackApplied(applied);
            } catch { /* best effort */ }
            rec.status = 'pending';
            throw e;
        }
        let rolledBack = true;
        try {
            await rollbackApplied(applied);
        } catch {
            rolledBack = false;
        }
        rec.status = 'pending';
        throw proposalError(400, 'PROPOSAL_APPLY_FAILED', `apply failed after ${applied.length} change(s), rolled back: ${rolledBack}`);
    }
    checkAborted(signal);
    rec.status = 'applied';
    return { proposalId: rec.proposalId, status: rec.status, applied: applied.map((p) => p.change.path) };
}

async function rollbackApplied(applied) {
    for (let i = applied.length - 1; i >= 0; i -= 1) {
        const p = applied[i];
        if (p.change.operation === 'delete') {
            if (p.existed && p.previous !== null) {
                await fsClient.writeFile(p.resolved, { content: p.previous });
            }
        } else if (!p.existed) {
            await fsp.unlink(p.resolved.absolutePath).catch(() => {});
        } else if (p.previous !== null) {
            await fsClient.writeFile(p.resolved, { content: p.previous });
        }
    }
}

function _clearForTests() {
    proposals.clear();
}

function _storeSizeForTests() {
    return proposals.size;
}

module.exports = {
    propose,
    get,
    rejectProposal,
    applyProposal,
    buildDiff,
    fingerprint,
    isSecretFile,
    PROPOSAL_TTL_MS,
    MAX_CHANGES_PER_REQUEST,
    MAX_FILES_PER_PROPOSAL,
    MAX_FILE_SIZE,
    MAX_TOTAL_CHANGE_SIZE,
    MAX_DIFF_SIZE,
    STATUSES,
    _clearForTests,
    _storeSizeForTests
};
