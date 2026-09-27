// P3-9 Agent Checkpoint service: server-side execution-state persistence
// so an interrupted/paused run can resume from its exact logical state.
//
// This is execution-state persistence, NOT conversation persistence: the
// stored state is a JSON-serializable snapshot (phase, remaining queue,
// budgets used, correction log, pending proposal) — never AbortControllers,
// promises, streams, sockets, child handles, env vars, or secrets.
//
// Backends mirror WorkspaceService: DbCheckpointStore (Neon
// agent_checkpoints table when DATABASE_URL is set) with a deterministic
// process-local MemoryCheckpointStore fallback. No Redis, no new infra.
//
// Concurrency: every mutation is a compare-and-swap on `version`.
// update/claim pass expectedVersion; a mismatch throws CHECKPOINT_CONFLICT
// (409) so two simultaneous resumes can never duplicate execution.
const crypto = require('crypto');
const db = require('../db/db');

const STATUSES = ['running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function cpError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function iso(v) {
    if (!v) return new Date(0).toISOString();
    if (v instanceof Date) return v.toISOString();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function checkStatus(status) {
    if (!STATUSES.includes(status)) {
        throw cpError(400, 'CHECKPOINT_INVALID', `status must be one of: ${STATUSES.join(', ')}`);
    }
    return status;
}

function checkState(state) {
    if (state === undefined || state === null) return {};
    if (typeof state !== 'object' || Array.isArray(state)) {
        throw cpError(400, 'CHECKPOINT_INVALID', 'state must be an object');
    }
    // Serializable-only: functions, symbols, and friends never persist.
    try {
        return JSON.parse(JSON.stringify(state));
    } catch {
        throw cpError(400, 'CHECKPOINT_INVALID', 'state must be JSON-serializable');
    }
}

function newId() {
    return `checkpoint_${crypto.randomBytes(12).toString('hex')}`;
}

class MemoryCheckpointStore {
    constructor() {
        this.rows = new Map(); // checkpointId -> record
    }
    async create(record) {
        if (this.rows.has(record.checkpointId)) return null;
        const now = new Date().toISOString();
        const row = { ...record, version: 1, createdAt: now, updatedAt: now };
        this.rows.set(row.checkpointId, row);
        return { ...row, state: JSON.parse(JSON.stringify(row.state)) };
    }
    async getById(id) {
        const row = this.rows.get(id);
        return row ? { ...row, state: JSON.parse(JSON.stringify(row.state)) } : null;
    }
    // CAS update: applies only when the stored version matches.
    // Returns { record } on success, { conflict: true, current } on
    // version mismatch, { missing: true } when unknown.
    async update(id, patch, expectedVersion) {
        const row = this.rows.get(id);
        if (!row) return { missing: true };
        if (row.version !== expectedVersion) {
            return { conflict: true, current: { ...row } };
        }
        if (patch.status !== undefined) row.status = patch.status;
        if (patch.state !== undefined) row.state = patch.state;
        row.version += 1;
        row.updatedAt = new Date().toISOString();
        return { record: { ...row, state: JSON.parse(JSON.stringify(row.state)) } };
    }
    async clearForTests() {
        this.rows.clear();
    }
}

class DbCheckpointStore {
    async ensure() {
        const s = db.getSql();
        if (!s) throw new Error('DATABASE_URL not configured');
        if (!this._ddlDone) {
            await db.withRetry(() => s`
    CREATE TABLE IF NOT EXISTS agent_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT,
        workspace_id TEXT,
        status TEXT NOT NULL,
        state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )
            `);
            this._ddlDone = true;
        }
        return s;
    }
    map(row) {
        if (!row) return null;
        return {
            checkpointId: row.checkpointId,
            ownerId: row.ownerId,
            sessionId: row.sessionId,
            workspaceId: row.workspaceId,
            status: row.status,
            state: row.stateJson === undefined ? {} : row.stateJson,
            version: row.version,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt)
        };
    }
    async create(record) {
        const s = await this.ensure();
        const rows = await db.withRetry(() => s`
            INSERT INTO agent_checkpoints (checkpoint_id, owner_id, session_id, workspace_id, status, state_json)
            VALUES (${record.checkpointId}, ${record.ownerId}, ${record.sessionId}, ${record.workspaceId}, ${record.status}, ${JSON.stringify(record.state)}::jsonb)
            ON CONFLICT (checkpoint_id) DO NOTHING
            RETURNING checkpoint_id AS "checkpointId", owner_id AS "ownerId", session_id AS "sessionId",
                      workspace_id AS "workspaceId", status, state_json AS "stateJson", version,
                      created_at AS "createdAt", updated_at AS "updatedAt"
        `);
        return this.map(rows[0] || null);
    }
    async getById(id) {
        const s = db.getSql();
        if (!s) return null;
        const rows = await db.withRetry(() => s`
            SELECT checkpoint_id AS "checkpointId", owner_id AS "ownerId", session_id AS "sessionId",
                   workspace_id AS "workspaceId", status, state_json AS "stateJson", version,
                   created_at AS "createdAt", updated_at AS "updatedAt"
            FROM agent_checkpoints WHERE checkpoint_id = ${id}
        `);
        return this.map(rows[0] || null);
    }
    async update(id, patch, expectedVersion) {
        const s = await this.ensure();
        const rows = await db.withRetry(() => s`
            UPDATE agent_checkpoints
            SET status = COALESCE(${patch.status !== undefined ? patch.status : null}, status),
                state_json = COALESCE(${patch.state !== undefined ? JSON.stringify(patch.state) : null}::jsonb, state_json),
                version = version + 1,
                updated_at = NOW()
            WHERE checkpoint_id = ${id} AND version = ${expectedVersion}
            RETURNING checkpoint_id AS "checkpointId", owner_id AS "ownerId", session_id AS "sessionId",
                      workspace_id AS "workspaceId", status, state_json AS "stateJson", version,
                      created_at AS "createdAt", updated_at AS "updatedAt"
        `);
        if (rows[0]) return { record: this.map(rows[0]) };
        const current = await this.getById(id);
        if (!current) return { missing: true };
        return { conflict: true, current };
    }
    async clearForTests() {
        // No global wipe: tests use isolated ids / memory fallback.
    }
}

