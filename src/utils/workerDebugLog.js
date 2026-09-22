// Shared diagnostic logger: console + persistent JSONL.
// Zero behavior change: never throws, never blocks request path, never logs secrets.
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.today-ai');
const LOG_FILE = path.join(LOG_DIR, 'worker-debug.log');

let dirReady = false;
function ensureDir() {
    if (dirReady) return;
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); dirReady = true; } catch {}
}

function safeString(v, max = 200) {
    if (v === undefined || v === null) return null;
    try { return String(v).slice(0, max); } catch { return null; }
}

function log(component, event, details = {}) {
    const ts = new Date().toISOString();
    const pid = process.pid;
    const entry = { ts, pid, component, event, ...details };
    // Single-line console for Vercel / Worker stdout
    try {
        const line = `[${component}] ${event} ${JSON.stringify(details)}`;
        console.warn(line);
    } catch {}
    // Async append-only JSONL, never throws or blocks
    try {
        ensureDir();
        const jsonl = JSON.stringify(entry) + '\n';
        fs.appendFile(LOG_FILE, jsonl, () => {});
    } catch {}
    // Never throw
}

module.exports = { log, LOG_FILE, LOG_DIR };
