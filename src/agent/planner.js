// Deterministic single-step planner (Phase 1-C: selection contract).
// No LLM, no execution — pure selection, always exactly 1 step.
//   tools: ['calculator'] -> { kind:'tool', name:'calculator', input }
//   tools: []            -> { kind:'runtime', name:'opencode', input }
// Unknown tools/names are NOT validated here; execution layer raises
// TOOL_NOT_FOUND / unknown runtime with original codes.
function plan(task) {
    if (!task || typeof task !== 'object') {
        throw Object.assign(new Error('planner requires task'), { code: 'PLANNING_ERROR', status: 400 });
    }
    const prompt = typeof task.prompt === 'string' ? task.prompt : '';
    const tools = Array.isArray(task.tools) ? task.tools : [];
    if (tools.length > 0) {
        const name = tools[0];
        if (typeof name !== 'string' || !name) {
            throw Object.assign(new Error('planner requires tool name'), { code: 'PLANNING_ERROR', status: 400 });
        }
        return [{ id: 'step-1', kind: 'tool', name, input: prompt, description: `tool:${name}` }];
    }
    const name = typeof task.runtime === 'string' && task.runtime ? task.runtime : 'opencode';
    return [{ id: 'step-1', kind: 'runtime', name, input: prompt, description: `runtime:${name}` }];
}

module.exports = { plan };
