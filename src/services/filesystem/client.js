// Minimal filesystem client — P2-E reads + P2-H writes.
//
// Only fs/promises. Reads: readFile + readdir. Writes: writeFile (atomic
// temp + rename) + mkdir recursive. No child_process, no shell, no URL
// handling, no delete/rename-exposed/move/chmod.
//
// Every method takes a sandbox-resolved { absolutePath, displayPath } (from
// ./sandbox.js) — never a raw user path. The resolved absolute path is
// containment-checked by the sandbox, so derived paths (parent dir, temp
// file in the same directory) cannot escape either. Errors are normalized
// to the FILESYSTEM_* contract and never contain the absolute workspace
// root, environment values, or stack traces.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 65536;
const HARD_MAX_BYTES = 1048576;

function fsError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function checkAborted(signal) {
    if (signal && signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

// Normalize raw fs errors. displayPath (root-relative) is the only path
// material ever placed in a message.
function mapFsError(e, displayPath, op) {
    if (!e || typeof e !== 'object') throw fsError(400, 'FILESYSTEM_UPSTREAM', `${op} failed`);
    if (e.code === 'ABORTED' || e.name === 'AbortError') {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
    const where = displayPath && displayPath !== '.' ? ` (${displayPath})` : '';
    if (e.code === 'ENOENT') throw fsError(400, 'FILESYSTEM_NOT_FOUND', `path does not exist${where}`);
    if (e.code === 'ENOTDIR') throw fsError(400, 'FILESYSTEM_NOT_DIRECTORY', `not a directory${where}`);
    if (e.code === 'EISDIR') throw fsError(400, 'FILESYSTEM_NOT_DIRECTORY', `is a directory, not a file${where}`);
    if (e.code === 'EACCES' || e.code === 'EPERM') {
        throw fsError(400, 'FILESYSTEM_PERMISSION_DENIED', `permission denied${where}`);
    }
    throw fsError(400, 'FILESYSTEM_UPSTREAM', `${op} failed${where}`);
}

function decodeUtf8(buf, displayPath) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        throw fsError(400, 'FILESYSTEM_INVALID_INPUT', `not a UTF-8 text file (${displayPath})`);
    }
}

async function readFile(resolved, { maxBytes = DEFAULT_MAX_BYTES, signal = null } = {}) {
    checkAborted(signal);
    const { absolutePath, displayPath } = resolved;
    let st;
    try {
        st = await fs.stat(absolutePath);
    } catch (e) {
        throw mapFsError(e, displayPath, 'read');
    }
    if (!st.isFile()) {
        throw fsError(400, 'FILESYSTEM_NOT_DIRECTORY', `not a file (${displayPath})`);
    }
    if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes)) {
        throw fsError(400, 'FILESYSTEM_INVALID_INPUT', 'maxBytes must be a number');
    }
    const cap = Math.min(Math.floor(maxBytes), HARD_MAX_BYTES);
    if (st.size > cap) {
        throw fsError(400, 'FILESYSTEM_TOO_LARGE', `file exceeds ${cap} bytes (${displayPath})`);
    }
    let buf;
    try {
        // signal:null is rejected by fs; only pass the option when set.
        buf = signal ? await fs.readFile(absolutePath, { signal }) : await fs.readFile(absolutePath);
    } catch (e) {
        throw mapFsError(e, displayPath, 'read');
    }
    checkAborted(signal);
    const content = decodeUtf8(buf.subarray(0, cap + 1), displayPath);
    return { path: displayPath, content, bytes: buf.length, truncated: false };
}

async function listDir(resolved, { signal = null } = {}) {
    checkAborted(signal);
    const { absolutePath, displayPath } = resolved;
    let entries;
    try {
        entries = signal
            ? await fs.readdir(absolutePath, { withFileTypes: true, signal })
            : await fs.readdir(absolutePath, { withFileTypes: true });
    } catch (e) {
        throw mapFsError(e, displayPath, 'list');
    }
    checkAborted(signal);
    return {
        path: displayPath,
        entries: entries.map((d) => ({
            name: d.name,
            type: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'symlink' : 'other'
        }))
    };
}

// Atomic UTF-8 text write: temp file in the same directory + rename.
// Overwrites existing files; refuses existing directories. Parent
// directories are created as needed — the parent of a contained path is
// itself contained, so this cannot escape the sandbox.
async function writeFile(resolved, { content, signal = null } = {}) {
    checkAborted(signal);
    const { absolutePath, displayPath } = resolved;
    if (typeof content !== 'string') {
        throw fsError(400, 'FILESYSTEM_INVALID_INPUT', 'content must be a string');
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > HARD_MAX_BYTES) {
        throw fsError(400, 'FILESYSTEM_TOO_LARGE', `content exceeds ${HARD_MAX_BYTES} bytes (${displayPath})`);
    }
    let existed = false;
    try {
        const st = await fs.lstat(absolutePath);
        existed = true;
        if (st.isDirectory()) {
            throw fsError(400, 'FILESYSTEM_ALREADY_EXISTS', `target is a directory (${displayPath})`);
        }
    } catch (e) {
        if (e && e.code === 'FILESYSTEM_ALREADY_EXISTS') throw e;
        if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) {
            throw mapFsError(e, displayPath, 'write');
        }
    }
    try {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    } catch (e) {
        throw mapFsError(e, displayPath, 'write');
    }
    checkAborted(signal);
    const tmp = `${absolutePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
        if (signal) await fs.writeFile(tmp, content, { encoding: 'utf8', signal });
        else await fs.writeFile(tmp, content, { encoding: 'utf8' });
        checkAborted(signal);
        await fs.rename(tmp, absolutePath);
    } catch (e) {
        try { await fs.unlink(tmp); } catch { /* best-effort temp cleanup */ }
        throw mapFsError(e, displayPath, 'write');
    }
    checkAborted(signal);
    return { path: displayPath, bytes, created: !existed };
}

// Recursive directory creation inside the sandbox. Existing directories
// succeed idempotently; an existing file at the target is an error.
async function makeDir(resolved, { signal = null } = {}) {
    checkAborted(signal);
    const { absolutePath, displayPath } = resolved;
    try {
        const st = await fs.lstat(absolutePath);
        if (st.isDirectory()) return { path: displayPath, created: false };
        throw fsError(400, 'FILESYSTEM_ALREADY_EXISTS', `already exists as a file (${displayPath})`);
    } catch (e) {
        if (e && e.code === 'FILESYSTEM_ALREADY_EXISTS') throw e;
        if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) {
            throw mapFsError(e, displayPath, 'mkdir');
        }
    }
    try {
        if (signal) await fs.mkdir(absolutePath, { recursive: true, signal });
        else await fs.mkdir(absolutePath, { recursive: true });
    } catch (e) {
        throw mapFsError(e, displayPath, 'mkdir');
    }
    checkAborted(signal);
    return { path: displayPath, created: true };
}

module.exports = { readFile, listDir, writeFile, makeDir, mapFsError, DEFAULT_MAX_BYTES, HARD_MAX_BYTES };
