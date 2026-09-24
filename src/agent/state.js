// AgentState — single-task isolated state.
class AgentState {
    constructor(taskId) {
        if (!taskId || typeof taskId !== 'string') throw Object.assign(new Error('taskId required'), { status: 400 });
        this.taskId = taskId;
        this.status = 'running';
        this.currentStep = null;
        this.history = [];
        this.toolResults = [];
        this.retries = 0;
        this.startedAt = Date.now();
        this.completedAt = null;
        this.error = null;
    }
    setStep(step) {
        this.currentStep = step;
        this.history.push({ type: 'step', step: step ? step.id : null, at: Date.now() });
    }
    addHistory(entry) {
        this.history.push({ ...entry, at: Date.now() });
    }
    addToolResult(result) {
        this.toolResults.push(result);
    }
    complete(result) {
        this.status = 'completed';
        this.completedAt = Date.now();
        if (result !== undefined) this.addToolResult(result);
    }
    fail(err) {
        this.status = 'failed';
        this.completedAt = Date.now();
        this.error = err ? (err.message || String(err)).slice(0, 500) : 'failed';
    }
    incRetry() {
        this.retries += 1;
    }
}

module.exports = { AgentState };
