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
    res.json({ status: 'ok', mcp, db, uptime: process.uptime() });
});

module.exports = router;
