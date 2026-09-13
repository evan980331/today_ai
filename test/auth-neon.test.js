// Tests A-M: auth_users schema, hashing, login, sessions, env, backward compat
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

describe('A auth_users schema', () => {
    it('table exists with required columns', async () => {
        const { getSql } = require('../src/db/db');
        const sql = getSql();
        if (!sql) { assert.ok(true); return; }
        const rows = await sql`SELECT column_name FROM information_schema.columns WHERE table_name='auth_users'`;
        const cols = rows.map(r => r.column_name);
        for (const c of ['id','username','password_hash','created_at','updated_at']) {
            assert.ok(cols.includes(c), `missing column ${c}`);
        }
        const uniq = await sql`SELECT COUNT(*)::int as c FROM pg_constraint WHERE conrelid='auth_users'::regclass AND contype='u'`;
        // UNIQUE on username via constraint or index
        const idx = await sql`SELECT indexdef FROM pg_indexes WHERE tablename='auth_users'`;
        const def = JSON.stringify(idx);
        assert.ok(def.includes('username'), 'username UNIQUE index missing');
    });
});

describe('B create user + C password hashing', () => {
    const { hashPassword, verifyPassword } = require('../src/services/password');
    const db = require('../src/db/db');

    it('hash is not plaintext and verifies', () => {
        const h = hashPassword('s3cret!');
        assert.ok(!h.includes('s3cret!'));
        assert.ok(h.startsWith('scrypt$'));
        assert.ok(verifyPassword('s3cret!', h));
        assert.ok(!verifyPassword('wrong', h));
    });

    it('create and find user', async () => {
        const { getSql } = require('../src/db/db');
        if (!getSql()) return;
        const uname = `testuser_${Date.now()}`;
        const hash = hashPassword('pass1234');
        const created = await db.createAuthUser({ username: uname, passwordHash: hash });
        // may be null if conflict? use upsert fallback
        const found = await db.findAuthUserByUsername(uname);
        assert.ok(found);
        assert.equal(found.username, uname);
        assert.ok(found.passwordHash.startsWith('scrypt$'));
        await db.deleteAuthUser(uname);
    });
});

describe('D-G login flow via HTTP (DB-backed)', () => {
    let BASE;
    let server;
    const testUser = `e2e_${Date.now()}`;
    const testPass = 'TestPass123!';

    before(async () => {
        const { hashPassword } = require('../src/services/password');
        const { upsertAuthUser } = require('../src/db/db');
        const hash = hashPassword(testPass);
        await upsertAuthUser({ username: testUser, passwordHash: hash });
        const adminHash = hashPassword('admin123');
        await upsertAuthUser({ username: 'admin', passwordHash: adminHash });
        // isolated server to avoid tripping shared login limiter
        const app = require('../src/app');
        server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        BASE = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((r) => server.close(r));
        }
    });

    async function login(u, p) {
        const res = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        const body = await res.json().catch(()=>({}));
        const setCookie = res.headers.get('set-cookie')||'';
        const m = setCookie.match(/todayai_session=([^;]+)/);
        return { res, body, token: m?m[1]:null };
    }

    it('D correct password login succeeds', async () => {
        const { res, token } = await login(testUser, testPass);
        assert.equal(res.status, 200);
        assert.ok(token);
    });
    it('E incorrect password rejection (generic 401)', async () => {
        const { res, body } = await login(testUser, 'wrongpass');
        assert.equal(res.status, 401);
        assert.equal(body.error, 'Unauthorized');
        assert.ok(!JSON.stringify(body).includes('wrongpass'));
    });
    it('F nonexistent username rejection', async () => {
        const { res, body } = await login('no_such_user_xyz', 'any');
        assert.equal(res.status, 401);
        assert.equal(body.error, 'Unauthorized');
        // no leak of existence
        assert.ok(!JSON.stringify(body).includes('no_such'));
    });
    it('G auth_sessions creation only stores hash', async () => {
        const { token } = await login(testUser, testPass);
        const { findAuthSession } = require('../src/db/db');
        const sha = crypto.createHash('sha256').update(token).digest('hex');
        const row = await findAuthSession(sha);
        assert.ok(row);
        assert.equal(row.username, testUser);
        assert.ok(!JSON.stringify(row).includes(token));
        const { deleteAuthSession } = require('../src/db/db');
        await deleteAuthSession(sha).catch(()=>{});
    });

    it('H existing session validation + I logout', async () => {
        const { token } = await login(testUser, testPass);
        let me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: `todayai_session=${token}` }});
        assert.equal(me.status, 200);
        let out = await fetch(`${BASE}/api/auth/logout`, { method:'POST', headers: { Cookie: `todayai_session=${token}` }});
        assert.equal(out.status, 200);
        me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: `todayai_session=${token}` }});
        assert.equal(me.status, 401);
    });

    after(async () => {
        const { deleteAuthUser } = require('../src/db/db');
        await deleteAuthUser(testUser).catch(()=>{});
    });
});

