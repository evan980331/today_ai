// P0.5-14: REAL Agent Worker integration (opt-in only).
// Run with:
//   OPENCODE_WORKER_INTEGRATION_TEST=true npm test
// Requires: Linux (or Windows dev) host with `opencode` binary + git.
// Without the flag the whole file SKIPS explicitly (never fake-passes).
//
// Flow: create workspace -> start worker (real `opencode serve`) -> health
// -> create OpenCode session -> prompt "Create a file named worker-test.txt
// containing exactly WORKER_OK." -> SSE events -> verify file on disk ->
// stop worker -> cleanup. Finally asserts: worker process gone, workspace
// removed.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENABLED = process.env.OPENCODE_WORKER_INTEGRATION_TEST === 'true';

describe('Agent Worker integration (real processes)', { skip: !ENABLED }, () => {
    const workerSvc = require('../src/services/agentWorker');
    const { OpenCodeClient } = require('../src/services/agentClient');

    const OLD_ROOT = process.env.WORKSPACE_ROOT;
    const ROOT = path.join(os.tmpdir(), `today-ai-worker-int-${Date.now()}`);
    let worker = null;

    before(() => {
        process.env.WORKSPACE_ROOT = ROOT;
    });

    after(async () => {
        if (worker) {
            await workerSvc.cleanupWorker(worker.workerId).catch(() => {});
            worker = null;
        }
        await fs.promises.rm(ROOT, { recursive: true, force: true }).catch(() => {});
        if (OLD_ROOT === undefined) delete process.env.WORKSPACE_ROOT;
        else process.env.WORKSPACE_ROOT = OLD_ROOT;
    });

    it('worker boots with isolated cwd and answers health', async () => {
        worker = await workerSvc.createWorker({ workspaceId: 'int-ws-1' });
        assert.ok(fs.existsSync(worker.workspacePath));
        const started = await workerSvc.startWorker(worker.workerId, { timeoutMs: 60000 });
        assert.equal(started.status, 'ready');
        assert.ok(started.port > 0);
        const h = await workerSvc.healthWorker(worker.workerId);
        assert.equal(h.available, true, `worker health must pass: ${h.reason || ''}`);
        worker = started;
    });

    it('agent creates the marker file inside the workspace (not repo root)', async () => {
        assert.ok(worker, 'worker must be running');
        const client = workerSvc.workerClient(worker.workerId);
        assert.ok(client instanceof OpenCodeClient);
        const ses = await client.createSession({ title: 'worker-file-probe' });
        assert.ok(ses.id && ses.id.startsWith('ses_'));

        const seen = [];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);
        let final = null;
        try {
            const [evRes, msgRes] = await Promise.all([
                client.subscribeSessionEvents(ses.id, {
                    signal: controller.signal,
                    onRawEvent: (e) => { seen.push(e.type); }
                }),
                client.promptSession(
                    ses.id,
                    'Create a file named worker-test.txt containing exactly WORKER_OK. Reply with DONE when finished.',
                    { signal: controller.signal, timeoutMs: 290000 }
                )
            ]);
            final = msgRes;
            void evRes;
        } finally {
            clearTimeout(timer);
        }
        assert.ok(final && typeof final.result === 'string');
        assert.ok(
            seen.includes('message.part.delta') || seen.includes('message.part.updated'),
            `expected streaming events, got: ${seen.slice(0, 8)}`
        );
        const marker = path.join(worker.workspacePath, 'worker-test.txt');
        assert.ok(fs.existsSync(marker), `agent must create ${marker} in workspace`);
        assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'WORKER_OK');
        // And NOT in the Today AI repository root.
        assert.ok(!fs.existsSync(path.join(process.cwd(), 'worker-test.txt')), 'must not write into repo root');
    });

    it('stop + cleanup removes process and workspace', async () => {
        assert.ok(worker, 'worker must be running');
        const out = await workerSvc.stopWorker(worker.workerId, { cleanup: true });
        assert.equal(out.status, 'stopped');
        assert.equal(workerSvc.getWorker(worker.workerId), null);
        assert.ok(!fs.existsSync(worker.workspacePath), 'workspace must be removed');
        worker = null;
    });
});
