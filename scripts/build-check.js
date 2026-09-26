// Vercel deploy gate: `npm run build`.
//
// Verifies the deployable surface without building anything:
//  1. every src/**/*.js file parses (node --check),
//  2. the Vercel/API layer never spawns processes or shells
//     (spawn/exec/execFile only in worker/runtime/git modules),
//  3. routes + frontend never hardcode OpenCode addresses.
// Exit non-zero with a clear message on any violation.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const failures = [];

function listJs(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            out.push(...listJs(full));
        } else if (entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

// 1. syntax check
for (const file of listJs(path.join(ROOT, 'src'))) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch {
        failures.push(`syntax error: ${path.relative(ROOT, file)}`);
    }
}

// 2. no process spawning outside the worker/runtime/git/command boundary
const SPAWN_ALLOWED = [
    'src/services/opencode.js',
    'src/services/agentWorker.js',
    'src/services/agentClient.js',
    'src/services/git.js',
    // P3-3: allowlisted executable spawns (never shell strings) live here.
    'src/services/commandService.js'
].map((p) => path.join(ROOT, p));
const spawnRe = /(^|[^A-Za-z0-9_.])(spawn|execFile|exec)\s*\(/;
for (const file of listJs(path.join(ROOT, 'src'))) {
    if (SPAWN_ALLOWED.includes(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
        const stripped = line.replace(/\/\/.*$/, '');
        if (spawnRe.test(stripped) && !/re\.exec|regex/i.test(stripped)) {
            failures.push(`process spawn in API layer: ${path.relative(ROOT, file)}:${i + 1}`);
        }
    });
}

// 3. no hardcoded OpenCode addresses in routes + frontend
const ADDR_FILES = [
    ...listJs(path.join(ROOT, 'src', 'routes')),
    ...listJs(path.join(ROOT, 'public'))
];
const addrRe = /localhost|127\.0\.0\.1|:4096/;
for (const file of ADDR_FILES) {
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
        const stripped = line.replace(/\/\/.*$/, '');
        if (addrRe.test(stripped)) {
            failures.push(`hardcoded address in ${path.relative(ROOT, file)}:${i + 1}: ${stripped.trim().slice(0, 80)}`);
        }
    });
}

if (failures.length) {
    console.error('build-check FAILED:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
}
console.log('build-check OK');
