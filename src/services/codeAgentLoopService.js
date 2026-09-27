// P3-6 Code Agent Loop: controlled orchestration over existing tools.
// P3-7: the loop NEVER writes user files directly. Edits become a
// change_propose step; the run then pauses with APPROVAL_REQUIRED and only
// continues (change_apply + verify) on a later run that carries the
// already-created proposalId plus a human approval. The loop never
// approves its own proposal.
// P3-8: bounded self-correction. On the resume path, a failing verify test
// diagnoses (structured test result + fresh context via existing tools),
// proposes ONE correction (server-supplied `corrections` queue, never
// model-generated), and pauses for human approval again. Runs are
// stateless: cross-run attempt accounting travels in `correctionOffset`
// (taken from the previous run's own output, never from the model), and
// MAX_CORRECTION_ATTEMPTS is enforced server-side. Per-run step/test/
// context budgets are shared across apply/verify/diagnose/propose —
// corrections never reset them.
//
// Every step still executes through the existing Agent Core (P2-I
// multi-step loop) via ToolRegistry.execute() with the existing permission
// gate and AbortSignal propagation. This module adds NO new process,
// filesystem, or git capability.
//
// Agent-owned step: { type, tool, input } where type is one of
// inspect|status|test|command|propose|apply and tool is allowlisted below.
// Plans never carry free-form executables: command inputs come only from
// the server-supplied `checks` argument and still pass command policy.
//
// Budgets (all hard): MAX_AGENT_STEPS = 12 total tool calls,
// MAX_TEST_RUNS = 3 test_runner calls, MAX_CONTEXT_CALLS = 4 code_context
// calls. Exhaustion yields code AGENT_STEP_LIMIT. Tool throws yield
// AGENT_TOOL_FAILED. Abort rethrows ABORTED untouched.
//
// git_add / git_commit / filesystem.write are never auto-called: they are
// rejected at plan validation and require explicit user approval through
// the registry.
const crypto = require('crypto');
const defaultCore = require('../agent/core');
const { WorkspaceService } = require('./workspaceService');
const proposalService = require('./changeProposalService');
const { AgentCheckpointService } = require('./agentCheckpointService');

const MAX_AGENT_STEPS = 12;
const MAX_TEST_RUNS = 3;
const MAX_CONTEXT_CALLS = 4;
const MAX_CORRECTION_ATTEMPTS = 3;
const MAX_GOAL_CHARS = 2000;
const MAX_EDITS = 10;
const MAX_CHECKS = 5;

// Tools the loop may invoke on its own. Proposal tools replace direct
// writes: the loop proposes and applies only via change_* tools, each
// still gated by ToolRegistry. git_add/git_commit/filesystem writes are
// deliberately absent.
const AUTO_TOOLS = new Set([
    'code_context',
    'filesystem.read',
    'filesystem.list',
    'git_status',
    'git_diff',
    'git_log',
    'git_branch',
    'command_execute',
    'test_runner',
    'change_propose',
    'change_get',
    'change_apply',
    'change_reject'
]);

// Explicitly refused even if requested: staging/commit/direct writes stay
// manual and approval-bound; anything else destructive has no API here.
const FORBIDDEN_TOOLS = new Set([
    'git_add',
    'git_commit',
    'git_push',
    'git_reset',
    'git_clean',
    'git_checkout',
    'git_restore',
    'git_merge',
    'git_rebase',
    'filesystem.write',
    'filesystem.createDirectory'
]);

const STEP_TYPES = new Set(['inspect', 'status', 'test', 'command', 'propose', 'apply']);

function loopError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function checkAborted(signal) {
    if (signal && signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

function checkOwner(owner) {
    if (!owner || typeof owner !== 'string' || !owner.trim()) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'authenticated owner is required');
    }
    return owner.trim();
}

function checkGoal(goal) {
    if (typeof goal !== 'string' || !goal.trim()) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'goal must be a non-empty string');
    }
    const text = goal.trim();
    if (text.length > MAX_GOAL_CHARS) {
        throw loopError(400, 'TOOL_INVALID_INPUT', `goal must be at most ${MAX_GOAL_CHARS} characters`);
    }
    return text;
}

