// TEMPORARY production env diagnostic — delete after diagnosis.
// Returns presence booleans ONLY. Never values, secrets, URLs, or headers.
const express = require('express');
const { useRemoteWorker } = require('../services/workerProvider');
const router = express.Router();

router.get('/debug-env', (req, res) => {
    res.json({
        workerUrlPresent: Boolean(process.env.WORKER_URL),
        workerSecretPresent: Boolean(process.env.WORKER_SHARED_SECRET),
        remoteResult: useRemoteWorker()
    });
});

module.exports = router;
