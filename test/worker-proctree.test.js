// P0: Windows Worker process-tree cleanup regression tests.
//
// Bug: stopWorker/killProcess only terminated the powershell wrapper while
// the real `opencode serve` child survived (port squat + locked workspace).
// Fix: on Windows with a real wrapper pid, killProcess kills the whole
// tree up front via `taskkill /PID <wrapper> /T /F`.
//
// - Tree-kill test runs only on win32 (real processes, short-lived).
// - Idempotency + non-Windows behavior run everywhere.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const aw = require('../src/services/agentWorker');

const isWin = process.platform === 'win32';

describe('P0 process tree cleanup', () => {
    it('already-gone and null processes resolve idempotently', async () => {
        assert.deepEqual(await aw.killProcess(null), { alreadyGone: true, forced: false });
        assert.deepEqual(await aw.killProcess({ exitCode: 0 }), { alreadyGone: true, forced: false });
        assert.deepEqual(await aw.killProcess({ exitCode: 1 }), { alreadyGone: true, forced: false });
    });

    it('kills wrapper AND child tree on Windows (socket-hold proof)', { skip: !isWin }, async () => {
        const net = require('net');
        const { spawn } = require('child_process');
        const server = net.createServer();
        let closed = false;
        server.on('connection', (sock) => {
            // The grandchild is killed mid-connection: ECONNRESET is the
            // expected signal, not a test failure.
            sock.on('error', () => {});
            sock.resume();
            sock.once('close', () => { closed = true; });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        // Wrapper (powershell) -> child (node holding a socket to our
        // server). Only the child's death closes the socket: wrapper-only
        // kills leave `closed === false` and fail this test.
        const wrapper = spawn('powershell.exe', ['-NoProfile', '-Command',
            `node -e "require('net').connect(${port},'127.0.0.1').on('error',()=>process.exit(1)).resume()"`
        ], { windowsHide: true });
        try {
            const connected = await new Promise((resolve) => {
                const t = setTimeout(() => resolve(false), 15000);
                server.once('connection', () => { clearTimeout(t); resolve(true); });
            });
            assert.equal(connected, true, 'grandchild must connect before kill');
            assert.equal(wrapper.exitCode, null, 'wrapper must be alive before kill');
            const res = await aw.killProcess(wrapper, { gracefulMs: 1000 });
            assert.equal(res.alreadyGone, false);
            assert.equal(res.forced, true);
            assert.notEqual(wrapper.exitCode, null, 'wrapper must be gone');
            const deadline = Date.now() + 10000;
            while (!closed && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 100));
            }
            assert.equal(closed, true, 'grandchild must die with the tree (socket closed)');
        } finally {
            try { wrapper.kill('SIGKILL'); } catch {}
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('POSIX direct child still dies gracefully-first', { skip: isWin }, async () => {
        const { spawn } = require('child_process');
        const proc = spawn('sleep', ['60']);
        try {
            const res = await aw.killProcess(proc, { gracefulMs: 2000 });
            assert.equal(res.alreadyGone, false);
            assert.notEqual(proc.exitCode, null);
        } finally {
            try { proc.kill('SIGKILL'); } catch {}
        }
    });
});