function checkEdit(e, i, label) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', `${label}[${i}] must be an object`);
    }
    if (typeof e.path !== 'string' || !e.path.trim()) {
        throw loopError(400, 'TOOL_INVALID_INPUT', `${label}[${i}].path must be a non-empty string`);
    }
    // Loop-level path hygiene (the proposal service re-validates fully):
    // workspace-relative, no traversal, no absolute/UNC shapes.
    const rel = e.path.trim().replace(/\\/g, '/');
    if (rel === '.' || rel === './' || rel.startsWith('-') || rel === '--') {
        throw loopError(400, 'TOOL_INVALID_INPUT', `${label}[${i}].path is not a valid file path`);
    }
    if (rel.includes('\0') || /(^|\/)\.\.(\/|$)/.test(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('//')) {
        throw loopError(400, 'TOOL_INVALID_INPUT', `${label}[${i}].path must be a workspace-relative path`);
    }
    if (typeof e.content !== 'string' && e.content !== null) {
        throw loopError(400, 'TOOL_INVALID_INPUT', `${label}[${i}].content must be a string or null (null deletes)`);
    }
    return { path: e.path, content: e.content === undefined ? null : e.content };
}

function checkEdits(edits) {
    if (edits === undefined || edits === null) return [];
    if (!Array.isArray(edits)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'edits must be an array');
    }
    if (edits.length > MAX_EDITS) {
        throw loopError(400, 'TOOL_INVALID_INPUT', `edits must contain at most ${MAX_EDITS} entries`);
    }
    return edits.map((e, i) => checkEdit(e, i, 'edits'));
}

// P3-8 correction queue: server-supplied rounds of edits, one proposal per
// round. Never model-generated; each round still becomes its own proposal
// with its own proposalId through the existing approval flow.
function checkCorrections(corrections, maxCorrections) {
    if (corrections === undefined || corrections === null) return [];
    if (!Array.isArray(corrections)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'corrections must be an array');
    }
    if (corrections.length > maxCorrections) {
        throw loopError(400, 'TOOL_INVALID_INPUT', `corrections must contain at most ${maxCorrections} rounds`);
    }
    return corrections.map((round, r) => {
        if (!Array.isArray(round) || round.length === 0) {
            throw loopError(400, 'TOOL_INVALID_INPUT', `corrections[${r}] must be a non-empty array of edits`);
        }
        if (round.length > MAX_EDITS) {
            throw loopError(400, 'TOOL_INVALID_INPUT', `corrections[${r}] must contain at most ${MAX_EDITS} edits`);
        }
        return round.map((e, i) => checkEdit(e, i, `corrections[${r}]`));
    });
}

function checkCorrectionOffset(offset) {
    if (offset === undefined || offset === null) return 0;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'correctionOffset must be a non-negative integer');
    }
    return offset;
}

function checkChecks(checks) {
    if (checks === undefined || checks === null) return [];
    if (!Array.isArray(checks)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'checks must be an array');
    }
    if (checks.length > MAX_CHECKS) {
        throw loopError(400, 'TOOL_INVALID_INPUT', `checks must contain at most ${MAX_CHECKS} entries`);
    }
    return checks.map((c, i) => {
        if (!c || typeof c !== 'object' || Array.isArray(c)) {
            throw loopError(400, 'TOOL_INVALID_INPUT', `checks[${i}] must be an object`);
        }
        if (typeof c.executable !== 'string' || !c.executable.trim()) {
            throw loopError(400, 'TOOL_INVALID_INPUT', `checks[${i}].executable must be a non-empty string`);
        }
        if (c.args !== undefined && c.args !== null && !Array.isArray(c.args)) {
            throw loopError(400, 'TOOL_INVALID_INPUT', `checks[${i}].args must be an array`);
        }
        return { executable: c.executable, args: c.args === undefined || c.args === null ? [] : c.args };
    });
}

// Validate a structured plan step. Unknown or forbidden tools fail here,
// before anything runs. Tool inputs themselves are validated by each
// tool's own contract at execution time.
function validateSteps(steps) {
    if (!Array.isArray(steps)) {
        throw loopError(400, 'PLANNING_ERROR', 'plan steps must be an array');
    }
    return steps.map((s, i) => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
            throw loopError(400, 'PLANNING_ERROR', `plan step ${i} must be an object`);
        }
        if (!STEP_TYPES.has(s.type)) {
            throw loopError(400, 'PLANNING_ERROR', `plan step ${i} has unknown type`);
        }
        if (typeof s.tool !== 'string' || !s.tool) {
            throw loopError(400, 'PLANNING_ERROR', `plan step ${i} requires a tool name`);
        }
        if (FORBIDDEN_TOOLS.has(s.tool)) {
            throw loopError(400, 'PLANNING_ERROR', `plan step ${i} uses a forbidden tool: ${s.tool}`);
        }
        if (!AUTO_TOOLS.has(s.tool)) {
            throw loopError(400, 'PLANNING_ERROR', `plan step ${i} uses an unknown tool: ${s.tool}`);
        }
        return { type: s.type, tool: s.tool, input: s.input === undefined ? {} : s.input };
    });
}

