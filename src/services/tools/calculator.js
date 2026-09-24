// Calculator — deterministic native tool (Phase 1-B).
// Pure arithmetic: + - * / and parentheses. No eval/Function,
// no child_process/shell, no filesystem, no network.
const { defineTool } = require('./tool');

function tokenize(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
        const ch = expr[i];
        if (ch === ' ' || ch === '\t') { i += 1; continue; }
        if ((ch >= '0' && ch <= '9') || ch === '.') {
            let j = i;
            let dots = 0;
            while (j < expr.length && ((expr[j] >= '0' && expr[j] <= '9') || expr[j] === '.')) {
                if (expr[j] === '.') dots += 1;
                j += 1;
            }
            const raw = expr.slice(i, j);
            if (dots > 1 || raw === '.') throw Object.assign(new Error(`invalid number: ${raw}`), { status: 400 });
            tokens.push({ type: 'num', value: parseFloat(raw) });
            i = j;
            continue;
        }
        if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
            tokens.push({ type: ch });
            i += 1;
            continue;
        }
        throw Object.assign(new Error(`invalid character: ${ch}`), { status: 400 });
    }
    return tokens;
}

function parse(tokens) {
    let pos = 0;
    function peek() { return tokens[pos] || null; }
    function eat(t) {
        const cur = peek();
        if (!cur || cur.type !== t) throw Object.assign(new Error('invalid expression'), { status: 400 });
        pos += 1;
        return cur;
    }
    function parseExpr() {
        let v = parseTerm();
        for (;;) {
            const cur = peek();
            if (!cur || (cur.type !== '+' && cur.type !== '-')) return v;
            eat(cur.type);
            const rhs = parseTerm();
            v = cur.type === '+' ? v + rhs : v - rhs;
        }
    }
    function parseTerm() {
        let v = parseFactor();
        for (;;) {
            const cur = peek();
            if (!cur || (cur.type !== '*' && cur.type !== '/')) return v;
            eat(cur.type);
            const rhs = parseFactor();
            if (cur.type === '/') {
                if (rhs === 0) throw Object.assign(new Error('division by zero'), { status: 400 });
                v /= rhs;
            } else {
                v *= rhs;
            }
        }
    }
    function parseFactor() {
        const cur = peek();
        if (!cur) throw Object.assign(new Error('invalid expression'), { status: 400 });
        if (cur.type === 'num') { pos += 1; return cur.value; }
        if (cur.type === '(') {
            eat('(');
            const v = parseExpr();
            eat(')');
            return v;
        }
        if (cur.type === '-' && (pos === 0 || ['+', '-', '*', '/', '('].includes(tokens[pos - 1] ? tokens[pos - 1].type : null))) {
            eat('-');
            return -parseFactor();
        }
        throw Object.assign(new Error('invalid expression'), { status: 400 });
    }
    const v = parseExpr();
    if (pos !== tokens.length) throw Object.assign(new Error('invalid expression'), { status: 400 });
    return v;
}

const calculator = defineTool({
    name: 'calculator',
    description: 'Deterministic arithmetic: evaluates + - * / with parentheses',
    inputSchema: { type: 'string', description: 'arithmetic expression, e.g. (2 + 3) * 4' },
    readOnly: true,
    needsApproval: false,
    execute: async (input) => {
        if (typeof input !== 'string' || !input.trim()) {
            throw Object.assign(new Error('expression must be a non-empty string'), { status: 400 });
        }
        const text = input.trim().slice(0, 200);
        const value = parse(tokenize(text));
        if (!Number.isFinite(value)) throw Object.assign(new Error('result is not finite'), { status: 400 });
        return { result: String(value), mcpTools: ['calculator'] };
    }
});

module.exports = { calculator };
