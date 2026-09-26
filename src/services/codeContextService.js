// P3-2 Code Context service: build a bounded, deterministic, serializable
// project context from a workspace directory.
//
// Safety (mirrors the filesystem sandbox, no startsWith()-only checks):
// - every path is resolved against the workspace root and verified with
//   path.relative containment, before AND after realpath (symlink escape)
// - skips generated/cache dirs, secret files, binaries, lockfiles
// - hard caps on depth / entries / files / bytes (centralized LIMITS)
// - output uses root-relative paths only; the absolute root never appears
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const LIMITS = {
    maxDepth: 8,
    maxWalkEntries: 2000,
    maxFiles: 20,
    maxBytesPerFile: 20000,
    maxTotalBytes: 200000
};

const SKIP_DIRS = new Set([
    '.git', 'node_modules', '.next', 'dist', 'build', 'out',
    'coverage', '.nyc_output', '.turbo', '.vercel', '.serverless',
    'tmp', 'temp', 'logs', '.venv', 'venv', '__pycache__', 'target',
    'vendor', '.idea', '.vscode', '.workspaces'
]);

const SOURCE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.java', '.cpp', '.c', '.h', '.hpp', '.rs', '.go', '.rb', '.php',
    '.vue', '.svelte', '.json', '.md', '.txt', '.text',
    '.yml', '.yaml', '.toml', '.css', '.html'
]);

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
    '.mp4', '.mp3', '.avi', '.mov', '.pdf',
    '.zip', '.tar', '.gz', '.tgz', '.exe', '.dll', '.so', '.dylib',
    '.class', '.o', '.a', '.woff', '.woff2', '.ttf', '.eot', '.otf'
]);

const LOCK_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
    'Gemfile.lock', 'composer.lock', 'poetry.lock', 'go.sum'
]);

// Basename match (case-insensitive): exact .env plus credential-ish names.
function isSecretFile(basename) {
    const b = basename.toLowerCase();
    if (b === '.env') return true;
    return b.includes('secret') || b.includes('credential') || b.includes('creds') ||
        b.includes('token') || b.includes('passwd') || b.includes('password') ||
        b === 'id_rsa' || b.startsWith('id_rsa.') ||
        b.endsWith('.pem') || b.endsWith('.key') || b.endsWith('.p12') || b.endsWith('.pfx');
}

function codeFromFsError(e) {
    if (e && (e.code === 'ABORTED' || e.name === 'AbortError')) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
    throw e;
}

function checkAborted(signal) {
    if (signal && signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

// Containment without startsWith(): relative must be non-empty... actually
// '' means the root itself (allowed); '..' prefix or absolute means escape.
function insideRoot(rootReal, candidate) {
    const rel = path.relative(rootReal, candidate);
    return !(rel.startsWith('..') || path.isAbsolute(rel));
}

function toDisplay(rootReal, abs) {
    const rel = path.relative(rootReal, abs);
    return rel === '' ? '.' : rel.split(path.sep).join('/');
}

async function realContained(rootReal, candidate) {
    let real;
    try {
        real = await fsp.realpath(candidate);
    } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        throw codeFromFsError(e);
    }
    return insideRoot(rootReal, real) ? real : false;
}

function languageOf(ext) {
    return ext.startsWith('.') ? ext.slice(1) : (ext || 'text');
}

function detectProjectType(names) {
    const has = (n) => names.has(n);
    if (has('package.json')) return 'node';
    if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) return 'python';
    if (has('go.mod')) return 'go';
    if (has('Cargo.toml')) return 'rust';
    if (has('pom.xml') || has('build.gradle')) return 'java';
    if (has('Gemfile')) return 'ruby';
    if (has('composer.json')) return 'php';
    return 'unknown';
}

const IMPORTANT_FILES = [
    'package.json', 'README.md', 'AGENTS.md', 'CLAUDE.md',
    'tsconfig.json', 'jsconfig.json', 'vercel.json',
    'docker-compose.yml', 'docker-compose.yaml', '.env.example'
];
const IMPORTANT_PREFIX = ['vite.config.', 'next.config.'];

