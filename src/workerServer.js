// P0.7: standalone Agent Worker entry point.
//
//   WORKER_SHARED_SECRET=... node src/workerServer.js
//
// Serves ONLY the worker API (src/routes/workers.js) — never the Today AI
// UI/API routes. This is what runs on the worker host (Linux VM/container,
// Docker image). Binds 127.0.0.1 by default; set WORKER_HOST explicitly if
// the Today AI API reaches it over the network (then it MUST be behind
// TLS/network policy — the shared secret is the only auth).
require('dotenv').config();
const express = require('express');
const workerRoutes = require('./routes/workers');
const { validateWorkerEnv } = require('./middleware/validateWorkerEnv');

validateWorkerEnv();

const app = express();
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'agent-worker', uptime: process.uptime() });
});

app.use('/', workerRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('[Worker Unhandled Error]', err && err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Worker error' });
});

const PORT = parseInt(process.env.WORKER_PORT, 10) || 4100;
const HOST = process.env.WORKER_HOST || '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
    console.log(`[Worker] listening on http://${HOST}:${PORT}`);
});

function shutdown(signal) {
    console.log(`[Worker] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
