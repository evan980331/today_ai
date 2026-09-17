// TEMPORARY production env diagnostic — delete after diagnosis.
// Returns presence booleans ONLY. Never values, secrets, URLs, or headers.
const express = require('express');
const { useRemoteWorker } = require('../services/workerProvider');
const router = express.Router();

router.get('/debug-env', (req, res) => {
    const detail = require('../services/opencodeRuntime').describe();
    res.json({
        workerUrlPresent: Boolean(process.env.WORKER_URL),
        workerSecretPresent: Boolean(process.env.WORKER_SHARED_SECRET),
        remoteResult: useRemoteWorker(),
        describeMode: detail.mode,
        describeReason: detail.reason || null
    });
});

module.exports = router;