function parsePackageJson(text) {
    try {
        const j = JSON.parse(text);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
        const pick = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        return {
            name: typeof j.name === 'string' ? j.name : null,
            scripts: pick(j.scripts),
            dependencies: pick(j.dependencies),
            devDependencies: pick(j.devDependencies)
        };
    } catch {
        return null;
    }
}

// Walk the tree breadth-first (sorted => deterministic), collecting a
// structure listing plus candidate source files. Never follows symlinks
// out of the root; unreadable entries are skipped, never fatal.
async function walk(rootReal, { signal = null } = {}) {
    const structure = [];
    const candidates = [];
    const topNames = new Set();
    let truncated = false;
    let walked = 0;
    const queue = [{ abs: rootReal, depth: 0 }];
    while (queue.length > 0) {
        checkAborted(signal);
        // Depth-first via stack gives stable order after sorting each level.
        const { abs, depth } = queue.pop();
        let entries;
        try {
            entries = await fsp.readdir(abs, { withFileTypes: true });
        } catch {
            continue;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const ent of entries) {
            walked += 1;
            if (walked > LIMITS.maxWalkEntries) {
                truncated = true;
                return { structure, candidates, topNames, truncated };
            }
            const name = ent.name;
            const child = path.join(abs, name);
            if (!insideRoot(rootReal, child)) continue;
            const display = toDisplay(rootReal, child);
            let isDir = ent.isDirectory();
            let isLink = ent.isSymbolicLink();
            if (isLink) {
                const real = await realContained(rootReal, child);
                if (!real) continue; // outside root or unreadable: skip
                let st = null;
                try {
                    st = await fsp.stat(real);
                } catch {
                    continue;
                }
                isDir = st.isDirectory();
                if (!isDir && !st.isFile()) continue;
            }
            if (depth === 0) topNames.add(name);
            if (isDir) {
                if (SKIP_DIRS.has(name)) continue;
                structure.push({ path: display, type: 'directory' });
                if (depth + 1 <= LIMITS.maxDepth) queue.push({ abs: child, depth: depth + 1 });
                else truncated = true;
            } else {
                const ext = path.extname(name).toLowerCase();
                if (BINARY_EXTENSIONS.has(ext) || LOCK_FILES.has(name) || isSecretFile(name)) continue;
                if (!SOURCE_EXTENSIONS.has(ext)) continue;
                let st = null;
                try {
                    st = await fsp.stat(isLink ? await fsp.realpath(child) : child);
                } catch {
                    continue;
                }
                if (!st.isFile()) continue;
                structure.push({ path: display, type: 'file', size: st.size });
                candidates.push({ path: display, abs: isLink ? await fsp.realpath(child).catch(() => null) : child, size: st.size, ext });
            }
        }
    }
    return { structure, candidates, topNames, truncated };
}

async function readCandidate(c, cap, remaining, signal) {
    // Full-or-skip: files larger than the per-file cap, or not fitting the
    // remaining budget, are skipped (truncated=true) rather than partially
    // read — a truncated source file would mislead the agent.
    if (c.abs === null) return null;
    if (c.size > cap) return { skipped: 'too-large' };
    if (c.size > remaining) return { skipped: 'budget' };
    let fh = null;
    try {
        checkAborted(signal);
        const buf = Buffer.alloc(c.size);
        fh = await fsp.open(c.abs, 'r');
        const { bytesRead } = await fh.read(buf, 0, c.size, 0);
        const slice = buf.subarray(0, bytesRead);
        if (slice.includes(0)) return null; // binary sniff: skip quietly
        try {
            const content = new TextDecoder('utf-8', { fatal: true }).decode(slice);
            return { content, bytes: bytesRead };
        } catch {
            return null; // not valid UTF-8: skip quietly
        }
    } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'EACCES' || e.code === 'EPERM')) return null;
        if (e instanceof RangeError) return null;
        throw codeFromFsError(e);
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
}

