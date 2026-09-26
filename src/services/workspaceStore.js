// P3-1 workspace storage backends.
//
// Two implementations behind one minimal interface:
//   create(record) -> record | null (null on id conflict)
//   getById(id) -> record | null
//   getActiveBySession(sessionId, owner) -> record | null (latest active)
//   update(id, { repository?, status? }) -> record | null
//   clearForTests() — memory only; db rows are cleaned per-row by tests.
//
// MemoryWorkspaceStore: default when DATABASE_URL is absent; deterministic
// for unit tests. DbWorkspaceStore: Neon via db.js helpers when configured.
// Records use camelCase; timestamps are ISO strings in both backends.
const db = require('../db/db');

function iso(v) {
    if (!v) return new Date(0).toISOString();
    if (v instanceof Date) return v.toISOString();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function normalize(row) {
    if (!row) return null;
    return {
        workspaceId: row.workspaceId || row.id,
        sessionId: row.sessionId,
        owner: row.owner,
        repository: row.repository === undefined ? null : row.repository,
        rootPath: row.rootPath,
        status: row.status,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt)
    };
}

class MemoryWorkspaceStore {
    constructor() {
        this.rows = new Map(); // workspaceId -> record
    }
    async create(record) {
        if (this.rows.has(record.workspaceId)) return null;
        const now = new Date().toISOString();
        const row = {
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            owner: record.owner,
            repository: record.repository === undefined ? null : record.repository,
            rootPath: record.rootPath,
            status: record.status || 'active',
            createdAt: now,
            updatedAt: now
        };
        this.rows.set(row.workspaceId, row);
        return { ...row };
    }
    async getById(id) {
        const row = this.rows.get(id);
        return row ? { ...row } : null;
    }
    async getActiveBySession(sessionId, owner) {
        let best = null;
        for (const row of this.rows.values()) {
            if (row.sessionId !== sessionId || row.owner !== owner || row.status !== 'active') continue;
            if (!best || row.updatedAt >= best.updatedAt) best = row;
        }
        return best ? { ...best } : null;
    }
    async update(id, patch) {
        const row = this.rows.get(id);
        if (!row) return null;
        if (patch.repository !== undefined) row.repository = patch.repository;
        if (patch.status !== undefined) row.status = patch.status;
        row.updatedAt = new Date().toISOString();
        return { ...row };
    }
    async clearForTests() {
        this.rows.clear();
    }
}

class DbWorkspaceStore {
    async create(record) {
        return normalize(await db.createWorkspaceRow({
            id: record.workspaceId,
            sessionId: record.sessionId,
            owner: record.owner,
            repository: record.repository === undefined ? null : record.repository,
            rootPath: record.rootPath,
            status: record.status || 'active'
        }));
    }
    async getById(id) {
        return normalize(await db.getWorkspaceRow(id));
    }
    async getActiveBySession(sessionId, owner) {
        return normalize(await db.getActiveWorkspaceBySession(sessionId, owner));
    }
    async update(id, patch) {
        return normalize(await db.updateWorkspaceRow(id, patch));
    }
    async clearForTests() {
        // No global wipe: tests clean their own rows via deleteWorkspaceRow.
    }
}

module.exports = { MemoryWorkspaceStore, DbWorkspaceStore, normalize };
