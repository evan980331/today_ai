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
    const url = process.env.OPENCODE_SERVER_URL || '';
    return !!url && /^https?:\/\//.test(url);
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

function parseMcpTools(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const tools = new Set();
    const lines = raw.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'tool_use' && obj.part && obj.part.tool) {
                tools.add(obj.part.tool);
            } else if (obj.part && obj.part.tool) {
                tools.add(obj.part.tool);
            }
        } catch {}
    }
    const re = /\b(github_\w+|gmail_\w+|google[_-]calendar\w*|calendar_\w+|webfetch)\b/gi;
    let m;
    while ((m = re.exec(raw)) !== null) {
        tools.add(m[1].toLowerCase());
    }
    return Array.from(tools);
}

async function run(prompt, opts = {}) {
    if (process.env.MOCK_OPENCODE === 'true') {
        if (process.env.NODE_ENV === 'production') {
            console.warn('[OpenCode] MOCK_OPENCODE=true in production - mock disabled for security');
        } else {
            console.log(`[OpenCode Mock] ${prompt.slice(0,60)}`);
            await new Promise(r => setTimeout(r, 300));
            const lower = prompt.toLowerCase();
            const mockTools = [];
            if (lower.includes('github') || lower.includes('repo')) mockTools.push('github_get_file_contents');
            if (lower.includes('calendar') || lower.includes('行程')) mockTools.push('google-calendar_list_events');
            if (lower.includes('gmail') || lower.includes('信件') || lower.includes('mail')) mockTools.push('gmail_search');
            return { result: `Hello (mock for: ${prompt.slice(0,100)})`, mcpTools: mockTools, raw: '' };
        }
    }
    const timeoutMs = opts.timeoutMs || MCP_TIMEOUT_MS;
    const useAttach = opts.useAttach !== false && isServerUrlConfigured() && await isServerReachable();

    const args = ['run'];
    if (useAttach) {
        args.push('--attach', OPENCODE_SERVER_URL);
    }
    args.push('--auto', prompt);

    const isWin = process.platform === 'win32';
    const logArgs = args.map(a => a.includes(' ') ? JSON.stringify(a) : a).join(' ');
    console.log(`[OpenCode] opencode ${logArgs} (cwd=${PROJECT_ROOT}, win=${isWin}, attach=${useAttach})`);

    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer = null;
        let debounce = null;

        const child = isWin
            ? spawn('powershell.exe', ['-NoProfile', '-Command', `opencode ${args.map(a => a.includes(' ') ? `"${a.replace(/"/g, '""')}"` : a).join(' ')}`], {
                cwd: PROJECT_ROOT,
                env: process.env,
                windowsHide: true
            })
            : spawn('opencode', args, {
                cwd: PROJECT_ROOT,
                env: process.env
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
                    const raw = stdout + '\n' + stderr;
                    resolve({ result: cleanOut, mcpTools: parseMcpTools(raw), raw });
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
            const raw = stdout + '\n' + stderr;
            if (cleanOut) {
                resolve({ result: cleanOut, mcpTools: parseMcpTools(raw), raw });
                return;
            }
            const err = new Error(`OpenCode timeout after ${timeoutMs}ms`);
            err.code = 'TIMEOUT';
            err.stdout = stdout;
            err.stderr = stderr;
            err.mcpTools = parseMcpTools(raw);
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
            err.mcpTools = parseMcpTools(stdout + '\n' + stderr);
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
            const raw = stdout + '\n' + stderr;
            const mcpTools = parseMcpTools(raw);
            if (cleanOut) {
                resolve({ result: cleanOut, mcpTools, raw });
                return;
            }
            if (code !== 0) {
                const err = new Error(cleanErr || `opencode exit code ${code}${signal ? ` signal ${signal}` : ''}`);
                err.code = 'EXIT';
                err.stdout = stdout;
                err.stderr = stderr;
                err.mcpTools = mcpTools;
                err.exitCode = code;
                reject(err);
                return;
            }
            resolve({ result: cleanErr || '', mcpTools, raw });
        });
    });
}

module.exports = { run, parseMcpTools, isServerUrlConfigured, isServerReachable, MCP_TIMEOUT_MS, PROJECT_ROOT };
