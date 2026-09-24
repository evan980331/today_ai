// Runtime interface contract (minimal, adapter-friendly).
// A runtime must implement: name, execute, executeStream, abort, health, describe
const REQUIRED = ['execute', 'executeStream', 'abort', 'health', 'describe'];

function assertRuntime(impl, name) {
    if (!impl || typeof impl !== 'object') throw Object.assign(new Error('runtime must be an object'), { status: 400 });
    const n = name || impl.name;
    if (typeof n !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(n)) throw Object.assign(new Error('runtime name must match /^[a-z][a-z0-9_-]{0,63}$/'), { status: 400 });
    for (const fn of REQUIRED) {
        if (typeof impl[fn] !== 'function') throw Object.assign(new Error(`runtime "${n}" must implement ${fn}()`), { status: 400 });
    }
    return true;
}

function wrapRuntime(impl) {
    assertRuntime(impl);
    return impl;
}

module.exports = { assertRuntime, wrapRuntime, REQUIRED };
