require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL || '';
const MCP_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS) || 60000;

function getOpencodeCmd() {
    return 'opencode';
}

function isServerUrlConfigured() {
    return !!OPENCODE_SERVER_URL && /^https?:\/\//.test(OPENCODE_SERVER_URL);
}

async function isServerReachable() {
    if (!isServerUrlConfigured()) return false;
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(OPENCODE_SERVER_URL, { signal: controller.signal }).catch(() => null);
        clearTimeout(t);
        return res !== null;
    } catch {
        return false;
    }
}

async function run(prompt, opts = {}) {
    if (process.env.MOCK_OPENCODE === 'true') {
        console.log(`[OpenCode Mock] ${prompt.slice(0,60)}`);
        await new Promise(r => setTimeout(r, 300));
        return `Hello (mock for: ${prompt.slice(0,100)})`;
    }
    const timeoutMs = opts.timeoutMs || MCP_TIMEOUT_MS;
    const useAttach = false;

    const args = ['run', '--auto'];
    if (useAttach) {
        args.push('--attach', OPENCODE_SERVER_URL);
    }
    args.push(prompt);

    console.log(`[OpenCode] opencode ${args.map(a => a.includes(' ') ? JSON.stringify(a) : a).join(' ')} (cwd=${PROJECT_ROOT})`);

    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer = null;
        let debounce = null;

        const child = spawn('opencode', args, {
            cwd: PROJECT_ROOT,
            env: process.env,
            shell: true,
            windowsHide: true
        });

        const cleanup = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (debounce) { clearTimeout(debounce); debounce = null; }
        };

        const tryResolve = () => {
            if (settled) return;
            const outTrim = stdout.trim();
            const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
            const cleanOut = stripAnsi(outTrim).replace(/^>.*$/gm, '').trim();
            if (cleanOut) {
                if (debounce) clearTimeout(debounce);
                debounce = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    try { child.kill(); } catch {}
                    resolve(cleanOut);
                }, 800);
            }
        };

        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
            const outTrim = stdout.trim();
            const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
            const cleanOut = stripAnsi(outTrim).replace(/^>.*$/gm, '').trim();
            if (cleanOut) {
                resolve(cleanOut);
                return;
            }
            const err = new Error(`OpenCode timeout after ${timeoutMs}ms`);
            err.code = 'TIMEOUT';
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
        }, timeoutMs);

        child.stdout.on('data', d => {
            stdout += d.toString();
            tryResolve();
        });
        child.stderr.on('data', d => {
            stderr += d.toString();
        });

        child.on('error', err => {
            if (settled) return;
            settled = true;
            cleanup();
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
        });

        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            cleanup();
            const outTrim = stdout.trim();
            const errTrim = stderr.trim();
            const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
            const cleanOut = stripAnsi(outTrim).replace(/^>.*$/gm, '').trim();
            const cleanErr = stripAnsi(errTrim).replace(/^>.*$/gm, '').trim();
            if (cleanOut) {
                resolve(cleanOut);
                return;
            }
            if (code !== 0) {
                const err = new Error(cleanErr || `opencode exit code ${code}${signal ? ` signal ${signal}` : ''}`);
                err.code = 'EXIT';
                err.stdout = stdout;
                err.stderr = stderr;
                err.exitCode = code;
                reject(err);
                return;
            }
            resolve(cleanErr || '');
        });
    });
}

module.exports = { run, isServerUrlConfigured, isServerReachable, MCP_TIMEOUT_MS, PROJECT_ROOT };
