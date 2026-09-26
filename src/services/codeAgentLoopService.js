// P3-6 Code Agent Loop: controlled orchestration over existing tools.
// P3-7: the loop NEVER writes user files directly. Edits become a
// change_propose step; the run then pauses with APPROVAL_REQUIRED and only
// continues (change_apply + verify) on a later run that carries the
// already-created proposalId plus a human approval. The loop never
// approves its own proposal.
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

const MAX_AGENT_STEPS = 12;
const MAX_TEST_RUNS = 3;
const MAX_CONTEXT_CALLS = 4;
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

function checkEdits(edits) {
    if (edits === undefined || edits === null) return [];
    if (!Array.isArray(edits)) {
        throw loopError(400, 'TOOL_INVALID_INPUT', 'edits must be an array');
    }
    if (edits.length > MAX_EDITS) {
        throw loopError(400, 'TOOL_INVALID_INPUT', `edits must contain at most ${MAX_EDITS} entries`);
    }
    return edits.map((e, i) => {
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
            throw loopError(400, 'TOOL_INVALID_INPUT', `edits[${i}] must be an object`);
        }
        if (typeof e.path !== 'string' || !e.path.trim()) {
            throw loopError(400, 'TOOL_INVALID_INPUT', `edits[${i}].path must be a non-empty string`);
        }
        if (typeof e.content !== 'string' && e.content !== null) {
            throw loopError(400, 'TOOL_INVALID_INPUT', `edits[${i}].content must be a string or null (null deletes)`);
        }
        return { path: e.path, content: e.content === undefined ? null : e.content };
    });
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

async function run({ workspaceId = null, sessionId = null, owner = null, goal = null, edits = null, checks = null, proposalId = null, signal = null, approval = null, timeoutMs = null, onEvent = null, deps = null } = {}) {
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
    const core = (deps && deps.core) || defaultCore;
    const limits = (deps && deps.limits) || {};
    const maxSteps = limits.MAX_AGENT_STEPS || MAX_AGENT_STEPS;
    const maxTests = limits.MAX_TEST_RUNS || MAX_TEST_RUNS;
    const maxContexts = limits.MAX_CONTEXT_CALLS || MAX_CONTEXT_CALLS;
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
            finalStatus: 'failed', failureReason: (e && e.message) || 'workspace resolution failed',
            limits: { MAX_AGENT_STEPS: maxSteps, MAX_TEST_RUNS: maxTests, MAX_CONTEXT_CALLS: maxContexts }
        };
    }
    // Resume path: an already-created proposal is applied (human approval
    // enforced by the registry gate on change_apply) and verified. The
    // proposal itself is re-validated owner/session-side before use.
    const resumeId = proposalId === undefined ? null : proposalId;
    if (resumeId) {
        try {
            const current = await (async () => {
                checkAborted(signal);
                const svc = (deps && deps.proposals) || proposalService;
                return svc.get({ proposalId: resumeId, owner: who, sessionId: sessionId === undefined ? null : sessionId, signal: signal || null });
            })();
            if (current.status !== 'pending') {
                return finishResume([], [], `proposal is ${current.status}`, current.status, 'PROPOSAL_NOT_PENDING');
            }
        } catch (e) {
            if (isAbortError(e)) throw e;
            const msg = (e && e.message) || 'proposal lookup failed';
            const code = e && typeof e.code === 'string' ? e.code : null;
            return finishResume([], [], msg, null, code);
        }
    }
    const plan = buildPlan({ goal: text, workspaceId, sessionId, edits: validEdits, checks: validChecks, proposalId: resumeId });
    const queue = plan.slice();
    const records = [];
    const toolsUsed = [];
    const tests = [];
    let contextCalls = 0;
    let testRuns = 0;
    let createdProposalId = resumeId;
    let createdProposalStatus = resumeId ? 'pending' : null;

    emit(onEvent, { type: 'message.started', sessionId });

    while (queue.length > 0) {
        checkAborted(signal);
        if (records.length >= maxSteps) {
            return finish({ ok: false, code: 'AGENT_STEP_LIMIT', failureReason: `agent step limit reached (${maxSteps})` });
        }
        const step = queue.shift();
        if (step.tool === 'code_context' && contextCalls >= maxContexts) {
            return finish({ ok: false, code: 'AGENT_STEP_LIMIT', failureReason: `context call limit reached (${maxContexts})` });
        }
        if (step.tool === 'test_runner' && testRuns >= maxTests) {
            return finish({ ok: false, code: 'AGENT_STEP_LIMIT', failureReason: `test run limit reached (${maxTests})` });
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
            return finish({ ok: false, code: 'AGENT_TOOL_FAILED', failureReason: message, errorCode: errCode });
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

        // A freshly proposed change pauses the loop: the agent must not
        // approve its own proposal. The caller resumes later with the
        // proposalId plus a human approval.
        if (step.tool === 'change_propose') {
            const data = rec.result && typeof rec.result === 'object' ? rec.result : {};
            const inner = data.result && typeof data.result === 'object' ? data.result : data;
            createdProposalId = typeof inner.proposalId === 'string' ? inner.proposalId : null;
            createdProposalStatus = typeof inner.status === 'string' ? inner.status : 'pending';
            const files = Array.isArray(inner.changes) ? inner.changes.map((c) => c.path) : [];
            emit(onEvent, { type: 'proposal_created', proposalId: createdProposalId, files });
            emit(onEvent, { type: 'approval_required', proposalId: createdProposalId, status: createdProposalStatus });
            return finish({
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
        // Bounded re-inspect on the resume path: a failing post-apply
        // test re-queues one inspect + one test round while budgets last.
        const isVerify = step.tool === 'test_runner' && resumeId && queue.length === 0;
        const lastTest = tests.length ? tests[tests.length - 1] : null;
        if (isVerify && lastTest && !lastTest.ok && testRuns <= maxTests && records.length + 2 <= maxSteps) {
            queue.push(
                { type: 'inspect', tool: 'code_context', input: { workspaceId, sessionId } },
                { type: 'test', tool: 'test_runner', input: { workspaceId, sessionId } }
            );
            continue;
        }
    }

    // Verdict reflects the LAST test (post-apply verify), not the
    // diagnostic baseline: a fixed-then-green run is completed.
    const lastTest = tests.length ? tests[tests.length - 1] : null;
    if (lastTest && !lastTest.ok) {
        return finish({ ok: false, code: 'AGENT_COMPLETED', finalStatus: 'tests_failing', failureReason: `tests failing: ${lastTest.code}` });
    }
    return finish({ ok: true, code: 'AGENT_COMPLETED', finalStatus: 'completed', failureReason: null });

    function finishResume(stepsDone, toolsDone, failureReason, proposalStatus, errorCode = null) {
        return {
            ok: false, code: 'AGENT_TOOL_FAILED', workspaceId, sessionId,
            goal: text, plan: planSummary(), steps: stepsDone, toolsUsed: toolsDone, tests: [],
            proposalId: resumeId, proposalStatus,
            finalStatus: 'failed', failureReason, errorCode,
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

    function finish({ ok, code, finalStatus = ok ? 'completed' : 'failed', failureReason = null, errorCode = null, proposalId = createdProposalId, proposalStatus = createdProposalStatus }) {
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
    MAX_GOAL_CHARS,
    MAX_EDITS,
    AUTO_TOOLS,
    FORBIDDEN_TOOLS
};
