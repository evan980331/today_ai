#!/usr/bin/env node
// One-time admin initialization: reads AUTH_USERNAME/AUTH_PASSWORD from env,
// hashes password and upserts auth_users. Never logs passwords.
require('dotenv').config();
const { initDb, upsertAuthUser, countAuthUsers } = require('../src/db/db');
const { hashPassword } = require('../src/services/password');

async function main() {
    const username = (process.env.AUTH_USERNAME || '').trim();
    const password = process.env.AUTH_PASSWORD || '';
    if (!username || !password) {
        console.error('[auth:setup] AUTH_USERNAME and AUTH_PASSWORD must be set in environment');
        process.exit(1);
    }
    if (username.length > 256) {
        console.error('[auth:setup] username too long');
        process.exit(1);
    }
    if (password.length < 4 || password.length > 1024) {
        console.error('[auth:setup] password length invalid (4-1024)');
        process.exit(1);
    }
    if (!process.env.DATABASE_URL) {
        console.error('[auth:setup] DATABASE_URL not set');
        process.exit(1);
    }
    const before = await countAuthUsers().catch(() => 0);
    const hash = hashPassword(password);
    // Never log password or hash
    await initDb();
    const row = await upsertAuthUser({ username, passwordHash: hash });
    if (!row) {
        console.error('[auth:setup] failed to upsert user');
        process.exit(1);
    }
    const after = await countAuthUsers();
    console.log(`[auth:setup] user "${username}" ready (users: ${before} -> ${after})`);
}

main().catch((e) => {
    console.error('[auth:setup] error:', e.message);
    process.exit(1);
});
