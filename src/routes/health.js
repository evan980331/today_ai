const express = require('express');
const { getSql } = require('../db/db');
const router = express.Router();

router.get('/health', async (req, res) => {
    let db = 'not_configured';
    if (process.env.DATABASE_URL) {
        try {
            const sql = getSql();
            if (sql) {
                await sql`SELECT 1 as ok`;
                db = 'connected';
            } else {
                db = 'not_configured';
            }
        } catch (e) {
            db = 'error: ' + e.message.slice(0, 120);
        }
    }
    const mcp = process.env.OPENCODE_SERVER_URL ? `active (${process.env.OPENCODE_SERVER_URL})` : 'active';
    let runtime = null;
    try {
        runtime = require('../services/opencodeRuntime').describe();
    } catch {}
    // TEMPORARY diagnostic: prove that the live function's worker secret equals the dashboard's.
    // Truncated SHA-256 (8+4 hex chars) — not reversible, never raw value, never header.
    let workerSecretFingerprint = null;
    try {
        const s = process.env.WORKER_SHARED_SECRET || '';
        if (s) {
            const crypto = require('crypto');
            workerSecretFingerprint = `${crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)}...${crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(-4)}`;
        }
    } catch {}
    res.json({ status: 'ok', mcp, db, runtime, workerSecretFingerprint, uptime: process.uptime() });
});

module.exports = router;