let sharedMemory = null;
function sharedMemoryStore() {
    if (!sharedMemory) sharedMemory = new MemoryCheckpointStore();
    return sharedMemory;
}

function resetSharedMemoryForTests() {
    sharedMemory = null;
}

function checkOwner(ownerId) {
    if (!ownerId || typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 256) {
        throw cpError(400, 'CHECKPOINT_INVALID', 'ownerId is required');
    }
    return ownerId.trim();
}

class AgentCheckpointService {
    constructor(store) {
        this.store = store || sharedMemoryStore();
    }
    static default() {
        return new AgentCheckpointService(db.getSql() ? new DbCheckpointStore() : sharedMemoryStore());
    }
    async create({ ownerId, sessionId = null, workspaceId = null, state = {} } = {}) {
        const who = checkOwner(ownerId);
        if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'string' || !sessionId)) {
            throw cpError(400, 'CHECKPOINT_INVALID', 'sessionId must be a non-empty string');
        }
        if (workspaceId !== undefined && workspaceId !== null && (typeof workspaceId !== 'string' || !workspaceId)) {
            throw cpError(400, 'CHECKPOINT_INVALID', 'workspaceId must be a non-empty string');
        }
        const rec = await this.store.create({
            checkpointId: newId(),
            ownerId: who,
            sessionId: sessionId === undefined ? null : sessionId,
            workspaceId: workspaceId === undefined ? null : workspaceId,
            status: 'running',
            state: checkState(state)
        });
        if (!rec) throw cpError(409, 'CHECKPOINT_CONFLICT', 'checkpoint id collision, retry creation');
        return rec;
    }
    // Owner-scoped read. Unknown, foreign, or session-mismatched ids all
    // look like 404 — one session can never probe another's checkpoint.
    async getById(checkpointId, ownerId, { sessionId = null } = {}) {
        if (typeof checkpointId !== 'string' || !checkpointId) {
            throw cpError(400, 'CHECKPOINT_INVALID', 'checkpointId is required');
        }
        const who = checkOwner(ownerId);
        const rec = await this.store.getById(checkpointId);
        if (!rec || rec.ownerId !== who) {
            throw cpError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
        }
        if (sessionId !== undefined && sessionId !== null && rec.sessionId !== sessionId) {
            throw cpError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
        }
        return rec;
    }
    // CAS mutation. expectedVersion is mandatory: stale writers get 409.
    async update(checkpointId, ownerId, { status = undefined, state = undefined, expectedVersion, sessionId = null } = {}) {
        if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
            throw cpError(400, 'CHECKPOINT_INVALID', 'expectedVersion must be a positive integer');
        }
        const current = await this.getById(checkpointId, ownerId, { sessionId });
        if (status !== undefined) checkStatus(status);
        const patch = {};
        if (status !== undefined) patch.status = status;
        if (state !== undefined) patch.state = checkState(state);
        const out = await this.store.update(current.checkpointId, patch, expectedVersion);
        if (out.missing) throw cpError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
        if (out.conflict) throw cpError(409, 'CHECKPOINT_CONFLICT', 'checkpoint was advanced by another resume');
        return out.record;
    }
    // Atomic resume claim: terminal checkpoints refuse, otherwise the
    // checkpoint flips to running exactly once per version.
    async claimForResume(checkpointId, ownerId, { sessionId = null, expectedVersion = null } = {}) {
        const current = await this.getById(checkpointId, ownerId, { sessionId });
        if (TERMINAL.has(current.status)) {
            throw cpError(400, 'CHECKPOINT_TERMINAL', `checkpoint is ${current.status}`);
        }
        const want = expectedVersion === undefined || expectedVersion === null ? current.version : expectedVersion;
        if (typeof want !== 'number' || !Number.isInteger(want) || want < 1) {
            throw cpError(400, 'CHECKPOINT_INVALID', 'expectedVersion must be a positive integer');
        }
        const out = await this.store.update(current.checkpointId, { status: 'running' }, want);
        if (out.missing) throw cpError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
        if (out.conflict) throw cpError(409, 'CHECKPOINT_CONFLICT', 'checkpoint was advanced by another resume');
        return out.record;
    }
    async cancel(checkpointId, ownerId, { sessionId = null } = {}) {
        const current = await this.getById(checkpointId, ownerId, { sessionId });
        if (TERMINAL.has(current.status)) {
            throw cpError(400, 'CHECKPOINT_TERMINAL', `checkpoint is ${current.status}`);
        }
        const out = await this.store.update(current.checkpointId, { status: 'cancelled' }, current.version);
        if (out.missing) throw cpError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
        if (out.conflict) throw cpError(409, 'CHECKPOINT_CONFLICT', 'checkpoint was advanced by another resume');
        return out.record;
    }
}

module.exports = { AgentCheckpointService, MemoryCheckpointStore, DbCheckpointStore, STATUSES, TERMINAL, resetSharedMemoryForTests };
