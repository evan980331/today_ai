// P3-1 Workspace service: entity lifecycle + isolation + path safety.
//
// Entity: { workspaceId, sessionId, owner, repository|null, rootPath,
//           status, createdAt, updatedAt }. status ∈ active|archived.
//
// Rules:
// - workspaceId is generated (ws_<hex>), never user-supplied; uniqueness
//   plus (sessionId, owner) scoping guarantees sessions never share.
// - rootPath is DERIVED from workspaceId via workspace.getWorkspacePath()
//   and created on disk. It is immutable: update attempts are rejected
//   (accepting a caller path would allow arbitrary Windows roots).
// - repository is identity-only metadata { provider, owner, name, ref? }.
//   No clone/checkout here.
// - archive() flips status; nothing is ever deleted (no FS removal).
// - All reads are owner-scoped; cross-owner access looks like 404.
// - Storage: DbWorkspaceStore when DATABASE_URL is configured, otherwise a
//   process-local MemoryWorkspaceStore. Constructor injection keeps unit
//   tests deterministic without a database.
const crypto = require('crypto');
const fs = require('fs');
const { getWorkspacePath, validateWorkspaceId } = require('./workspace');
const { validateSessionId } = require('./session');
const db = require('../db/db');
const { MemoryWorkspaceStore, DbWorkspaceStore } = require('./workspaceStore');

const STATUSES = ['active', 'archived'];

// Process-local shared memory store so separate default() service instances
// (e.g. one per HTTP request) see the same workspaces when no database is
// configured. The DbWorkspaceStore is stateless (all state in Postgres).
let sharedMemory = null;
function sharedMemoryStore() {
    if (!sharedMemory) sharedMemory = new MemoryWorkspaceStore();
    return sharedMemory;
}

function resetSharedMemoryForTests() {
    sharedMemory = null;
}

function wsError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function checkOwner(owner) {
    if (!owner || typeof owner !== 'string' || !owner.trim() || owner.length > 256) {
        throw wsError(400, 'WORKSPACE_INVALID', 'owner is required');
    }
    return owner.trim();
}

function checkRepository(repo) {
    if (repo === null || repo === undefined) return null;
    if (typeof repo !== 'object' || Array.isArray(repo)) {
        throw wsError(400, 'WORKSPACE_INVALID', 'repository must be an object or null');
    }
    for (const f of ['provider', 'owner', 'name']) {
        if (typeof repo[f] !== 'string' || !repo[f].trim() || repo[f].length > 128) {
            throw wsError(400, 'WORKSPACE_INVALID', `repository.${f} must be a non-empty string`);
        }
    }
    let ref = null;
    if (repo.ref !== undefined && repo.ref !== null) {
        if (typeof repo.ref !== 'string' || !repo.ref.trim() || repo.ref.length > 128) {
            throw wsError(400, 'WORKSPACE_INVALID', 'repository.ref must be a non-empty string');
        }
        if (/[\s~^:?*\\[\]]/.test(repo.ref) || repo.ref.includes('..')) {
            throw wsError(400, 'WORKSPACE_INVALID', 'repository.ref is not a valid ref');
        }
        ref = repo.ref.trim();
    }
    return { provider: repo.provider.trim(), owner: repo.owner.trim(), name: repo.name.trim(), ref };
}

function checkStatus(status) {
    if (!STATUSES.includes(status)) {
        throw wsError(400, 'WORKSPACE_INVALID', `status must be one of: ${STATUSES.join(', ')}`);
    }
    return status;
}

class WorkspaceService {
    constructor(store) {
        this.store = store || sharedMemoryStore();
    }
    static default() {
        return new WorkspaceService(db.getSql() ? new DbWorkspaceStore() : sharedMemoryStore());
    }
    async create({ sessionId, owner, repository = null } = {}) {
        validateSessionId(sessionId);
        const who = checkOwner(owner);
        const repo = checkRepository(repository);
        // Idempotent per active session workspace: at most one active
        // workspace per (sessionId, owner); repeats return the existing one.
        const existing = await this.store.getActiveBySession(sessionId, who);
        if (existing) return this._public(existing);
        const workspaceId = `ws_${crypto.randomBytes(8).toString('hex')}`;
        validateWorkspaceId(workspaceId);
        // Derived, containment-checked path — never caller-supplied.
        const rootPath = getWorkspacePath(workspaceId);
        await fs.promises.mkdir(rootPath, { recursive: true });
        const created = await this.store.create({
            workspaceId, sessionId, owner: who, repository: repo, rootPath, status: 'active'
        });
        if (!created) throw wsError(409, 'WORKSPACE_CONFLICT', 'workspace id collision, retry creation');
        return this._public(created);
    }
    async getById(workspaceId, owner) {
        if (typeof workspaceId !== 'string' || !workspaceId) {
            throw wsError(400, 'WORKSPACE_INVALID', 'workspaceId is required');
        }
        const who = checkOwner(owner);
        const row = await this.store.getById(workspaceId);
        if (!row || row.owner !== who) {
            throw wsError(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
        }
        return this._public(row);
    }
    async getCurrent(sessionId, owner) {
        validateSessionId(sessionId);
        const who = checkOwner(owner);
        const row = await this.store.getActiveBySession(sessionId, who);
        if (!row) throw wsError(404, 'WORKSPACE_NOT_FOUND', 'no active workspace for session');
        return this._public(row);
    }
    async update(workspaceId, owner, patch = {}) {
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            throw wsError(400, 'WORKSPACE_INVALID', 'patch must be an object');
        }
        if (patch.rootPath !== undefined) {
            // rootPath is derived from workspaceId; accepting a caller path
            // would allow arbitrary filesystem roots.
            throw wsError(400, 'WORKSPACE_INVALID', 'rootPath is derived and immutable');
        }
        if (patch.workspaceId !== undefined || patch.sessionId !== undefined || patch.owner !== undefined) {
            throw wsError(400, 'WORKSPACE_INVALID', 'workspaceId, sessionId and owner are immutable');
        }
        const current = await this.getById(workspaceId, owner);
        const next = {};
        if (patch.repository !== undefined) next.repository = checkRepository(patch.repository);
        if (patch.status !== undefined) next.status = checkStatus(patch.status);
        if (Object.keys(next).length === 0) return current;
        const updated = await this.store.update(current.workspaceId, next);
        if (!updated) throw wsError(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
        return this._public(updated);
    }
    async archive(workspaceId, owner) {
        const current = await this.getById(workspaceId, owner);
        if (current.status === 'archived') return current;
        const updated = await this.store.update(current.workspaceId, { status: 'archived' });
        if (!updated) throw wsError(404, 'WORKSPACE_NOT_FOUND', 'workspace not found');
        return this._public(updated);
    }
    _public(row) {
        return {
            workspaceId: row.workspaceId,
            sessionId: row.sessionId,
            owner: row.owner,
            repository: row.repository === undefined ? null : row.repository,
            rootPath: row.rootPath,
            status: row.status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        };
    }
}

module.exports = { WorkspaceService, STATUSES, resetSharedMemoryForTests };
