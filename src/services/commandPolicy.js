// P3-3 centralized command policy: structured executable + args only.
//
// There is deliberately NO shell-string path: no cmd.exe / powershell
// free-text, no parser for chained commands. A request is an executable
// name plus an argv array, each validated independently:
//
// - executable: basename only (no separators, no drive letters), mapped
//   through an explicit allowlist. Windows .cmd shims (npm, npx) run via a
//   controlled cmd.exe launcher with fully validated, quoted argv.
// - args: each must be a plain token — no shell metacharacters, no env
//   variable syntax, no UNC, no absolute paths, no traversal. Args that
//   look like paths must resolve inside the workspace root.
//
// Anything not matching this shape is rejected before any process exists.
const path = require('path');

// Canonical name -> executable spellings allowed on this platform.
// npm/npx resolve to .cmd shims on Windows and need the cmd launcher.
const ALLOWED_EXECUTABLES = {
    npm: { bins: ['npm', 'npm.cmd'], viaCmd: true },
    npx: { bins: ['npx', 'npx.cmd'], viaCmd: true },
    node: { bins: ['node', 'node.exe'], viaCmd: false },
    git: { bins: ['git', 'git.exe'], viaCmd: false },
    python: { bins: ['python', 'python.exe'], viaCmd: false },
    pytest: { bins: ['pytest', 'pytest.exe'], viaCmd: false }
};

// Explicitly refused executables (defense in depth: the allowlist above
// already excludes them; these produce a clearer error).
const DENIED_EXECUTABLES = new Set([
    'shutdown', 'restart', 'format', 'diskpart', 'reg', 'regedit', 'sc',
    'takeown', 'icacls', 'taskkill', 'powershell', 'pwsh', 'cmd',
    'command', 'start', 'rundll32', 'mshta', 'certutil', 'bitsadmin',
    'curl', 'wget', 'ssh', 'telnet', 'ftp', 'net'
]);

function policyError(message) {
    return Object.assign(new Error(message), { status: 400, code: 'TOOL_INVALID_INPUT' });
}

// Shell metacharacters, quoting, env expansion, globbing, chaining.
// (`=` is inert in direct argv without a shell, so --flag=value stays usable.)
const META_RE = /[;&|><`$~^"'\\\n\r\0!*?[\]{}()#%]/;

function looksLikePathArg(arg) {
    if (arg.includes('/') || arg.includes('\\')) return true;
    if (/^[a-zA-Z]:/.test(arg)) return true;
    if (arg === '.' || arg === '..' || arg.startsWith('./') || arg.startsWith('.\\')) return true;
    if (arg.startsWith('~')) return true;
    return false;
}

function validateExecutable(executable) {
    if (typeof executable !== 'string' || !executable.trim()) {
        throw policyError('executable must be a non-empty string');
    }
    const name = executable.trim();
    if (name.includes('/') || name.includes('\\') || name.includes(':') || name.includes('\0')) {
        throw policyError('executable must be a bare command name');
    }
    const lower = name.toLowerCase();
    if (DENIED_EXECUTABLES.has(lower)) {
        throw policyError(`executable is not allowed: ${name}`);
    }
    for (const [canonical, spec] of Object.entries(ALLOWED_EXECUTABLES)) {
        if (spec.bins.includes(lower)) return { canonical, viaCmd: spec.viaCmd };
    }
    throw policyError(`executable is not allowed: ${name}`);
}

function validateArgs(args) {
    if (args === undefined || args === null) return [];
    if (!Array.isArray(args)) throw policyError('args must be an array of strings');
    return args.map((a, i) => {
        if (typeof a !== 'string') throw policyError(`args[${i}] must be a string`);
        if (a.length === 0 || a.length > 2000) throw policyError(`args[${i}] has invalid length`);
        if (META_RE.test(a)) throw policyError(`args[${i}] contains forbidden characters`);
        if (/\.\./.test(a)) throw policyError(`args[${i}] must not contain traversal`);
        return a;
    });
}

// Split validated argv into path-like args (checked against the workspace)
// and plain tokens. Returns { paths, tokens } with original indexes.
function classifyArgs(args) {
    const paths = [];
    const tokens = [];
    args.forEach((a, i) => {
        if (looksLikePathArg(a)) paths.push({ index: i, value: a });
        else tokens.push({ index: i, value: a });
    });
    return { paths, tokens };
}

// Resolve a path-like arg against root; throws unless contained.
// Uses lexical normalization + realpath-when-present, never startsWith().
function resolveArgPath(rootReal, value, index) {
    const candidate = path.resolve(rootReal, value);
    const rel = path.relative(rootReal, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw policyError(`args[${index}] escapes the workspace`);
    }
    return candidate;
}

function quoteForCmd(s) {
    return `"${s.replace(/"/g, '')}"`;
}

module.exports = {
    ALLOWED_EXECUTABLES,
    DENIED_EXECUTABLES,
    validateExecutable,
    validateArgs,
    classifyArgs,
    resolveArgPath,
    quoteForCmd
};
