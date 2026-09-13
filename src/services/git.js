// P0-6: Git workspace preparation abstraction.
// Every operation runs inside an explicit workspace directory and uses
// execFile with argument arrays — user input is NEVER interpolated into a
// shell command. Repository URLs are validated (https or ssh-like only).
const { execFile } = require('child_process');
const { resolveInWorkspace, getWorkspacePath } = require('./workspace');

// https://host/owner/repo(.git) | git@host:owner/repo(.git)
const REPO_URL_RE = /^(https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+|git@[A-Za-z0-9._-]+:[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,128}$/;

function validateRepoUrl(url) {
    if (!url || typeof url !== 'string' || url.length > 512) {
        throw Object.assign(new Error('Invalid repository URL'), { status: 400 });
    }
    if (!REPO_URL_RE.test(url)) {
        throw Object.assign(new Error('Repository URL must be https:// or git@ SSH form'), { status: 400 });
    }
    return url;
}

function validateRef(ref, name = 'ref') {
    if (!ref || typeof ref !== 'string' || !REF_RE.test(ref)) {
        throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
    }
    if (ref.startsWith('-') || ref.includes('..')) {
        throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
    }
    return ref;
}

function runGit(args, cwd, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                const e = new Error((stderr || err.message || '').slice(0, 2000));
                e.code = 'GIT_ERROR';
                e.stdout = stdout;
                return reject(e);
            }
            resolve({ stdout, stderr });
        });
    });
}

async function cloneRepository(url, workspaceId, { branch = null, timeoutMs } = {}) {
    validateRepoUrl(url);
    const dir = getWorkspacePath(workspaceId);
    const args = ['clone'];
    if (branch) args.push('--branch', validateRef(branch, 'branch'));
    args.push(url, '.');
    return runGit(args, dir, { timeoutMs });
}

async function fetchRepository(workspaceId, { remote = 'origin', timeoutMs } = {}) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(remote)) throw Object.assign(new Error('Invalid remote'), { status: 400 });
    const dir = getWorkspacePath(workspaceId);
    return runGit(['fetch', remote], dir, { timeoutMs });
}

async function createBranch(workspaceId, branch, { base = null } = {}) {
    validateRef(branch, 'branch');
    const dir = getWorkspacePath(workspaceId);
    const args = ['checkout', '-b', branch];
    if (base) args.push(validateRef(base, 'base ref'));
    return runGit(args, dir);
}

async function getStatus(workspaceId) {
    const dir = getWorkspacePath(workspaceId);
    const { stdout } = await runGit(['status', '--porcelain=v1', '--branch'], dir);
    return { status: stdout };
}

async function getDiff(workspaceId, { ref = null } = {}) {
    const dir = getWorkspacePath(workspaceId);
    const args = ref ? ['diff', validateRef(ref, 'ref')] : ['diff'];
    const { stdout } = await runGit(args, dir);
    return { diff: stdout.slice(0, 20000) };
}

async function commit(workspaceId, message, { author = null } = {}) {
    if (!message || typeof message !== 'string' || !message.trim() || message.length > 1000) {
        throw Object.assign(new Error('Invalid commit message'), { status: 400 });
    }
    const dir = getWorkspacePath(workspaceId);
    const args = ['commit', '-m', message.trim()];
    if (author) {
        if (!/^[A-Za-z0-9 ._-]{1,128}$/.test(author)) throw Object.assign(new Error('Invalid author'), { status: 400 });
        args.push(`--author=${author}`);
    }
    return runGit(args, dir);
}

async function push(workspaceId, { remote = 'origin', branch = null, timeoutMs } = {}) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(remote)) throw Object.assign(new Error('Invalid remote'), { status: 400 });
    const dir = getWorkspacePath(workspaceId);
    const args = branch ? ['push', remote, validateRef(branch, 'branch')] : ['push', remote];
    return runGit(args, dir, { timeoutMs });
}

// Scoped file read inside a workspace (traversal-safe).
async function readWorkspaceFile(workspaceId, subPath, maxBytes = 100000) {
    const full = resolveInWorkspace(workspaceId, subPath);
    const fs = require('fs');
    const stat = await fs.promises.stat(full);
    if (!stat.isFile()) throw Object.assign(new Error('Not a file'), { status: 400 });
    if (stat.size > maxBytes) throw Object.assign(new Error('File too large'), { status: 400 });
    return fs.promises.readFile(full, 'utf8');
}

module.exports = {
    validateRepoUrl,
    validateRef,
    cloneRepository,
    fetchRepository,
    createBranch,
    getStatus,
    getDiff,
    commit,
    push,
    readWorkspaceFile
};
