// P0.7: environment validation for the standalone worker entry.
// Fail closed: without WORKER_SHARED_SECRET the API would accept nobody
// (auth middleware denies all), so refuse to start instead.
function validateWorkerEnv() {
    const missing = [];
    if (!process.env.WORKER_SHARED_SECRET || !process.env.WORKER_SHARED_SECRET.trim()) {
        missing.push('WORKER_SHARED_SECRET');
    }
    if (missing.length) {
        console.error('[Worker ENV] Missing required environment variables:');
        missing.forEach((k) => console.error(`  - ${k}`));
        process.exit(1);
    }
    if (!process.env.WORKER_HOST || process.env.WORKER_HOST === '127.0.0.1') {
        console.log('[Worker ENV] bound to localhost (override with WORKER_HOST only behind TLS/network policy)');
    } else {
        console.warn(`[Worker ENV] WARNING: listening on ${process.env.WORKER_HOST} — ensure TLS + network policy`);
    }
    console.log('[Worker ENV] validation passed');
}

module.exports = { validateWorkerEnv };