// Deterministic plan builder (no model, no free text -> command mapping):
// inspect -> status -> checks -> baseline test -> [propose].
// Edits never become direct writes: at most one change_propose step is
// appended. Verify tests run only on the resume path (proposalId), after
// a human approval allowed change_apply to run.
function buildPlan({ goal, workspaceId = null, sessionId = null, edits = [], checks = [], proposalId = null } = {}) {
    checkGoal(goal);
    const base = { workspaceId, sessionId };
    if (proposalId !== undefined && proposalId !== null) {
        if (typeof proposalId !== 'string' || !proposalId) {
            throw loopError(400, 'TOOL_INVALID_INPUT', 'proposalId must be a non-empty string');
        }
        if (edits.length > 0) {
            throw loopError(400, 'TOOL_INVALID_INPUT', 'edits and proposalId are mutually exclusive');
        }
        return validateSteps([
            { type: 'apply', tool: 'change_apply', input: { proposalId } },
            { type: 'test', tool: 'test_runner', input: { ...base } }
        ]);
    }
    const steps = [
        { type: 'inspect', tool: 'code_context', input: { ...base } },
        { type: 'status', tool: 'git_status', input: { ...base } }
    ];
    for (const c of checks) {
        steps.push({ type: 'command', tool: 'command_execute', input: { ...base, executable: c.executable, args: c.args } });
    }
    steps.push({ type: 'test', tool: 'test_runner', input: { ...base } });
    if (edits.length > 0) {
        steps.push({ type: 'propose', tool: 'change_propose', input: { ...base, changes: edits } });
    }
    return validateSteps(steps);
}

function isAbortError(err) {
    return !!err && (err.code === 'ABORTED' || err.name === 'AbortError');
}

function emit(onEvent, event) {
    if (typeof onEvent === 'function') {
        try {
            onEvent(event);
        } catch {
            // Listener failures never break the loop.
        }
    }
}

function testSummaryFrom(record) {
    // record.result is the tool's result data (core returns out.result).
    // Tolerate one extra { result } wrapper (stub cores in tests).
    let data = record && record.result && typeof record.result === 'object' ? record.result : {};
    if (typeof data.ok !== 'boolean' && data.result && typeof data.result === 'object') {
        data = data.result;
    }
    return {
        ok: data.ok === true,
        code: typeof data.code === 'string' ? data.code : (record.status === 'completed' ? 'TEST_PASS' : 'AGENT_TOOL_FAILED'),
        exitCode: data.exitCode === undefined ? null : data.exitCode
    };
}

