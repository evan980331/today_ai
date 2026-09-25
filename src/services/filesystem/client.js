// Minimal read-only filesystem client — P2-E foundation.
//
// Only fs/promises, only reads: readFile + readdir. No child_process, no
// shell, no URL handling, no write/append/rm/unlink/rename/mkdir/chmod.
//
// Every method takes a sandbox-resolved { absolutePath, displayPath } (from
// ./sandbox.js) — never a raw user path. Errors are normalized to the
// FILESYSTEM_* contract and never contain the absolute workspace root,
// environment values, or stack traces.
const fs = require('fs/promises');

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

module.exports = { readFile, listDir, mapFsError, DEFAULT_MAX_BYTES, HARD_MAX_BYTES };