// Rank: explicit paths first, then important files, then entry-ish names,
// then everything else — all alphabetically inside each tier.
function rankCandidates(candidates, explicit) {
    const wanted = new Set((explicit || []).map((p) => String(p).replace(/\\/g, '/')));
    const score = (c) => {
        if (wanted.has(c.path)) return 0;
        const base = c.path.split('/').pop();
        if (IMPORTANT_FILES.includes(base) || IMPORTANT_PREFIX.some((p) => base.startsWith(p))) return 1;
        if (/^(index|main|app|server)\.[a-z]+$/i.test(base)) return 2;
        return 3;
    };
    return candidates.slice().sort((a, b) => (score(a) - score(b)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function buildContext(rootPath, { paths = null, maxFiles = LIMITS.maxFiles, maxBytesPerFile = LIMITS.maxBytesPerFile, maxTotalBytes = LIMITS.maxTotalBytes, signal = null } = {}) {
    if (typeof rootPath !== 'string' || !rootPath) {
        throw Object.assign(new Error('rootPath is required'), { status: 400, code: 'TOOL_INVALID_INPUT' });
    }
    let rootReal;
    try {
        rootReal = await fsp.realpath(rootPath);
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            throw Object.assign(new Error('workspace root does not exist'), { status: 400, code: 'TOOL_INVALID_INPUT' });
        }
        throw codeFromFsError(e);
    }
    const maxF = Math.min(Math.max(parseInt(maxFiles, 10) || LIMITS.maxFiles, 1), 100);
    const perFile = Math.min(Math.max(parseInt(maxBytesPerFile, 10) || LIMITS.maxBytesPerFile, 1), 100000);
    const budget = Math.min(Math.max(parseInt(maxTotalBytes, 10) || LIMITS.maxTotalBytes, 1), 1000000);

    // Explicit paths are resolved + containment-checked (traversal throws).
    let explicit = [];
    if (paths !== null && paths !== undefined) {
        if (!Array.isArray(paths)) {
            throw Object.assign(new Error('paths must be an array of strings'), { status: 400, code: 'TOOL_INVALID_INPUT' });
        }
        for (const p of paths) {
            if (typeof p !== 'string' || !p.trim() || p.includes('\0')) {
                throw Object.assign(new Error('invalid path in paths'), { status: 400, code: 'TOOL_INVALID_INPUT' });
            }
            const cand = path.resolve(rootReal, p);
            if (!insideRoot(rootReal, cand)) {
                throw Object.assign(new Error('path escapes the workspace'), { status: 400, code: 'TOOL_INVALID_INPUT' });
            }
            const real = await realContained(rootReal, cand);
            if (!real) {
                throw Object.assign(new Error('path escapes the workspace'), { status: 400, code: 'TOOL_INVALID_INPUT' });
            }
            explicit.push(toDisplay(rootReal, real));
        }
    }

    const { structure, candidates, topNames, truncated: walkTruncated } = await walk(rootReal, { signal });
    const ranked = rankCandidates(candidates, explicit);
    const files = [];
    const importantFiles = [];
    let remaining = budget;
    let truncated = walkTruncated;
    for (const c of ranked) {
        if (files.length >= maxF) {
            truncated = true;
            break;
        }
        checkAborted(signal);
        const got = await readCandidate(c, Math.min(perFile, 100000), remaining, signal);
        if (!got || got.skipped) {
            if (got && (got.skipped === 'too-large' || got.skipped === 'budget')) truncated = true;
            continue;
        }
        remaining -= got.bytes;
        const base = c.path.split('/').pop();
        const important = IMPORTANT_FILES.includes(base) || IMPORTANT_PREFIX.some((p) => base.startsWith(p));
        if (important) importantFiles.push(c.path);
        files.push({ path: c.path, language: languageOf(c.ext), content: got.content });
        if (remaining <= 0) {
            truncated = true;
            break;
        }
    }

    let pkg = null;
    const pkgEntry = files.find((f) => f.path.split('/').pop() === 'package.json');
    if (pkgEntry) pkg = parsePackageJson(pkgEntry.content);

    return {
        project: { root: '.', type: detectProjectType(topNames), package: pkg },
        structure,
        importantFiles,
        files: files.map(({ path: p, language, content }) => ({ path: p, language, content })),
        truncated,
        limits: {
            maxDepth: LIMITS.maxDepth,
            maxWalkEntries: LIMITS.maxWalkEntries,
            maxFiles: maxF,
            maxBytesPerFile: perFile,
            maxTotalBytes: budget
        }
    };
}

module.exports = {
    buildContext,
    LIMITS,
    SKIP_DIRS,
    SOURCE_EXTENSIONS,
    parsePackageJson,
    detectProjectType
};