async function run({ workspaceId = null, sessionId = null, owner = null, goal = null, edits = null, checks = null, proposalId = null, corrections = null, correctionOffset = null, checkpointId = null, expectedVersion = null, signal = null, approval = null, timeoutMs = null, onEvent = null, deps = null } = {}) {
    checkAborted(signal);
    const who = checkOwner(owner);
    const text = checkGoal(goal);
    const validEdits = checkEdits(edits === undefined ? [] : edits);
    const validChecks = checkChecks(checks === undefined ? [] : checks);
    if (workspaceId !== undefined && workspaceId !== null && (typeof workspaceId !== 'string' || !workspaceId)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'workspaceId must be a non-empty string');
    }
    if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'string' || !sessionId)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'sessionId must be a non-empty string');
    }
    if (proposalId !== undefined && proposalId !== null && (typeof proposalId !== 'string' || !proposalId)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'proposalId must be a non-empty string');
    }
    if (checkpointId !== undefined && checkpointId !== null && (typeof checkpointId !== 'string' || !checkpointId)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'checkpointId must be a non-empty string');
    }
    if (expectedVersion !== undefined && expectedVersion !== null && (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'expectedVersion must be a positive integer');
    }
    const core = (deps && deps.core) || defaultCore;
    const limits = (deps && deps.limits) || {};
    const maxSteps = limits.MAX_AGENT_STEPS || MAX_AGENT_STEPS;
    const maxTests = limits.MAX_TEST_RUNS || MAX_TEST_RUNS;
    const maxContexts = limits.MAX_CONTEXT_CALLS || MAX_CONTEXT_CALLS;
    const maxCorrections = limits.MAX_CORRECTION_ATTEMPTS || MAX_CORRECTION_ATTEMPTS;
    const validCorrections = checkCorrections(corrections === undefined ? [] : corrections, maxCorrections);
    // NOTE: `offset` (effective correction base) is assigned in the init
    // block below: fresh runs use the caller-supplied correctionOffset,
    // checkpoint resumes use the stored correctionBase.
    // Owner-scoped workspace resolution up front: unknown or foreign
    // workspaces fail before any tool runs.
    const wsSvc = (deps && deps.workspaceService) || WorkspaceService.default();
    try {
        if (workspaceId !== undefined && workspaceId !== null) {
            await wsSvc.getById(workspaceId, who);
        } else if (sessionId !== undefined && sessionId !== null) {
            await wsSvc.getCurrent(sessionId, who);
        } else {
            throw loopError(400, 'TOOL_INVALID_INPUT', 'workspaceId or sessionId is required');
        }
    } catch (e) {
        if (isAbortError(e)) throw e;
        return {
            ok: false, code: 'AGENT_TOOL_FAILED', workspaceId, sessionId,
            goal: text, plan: [], steps: [], toolsUsed: [], tests: [],
            proposalId: proposalId || null, proposalStatus: null,
            correctionAttempts: 0, corrections: [], diagnosis: null,
            checkpointId: null, checkpointVersion: null,
            finalStatus: 'failed', failureReason: (e && e.message) || 'workspace resolution failed',
            limits: { MAX_AGENT_STEPS: maxSteps, MAX_TEST_RUNS: maxTests, MAX_CONTEXT_CALLS: maxContexts }
        };
    }
    const cpSvc = (deps && deps.checkpoints) || AgentCheckpointService.default();
    let sessForCp = sessionId === undefined ? null : sessionId;
    let cpId = null;
    let cpVersion = 0;

    // Serialize the mutable execution context for the checkpoint store.
    // Everything here is JSON-safe tool data — never signals, handles,
    // env, or secrets.
    function snapshot(extra = {}) {
        return {
            goal: text,
            workspaceId, sessionId,
            queue: queue.map((s) => ({ type: s.type, tool: s.tool, input: s.input })),
            counts: { steps: records.length, tests: testRuns, contexts: contextCalls },
            toolsUsed: toolsUsed.slice(),
            tests: tests.map((t) => ({ ...t })),
            correctionsLog: correctionsLog.map((c) => ({ ...c })),
            diagnosis: diagnosis ? { ...diagnosis } : null,
            createdProposalId, createdProposalStatus,
            correctionBase: offset + (correctionsLog.length - logBase),
            correctionsRemaining: correctionsRemaining.map((round) => round.map((e) => ({ ...e }))),
            pendingCorrection: pendingCorrection ? { ...pendingCorrection } : null,
            resumeProposalId: resumeId,
            ...extra
        };
    }

    async function saveCp(status, extra = {}) {
        const rec = await cpSvc.update(cpId, who, { status, state: snapshot(extra), expectedVersion: cpVersion, sessionId: sessForCp });
        cpVersion = rec.version;
        emit(onEvent, { type: checkpointEventFor(status), checkpointId: cpId, version: cpVersion });
        return rec;
    }

    function checkpointEventFor(status) {
        if (status === 'waiting_approval') return 'checkpoint_waiting_approval';
        if (status === 'completed') return 'checkpoint_completed';
        if (status === 'failed') return 'checkpoint_failed';
        if (status === 'cancelled') return 'checkpoint_cancelled';
        return 'checkpoint_paused';
    }
    // Execution context: fresh runs build it from the plan; checkpoint
    // resumes restore it (budgets continue, never reset).
    let queue = [];
    let plan = [];
    const records = [];
    const toolsUsed = [];
    const tests = [];
    // P3-8 correction state (this run only; cross-run accounting travels
    // in `offset`, taken from the previous run's own output).
    const correctionsLog = [];
    let diagnosis = null;
    let pendingCorrection = null;
    // P3-9: index in correctionsLog where this run's own entries start
    // (entries before it were restored from the checkpoint).
    let logBase = 0;
    let contextCalls = 0;
    let testRuns = 0;
    let createdProposalId = null;
    let createdProposalStatus = null;
    let resumeId = proposalId === undefined ? null : proposalId;
    let correctionsRemaining = [];
    let offset = checkCorrectionOffset(correctionOffset === undefined ? null : correctionOffset);

    emit(onEvent, { type: 'message.started', sessionId });

    // P3-9 resume: claim the checkpoint (CAS: exactly one resume wins),
    // then rebuild. Waiting_approval checkpoints rebuild the apply+verify
    // plan for the stored proposal; interrupted runs continue their
    // stored queue. Stored correction state always wins over a
    // caller-supplied correctionOffset.
    if (checkpointId !== undefined && checkpointId !== null) {
        let claimed;
        try {
            checkAborted(signal);
            claimed = await cpSvc.claimForResume(checkpointId, who, { sessionId: sessForCp, expectedVersion: expectedVersion === undefined ? null : expectedVersion });
        } catch (e) {
            if (isAbortError(e)) throw e;
            const msg = (e && e.message) || 'checkpoint resume failed';
            const code = e && typeof e.code === 'string' ? e.code : null;
            return await finishResume([], [], msg, null, code);
        }
        cpId = claimed.checkpointId;
        cpVersion = claimed.version;
        // The stored session is authoritative for all later checkpoint
        // writes in this run (a caller-supplied session already passed
        // the mismatch check above when both were present).
        sessForCp = claimed.sessionId === undefined ? null : claimed.sessionId;
        const st = claimed.state && typeof claimed.state === 'object' ? claimed.state : {};
        if ((workspaceId !== undefined && workspaceId !== null && st.workspaceId !== undefined && st.workspaceId !== null && workspaceId !== st.workspaceId) ||
            (sessionId !== undefined && sessionId !== null && st.sessionId !== undefined && st.sessionId !== null && sessionId !== st.sessionId)) {
            return await finishResume([], [], 'checkpoint workspace/session mismatch', null, 'CHECKPOINT_INVALID');
        }
        emit(onEvent, { type: 'checkpoint_resumed', checkpointId: cpId, version: cpVersion });
        const wasWaiting = Array.isArray(st.queue) && st.queue.length === 0 && typeof st.pendingProposalId === 'string' && st.pendingProposalId;
        const counts = st.counts && typeof st.counts === 'object' ? st.counts : {};
        contextCalls = Number.isInteger(counts.contexts) && counts.contexts >= 0 ? counts.contexts : 0;
        testRuns = Number.isInteger(counts.tests) && counts.tests >= 0 ? counts.tests : 0;
        if (Array.isArray(st.toolsUsed)) for (const t of st.toolsUsed) if (typeof t === 'string' && !toolsUsed.includes(t)) toolsUsed.push(t);
        if (Array.isArray(st.tests)) for (const t of st.tests) tests.push({ ...t });
        if (Array.isArray(st.correctionsLog)) for (const c of st.correctionsLog) correctionsLog.push({ ...c });
        logBase = correctionsLog.length;
        diagnosis = st.diagnosis && typeof st.diagnosis === 'object' ? { ...st.diagnosis } : null;
        createdProposalId = typeof st.createdProposalId === 'string' ? st.createdProposalId : null;
        createdProposalStatus = typeof st.createdProposalStatus === 'string' ? st.createdProposalStatus : null;
        offset = Number.isInteger(st.correctionBase) && st.correctionBase >= 0 ? st.correctionBase : offset;
        correctionsRemaining = Array.isArray(st.correctionsRemaining) ? st.correctionsRemaining : [];
        // P3-9: rounds the caller supplies on resume are appended after
        // the stored unused rounds (attempt numbering still comes from
        // the stored base, never from caller input).
        if (validCorrections.length > 0) {
            const combined = correctionsRemaining.concat(validCorrections.map((round) => round.map((e) => ({ ...e }))));
            if (combined.length > maxCorrections) {
                return await finishResume([], [], `corrections exceed limit (${maxCorrections})`, null, 'TOOL_INVALID_INPUT');
            }
            correctionsRemaining = combined;
        }
        pendingCorrection = st.pendingCorrection && typeof st.pendingCorrection === 'object' ? { ...st.pendingCorrection } : null;
        if (wasWaiting) {
            if (resumeId && resumeId !== st.pendingProposalId) {
                return await finishResume([], [], 'proposalId does not match checkpoint proposal', st.pendingProposalId, 'CHECKPOINT_INVALID');
            }
            resumeId = st.pendingProposalId;
            plan = buildPlan({ goal: st.goal || text, workspaceId, sessionId, edits: [], checks: [], proposalId: resumeId });
            queue = plan.slice();
        } else {
            if (!Array.isArray(st.queue)) {
                return await finishResume([], [], 'checkpoint has no resumable queue', null, 'CHECKPOINT_INVALID');
            }
            resumeId = typeof st.resumeProposalId === 'string' ? st.resumeProposalId : null;
            if (resumeId && proposalId !== undefined && proposalId !== null && proposalId !== resumeId) {
                return await finishResume([], [], 'proposalId does not match checkpoint proposal', resumeId, 'CHECKPOINT_INVALID');
            }
            plan = validateSteps(st.queue);
            queue = plan.slice();
        }
    } else {
        // Resume path: an already-created proposal is applied (human approval
        // enforced by the registry gate on change_apply) and verified. The
        // proposal itself is re-validated owner/session-side before use.
        resumeId = proposalId === undefined ? null : proposalId;
        if (resumeId) {
            try {
                const current = await (async () => {
                    checkAborted(signal);
                    const svc = (deps && deps.proposals) || proposalService;
                    return svc.get({ proposalId: resumeId, owner: who, sessionId: sessionId === undefined ? null : sessionId, signal: signal || null });
                })();
                if (current.status !== 'pending') {
                    return await finishResume([], [], `proposal is ${current.status}`, current.status, 'PROPOSAL_NOT_PENDING');
                }
            } catch (e) {
                if (isAbortError(e)) throw e;
                const msg = (e && e.message) || 'proposal lookup failed';
                const code = e && typeof e.code === 'string' ? e.code : null;
                return await finishResume([], [], msg, null, code);
            }
        }
        const freshPlan = buildPlan({ goal: text, workspaceId, sessionId, edits: validEdits, checks: validChecks, proposalId: resumeId });
        plan = freshPlan;
        queue = plan.slice();
        createdProposalId = resumeId;
        createdProposalStatus = resumeId ? 'pending' : null;
        correctionsRemaining = validCorrections.map((round) => round.map((e) => ({ ...e })));
        try {
            checkAborted(signal);
            const created = await cpSvc.create({
                ownerId: who,
                sessionId: sessForCp,
                workspaceId: workspaceId === undefined ? null : workspaceId,
                state: snapshot()
            });
            cpId = created.checkpointId;
            cpVersion = created.version;
            emit(onEvent, { type: 'checkpoint_created', checkpointId: cpId, version: cpVersion });
        } catch (e) {
            if (isAbortError(e)) throw e;
            return await finishResume([], [], (e && e.message) || 'checkpoint creation failed', null, (e && e.code) || null);
        }
    }

    // P3-9: every completed step persists (crash-safe budgets); an abort
    // marks the checkpoint cancelled and rethrows — never completed.
    try {
    while (queue.length > 0) {
        checkAborted(signal);
        if (records.length >= maxSteps) {
            return await finish({ ok: false, code: 'AGENT_STEP_LIMIT', failureReason: `agent step limit reached (${maxSteps})` });
        }
        const step = queue.shift();
        if (step.tool === 'code_context' && contextCalls >= maxContexts) {
            return await finish({ ok: false, code: 'AGENT_STEP_LIMIT', failureReason: `context call limit reached (${maxContexts})` });
        }
        if (step.tool === 'test_runner' && testRuns >= maxTests) {
            return await finish({ ok: false, code: 'AGENT_STEP_LIMIT', failureReason: `test run limit reached (${maxTests})` });
        }
        const callId = `p37-${records.length + 1}`;
        emit(onEvent, { type: 'tool.started', tool: step.tool, callId });
        let out;
        try {
            out = await core.run(
                { id: crypto.randomUUID(), sessionId, owner: who, prompt: text, runtime: 'opencode', tools: [] },
                {
                    steps: [{ id: callId, kind: 'tool', name: step.tool, input: step.input, description: `${step.type}:${step.tool}` }],
                    signal: signal || null,
                    approval: approval || { status: 'not_required' },
                    timeoutMs: timeoutMs || null
                }
            );
        } catch (e) {
            if (isAbortError(e)) throw e;
            const message = (e && e.message) || 'tool execution failed';
            const errCode = e && typeof e.code === 'string' ? e.code : null;
            emit(onEvent, { type: 'tool.completed', tool: step.tool, callId });
            if (errCode === 'PROPOSAL_STALE' || /PROPOSAL_STALE/.test(message)) {
                emit(onEvent, { type: 'proposal_stale', proposalId: createdProposalId });
            }
            emit(onEvent, { type: 'error', message });
            return await finish({ ok: false, code: 'AGENT_TOOL_FAILED', failureReason: message, errorCode: errCode });
        }
        const rec = {
            id: callId,
            type: step.type,
            tool: step.tool,
            status: 'completed',
            result: out && out.result !== undefined ? out.result : null
        };
        records.push(rec);
        if (!toolsUsed.includes(step.tool)) toolsUsed.push(step.tool);
        if (step.tool === 'code_context') contextCalls += 1;
        if (step.tool === 'test_runner') {
            testRuns += 1;
            tests.push({ tool: step.tool, ...testSummaryFrom(rec) });
        }
        emit(onEvent, { type: 'tool.completed', tool: step.tool, callId });
        // P3-9: persist after every completed step (crash-safe budgets).
        // A persist conflict aborts the run as a tool failure; the
        // terminal finish below retries best-effort.
        try {
            await saveCp('running');
        } catch (e) {
            if (isAbortError(e)) throw e;
            const message = (e && e.message) || 'checkpoint persist failed';
            const errCode = e && typeof e.code === 'string' ? e.code : null;
            return await finish({ ok: false, code: 'AGENT_TOOL_FAILED', failureReason: message, errorCode: errCode });
        }

        // A freshly proposed change pauses the loop: the agent must not
        // approve its own proposal. The caller resumes later with the
        // proposalId plus a human approval. Correction pauses additionally
        // record the attempt, diagnosis, and new proposalId; the previous
        // proposal is never mutated.
        if (step.tool === 'change_propose') {
            const data = rec.result && typeof rec.result === 'object' ? rec.result : {};
            const inner = data.result && typeof data.result === 'object' ? data.result : data;
            createdProposalId = typeof inner.proposalId === 'string' ? inner.proposalId : null;
            createdProposalStatus = typeof inner.status === 'string' ? inner.status : 'pending';
            const files = Array.isArray(inner.changes) ? inner.changes.map((c) => c.path) : [];
            if (pendingCorrection) {
                const entry = {
                    attempt: pendingCorrection.attempt,
                    proposalId: createdProposalId,
                    testResult: pendingCorrection.testResult,
                    status: createdProposalStatus
                };
                correctionsLog.push(entry);
                correctionsRemaining = correctionsRemaining.slice(1);
                diagnosis = {
                    attempt: pendingCorrection.attempt,
                    testCode: pendingCorrection.testResult.code,
                    testExitCode: pendingCorrection.testResult.exitCode,
                    inspected: ['code_context', 'git_status']
                };
                emit(onEvent, { type: 'proposal_created', proposalId: createdProposalId, files, correctionAttempt: entry.attempt, isCorrection: true });
                emit(onEvent, { type: 'approval_required', proposalId: createdProposalId, status: createdProposalStatus, correctionAttempt: entry.attempt, isCorrection: true });
                pendingCorrection = null;
            } else {
                emit(onEvent, { type: 'proposal_created', proposalId: createdProposalId, files });
                emit(onEvent, { type: 'approval_required', proposalId: createdProposalId, status: createdProposalStatus });
            }
            return await finish({
                ok: false, code: 'APPROVAL_REQUIRED',
                finalStatus: 'awaiting_approval',
                failureReason: null,
                proposalId: createdProposalId, proposalStatus: createdProposalStatus
            });
        }
        if (step.tool === 'change_apply') {
            emit(onEvent, { type: 'changes_applied', proposalId: createdProposalId });
            createdProposalStatus = 'applied';
        }
        // P3-8 self-correction on the resume path: a failing post-apply
        // test either (a) diagnoses + proposes the next server-supplied
        // correction round and pauses for human approval, (b) terminates
        // with AGENT_CORRECTION_LIMIT when attempts are exhausted, or
        // (c) falls back to the legacy bounded re-inspect when no
        // corrections were supplied. All diagnose/propose steps share the
        // same per-run budgets — nothing resets.
        const isVerify = step.tool === 'test_runner' && resumeId && queue.length === 0;
        const lastTest = tests.length ? tests[tests.length - 1] : null;
        if (isVerify && lastTest && !lastTest.ok) {
            // P3-9: the remaining correction rounds travel in the
            // checkpoint-persisted queue, not the per-run input.
            if (correctionsRemaining.length > 0) {
                const attempt = offset + (correctionsLog.length - logBase) + 1;
                if (attempt > maxCorrections) {
                    return await finish({ ok: false, code: 'AGENT_CORRECTION_LIMIT', finalStatus: 'correction_limit', failureReason: `correction limit reached (${maxCorrections})` });
                }
                pendingCorrection = { attempt, testResult: { ok: lastTest.ok, code: lastTest.code, exitCode: lastTest.exitCode } };
                queue.push(
                    { type: 'inspect', tool: 'code_context', input: { workspaceId, sessionId } },
                    { type: 'status', tool: 'git_status', input: { workspaceId, sessionId } },
                    { type: 'propose', tool: 'change_propose', input: { workspaceId, sessionId, changes: correctionsRemaining[0] } }
                );
                continue;
            }
            if (testRuns <= maxTests && records.length + 2 <= maxSteps) {
                queue.push(
                    { type: 'inspect', tool: 'code_context', input: { workspaceId, sessionId } },
                    { type: 'test', tool: 'test_runner', input: { workspaceId, sessionId } }
                );
                continue;
            }
        }
    }

    // Verdict reflects the LAST test (post-apply verify), not the
    // diagnostic baseline: a fixed-then-green run is completed.
    const lastTest = tests.length ? tests[tests.length - 1] : null;
    if (lastTest && !lastTest.ok) {
        return await finish({ ok: false, code: 'AGENT_COMPLETED', finalStatus: 'tests_failing', failureReason: `tests failing: ${lastTest.code}` });
    }
    return await finish({ ok: true, code: 'AGENT_COMPLETED', finalStatus: 'completed', failureReason: null });
    } catch (e) {
        // P3-9: cancellation persists the latest safe state as cancelled
        // (never completed) and rethrows; files are untouched past the
        // proposal/apply boundary because no step runs after this.
        if (isAbortError(e)) {
            if (cpId) {
                try {
                    const rec = await cpSvc.update(cpId, who, {
                        status: 'cancelled',
                        state: snapshot({ finalStatus: 'cancelled', failureReason: 'aborted' }),
                        expectedVersion: cpVersion,
                        sessionId: sessForCp
                    });
                    cpVersion = rec.version;
                    emit(onEvent, { type: 'checkpoint_cancelled', checkpointId: cpId, version: cpVersion });
                } catch { /* best effort on the way out */ }
            }
        }
        throw e;
    }

    async function finishResume(stepsDone, toolsDone, failureReason, proposalStatus, errorCode = null) {
        let versionOut = null;
        if (cpId) {
            try {
                const rec = await cpSvc.update(cpId, who, {
                    status: 'failed',
                    state: snapshot({ finalStatus: proposalStatus === 'rejected' ? 'rejected' : 'failed', failureReason, errorCode }),
                    expectedVersion: cpVersion,
                    sessionId: sessForCp
                });
                cpVersion = rec.version;
                versionOut = rec.version;
                emit(onEvent, { type: 'checkpoint_failed', checkpointId: cpId, version: cpVersion });
            } catch { /* best effort: the result still reports the failure */ }
        }
        return {
            ok: false, code: 'AGENT_TOOL_FAILED', workspaceId, sessionId,
            goal: text, plan: planSummary(), steps: stepsDone, toolsUsed: toolsDone, tests: [],
            proposalId: resumeId, proposalStatus,
            correctionAttempts: offset, corrections: [], diagnosis: null,
            checkpointId: cpId, checkpointVersion: versionOut,
            finalStatus: proposalStatus === 'rejected' ? 'rejected' : 'failed', failureReason, errorCode,
            limits: { MAX_AGENT_STEPS: maxSteps, MAX_TEST_RUNS: maxTests, MAX_CONTEXT_CALLS: maxContexts }
        };
    }

    function planSummary() {
        try {
            return buildPlan({ goal: text, workspaceId, sessionId, edits: validEdits, checks: validChecks, proposalId: resumeId })
                .map((s) => ({ type: s.type, tool: s.tool }));
        } catch {
            return [];
        }
    }

    // P3-9 terminal persist: every finished run lands its final status
    // in the checkpoint (best effort — a persist conflict never masks
    // the execution result itself).
    async function finish({ ok, code, finalStatus = ok ? 'completed' : 'failed', failureReason = null, errorCode = null, proposalId = createdProposalId, proposalStatus = createdProposalStatus }) {
        let versionOut = cpVersion;
        if (cpId) {
            const terminal = code === 'APPROVAL_REQUIRED' ? 'waiting_approval' : (ok ? 'completed' : 'failed');
            try {
                const rec = await cpSvc.update(cpId, who, {
                    status: terminal,
                    state: snapshot({
                        finalStatus, failureReason, errorCode,
                        pendingProposalId: terminal === 'waiting_approval' ? proposalId : null
                    }),
                    expectedVersion: cpVersion,
                    sessionId: sessForCp
                });
                cpVersion = rec.version;
                versionOut = rec.version;
                emit(onEvent, { type: checkpointEventFor(terminal), checkpointId: cpId, version: cpVersion });
            } catch { /* best effort */ }
        }
        const result = {
            ok,
            code,
            workspaceId,
            sessionId,
            goal: text,
            plan: plan.map((s) => ({ type: s.type, tool: s.tool })),
            steps: records,
            toolsUsed,
            tests,
            proposalId,
            proposalStatus,
            correctionAttempts: offset + (correctionsLog.length - logBase),
            corrections: correctionsLog.map((c) => ({ ...c })),
            diagnosis,
            checkpointId: cpId,
            checkpointVersion: versionOut,
            finalStatus,
            failureReason,
            errorCode,
            limits: { MAX_AGENT_STEPS: maxSteps, MAX_TEST_RUNS: maxTests, MAX_CONTEXT_CALLS: maxContexts }
        };
        emit(onEvent, { type: 'message.completed', sessionId, mcpTools: toolsUsed });
        return result;
    }
}

module.exports = {
    run,
    buildPlan,
    validateSteps,
    MAX_AGENT_STEPS,
    MAX_TEST_RUNS,
    MAX_CONTEXT_CALLS,
    MAX_CORRECTION_ATTEMPTS,
    MAX_GOAL_CHARS,
    MAX_EDITS,
    AUTO_TOOLS,
    FORBIDDEN_TOOLS
};