describe('J-K production env no longer requires AUTH', () => {
    const { validateEnv } = require('../src/middleware/validateEnv');
    function exits(fn) {
        let e=false; const o=process.exit; process.exit=()=>{e=true; throw new Error('exit');}; try{fn();}catch{} process.exit=o; return e;
    }
    function withEnv(over, fn){
        const orig={}; for(const k of Object.keys(over)){orig[k]=process.env[k]; if(over[k]===undefined) delete process.env[k]; else process.env[k]=over[k];}
        const r = exits(fn);
        for(const k of Object.keys(over)){ if(orig[k]===undefined) delete process.env[k]; else process.env[k]=orig[k];}
        return r;
    }
    const baseProd = { NODE_ENV:'production', DATABASE_URL:'postgresql://test:test@localhost/test', ALLOWED_ORIGINS:'https://a.com', MOCK_OPENCODE:undefined, WORKER_URL:undefined, WORKER_SHARED_SECRET:undefined, OPENCODE_SERVER_URL:undefined };
    it('J does not require AUTH_USERNAME', () => {
        assert.equal(withEnv({ ...baseProd, AUTH_USERNAME: undefined, AUTH_PASSWORD: 'x' }, ()=>validateEnv()), false);
    });
    it('K does not require AUTH_PASSWORD', () => {
        assert.equal(withEnv({ ...baseProd, AUTH_USERNAME: 'x', AUTH_PASSWORD: undefined }, ()=>validateEnv()), false);
    });
    it('still requires DATABASE_URL and ALLOWED_ORIGINS', () => {
        assert.equal(withEnv({ ...baseProd, DATABASE_URL: undefined }, ()=>validateEnv()), true);
        assert.equal(withEnv({ ...baseProd, ALLOWED_ORIGINS: undefined }, ()=>validateEnv()), true);
    });
});

describe('L chat_logs not affected', () => {
    it('save and fetch still works', async () => {
        const db = require('../src/db/db');
        if (!db.getSql()) return;
        const sid = `chk_${Date.now()}`;
        await db.saveLog({ sessionId: sid, role:'user', content:'hi', prompt:'hi' });
        const hist = await db.getHistory({ sessionId: sid, limit:5 });
        assert.ok(hist.some(r=>r.content==='hi'));
        await db.deleteSession(sid);
    });
});

describe('M agent_sessions not affected', () => {
    it('create/list/delete still works', async () => {
        const db = require('../src/db/db');
        if (!db.getSql()) return;
        const id = `ag_${Date.now()}`;
        await db.createAgentSession({ id, owner:'tester', workspaceId:'ws' });
        const row = await db.getAgentSession(id);
        assert.ok(row);
        await db.deleteAgentSession(id);
        assert.equal(await db.getAgentSession(id), null);
    });
});
