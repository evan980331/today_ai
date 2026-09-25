// P2-G Planner Tool Selection tests (deterministic, no LLM, no execution
// by the planner itself).
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/agent/planner');
const core = require('../src/agent/core');
const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const { defineTool, toMetadata } = require('../src/services/tools/tool');

function fullMetadata() {
    toolRegistry._clearForTests();
    registerNativeTools(toolRegistry);
    return toolRegistry.list();
}

beforeEach(() => {
    toolRegistry._clearForTests();
});

describe('P2-G A explicit selection', () => {
    it('1 tools:["calculator"] -> calculator', () => {
        const steps = planner.plan({ prompt: 'x', tools: ['calculator'] });
        assert.equal(steps[0].kind, 'tool');
        assert.equal(steps[0].name, 'calculator');
    });
    it('2 tools:["gmail.search"] -> gmail.search', () => {
        const steps = planner.plan({ prompt: 'x', tools: ['gmail.search'] });
        assert.equal(steps[0].kind, 'tool');
        assert.equal(steps[0].name, 'gmail.search');
    });
    it('3 explicit tool wins over automatic selection', () => {
        const md = fullMetadata();
        const steps = planner.plan({ prompt: '幫我算 1 + 1', tools: ['gmail.search'] }, { toolMetadata: md });
        assert.equal(steps[0].name, 'gmail.search');
    });
});

describe('P2-G B automatic selection', () => {
    const cases = [
        ['幫我算 123 * 456', 'calculator'],
        ['搜尋 Gmail 裡面最近的郵件', 'gmail.search'],
        ['取得這封 Gmail message', 'gmail.getMessage'],
        ['列出 Gmail threads', 'gmail.listThreads'],
        ['列出我的 Google Calendar 行程', 'calendar.listEvents'],
        ['取得這個 calendar event', 'calendar.getEvent'],
        ['列出 calendar', 'calendar.listCalendars'],
        ['搜尋 GitHub repository', 'github.searchRepositories'],
        ['查看 repository', 'github.getRepository'],
        ['列出 GitHub issues', 'github.listIssues'],
        ['列出 pull requests', 'github.listPullRequests'],
        ['讀取某個檔案', 'filesystem.read'],
        ['列出資料夾檔案', 'filesystem.list']
    ];
    for (const [prompt, expected] of cases) {
        it(`auto: "${prompt}" -> ${expected}`, () => {
            const md = fullMetadata();
            const steps = planner.plan({ prompt, tools: [] }, { toolMetadata: md });
            assert.equal(steps[0].kind, 'tool');
            assert.equal(steps[0].name, expected);
            assert.equal(steps[0].input, prompt);
        });
    }
});

describe('P2-G C fallback to OpenCode', () => {
    const cases = [
        '幫我寫一個登入功能',
        '幫我修改這個專案',
        '刪除檔案',
        '執行 npm test',
        '先查詢 Gmail 郵件再整理成多頁報告並寄出',
        '今天天氣如何'
    ];
    for (const prompt of cases) {
        it(`fallback: "${prompt}" -> runtime`, () => {
            const md = fullMetadata();
            const steps = planner.plan({ prompt, tools: [] }, { toolMetadata: md });
            assert.equal(steps[0].kind, 'runtime');
            assert.equal(steps[0].name, 'opencode');
        });
    }
    it('分析這個 repo 並幫我修改 -> fallback (no read-only hijack)', () => {
        const md = fullMetadata();
        const steps = planner.plan({ prompt: '分析這個 repo 並幫我修改', tools: [] }, { toolMetadata: md });
        assert.equal(steps[0].kind, 'runtime');
    });
});

describe('P2-G D safety / correctness', () => {
    it('23 修改 README 不選 filesystem.read', () => {
        const steps = planner.plan({ prompt: '修改 README', tools: [] }, { toolMetadata: fullMetadata() });
        assert.equal(steps[0].kind, 'runtime');
    });
    it('24 刪除檔案 不選 filesystem.list', () => {
        const steps = planner.plan({ prompt: '刪除檔案', tools: [] }, { toolMetadata: fullMetadata() });
        assert.equal(steps[0].kind, 'runtime');
    });
    it('25 執行 npm test 不選 filesystem.read', () => {
        const steps = planner.plan({ prompt: '執行 npm test', tools: [] }, { toolMetadata: fullMetadata() });
        assert.equal(steps[0].kind, 'runtime');
    });
    it('26 planner never executes tools', () => {
        let executed = false;
        toolRegistry.register({ name: 'spy_sel', description: 'spy', execute: async () => { executed = true; return 'x'; } });
        planner.plan({ prompt: 'spy_sel run now', tools: [] }, { toolMetadata: toolRegistry.list() });
        assert.equal(executed, false);
    });
    it('27 selection is deterministic', () => {
        const md = fullMetadata();
        const task = { prompt: '搜尋 Gmail 裡面最近的郵件', tools: [] };
        const a = planner.plan(task, { toolMetadata: md });
        const b = planner.plan(task, { toolMetadata: md });
        assert.deepEqual(a, b);
        assert.equal(a[0].name, 'gmail.search');
        assert.equal(planner.selectTool(task.prompt, md).name, planner.selectTool(task.prompt, md).name);
    });
    it('28 unknown explicit tool keeps TOOL_NOT_FOUND behavior at execution', async () => {
        const steps = planner.plan({ prompt: 'x', tools: ['nope_missing'] });
        assert.equal(steps[0].kind, 'tool');
        await assert.rejects(() => core.run({ id: 'u1', prompt: 'x', sessionId: 's', tools: ['nope_missing'] }, {}), (e) => e.code === 'TOOL_NOT_FOUND');
    });
    it('29 no tool metadata -> OpenCode fallback', () => {
        const steps = planner.plan({ prompt: '幫我算 1 + 1', tools: [] });
        assert.equal(steps[0].kind, 'runtime');
    });
    it('30 empty task keeps existing planner behavior', () => {
        const steps = planner.plan({ prompt: '', tools: [] }, { toolMetadata: fullMetadata() });
        assert.equal(steps[0].kind, 'runtime');
        assert.throws(() => planner.plan(null), (e) => e.code === 'PLANNING_ERROR');
    });
});

describe('P2-G metadata integrity', () => {
    it('capabilities metadata defensive copy', () => {
        const t = defineTool({ name: 'cap_t', description: 'c', execute: async () => 1, capabilities: ['a.b'] });
        assert.deepEqual(t.capabilities, ['a.b']);
        assert.throws(() => defineTool({ name: 'cap_x', description: 'c', execute: async () => 1, capabilities: 'nope' }), /capabilities/);
        assert.throws(() => defineTool({ name: 'cap_y', description: 'c', execute: async () => 1, capabilities: [1] }), /capabilities/);
        toolRegistry.register(t);
        const m1 = toolRegistry.list()[0];
        m1.capabilities.push('hacked');
        assert.deepEqual(toolRegistry.list()[0].capabilities, ['a.b']);
        assert.deepEqual(toolRegistry.describe('cap_t').capabilities, ['a.b']);
    });
    it('list()/describe() never expose execute', () => {
        fullMetadata();
        for (const m of toolRegistry.list()) {
            assert.equal(typeof m.execute, 'undefined');
            assert.ok(Array.isArray(m.capabilities));
        }
        assert.equal(typeof toolRegistry.describe('calculator').execute, 'undefined');
    });
    it('planner never mutates ToolRegistry metadata', () => {
        const md = fullMetadata();
        const before = JSON.parse(JSON.stringify(md));
        planner.plan({ prompt: '搜尋 Gmail 裡面最近的郵件', tools: [] }, { toolMetadata: md });
        planner.plan({ prompt: '幫我算 1+1', tools: [] }, { toolMetadata: md });
        assert.deepEqual(md, before);
        assert.deepEqual(toolRegistry.list(), before);
    });
    it('all 13 native tools carry the specified capabilities', () => {
        const md = fullMetadata();
        const byName = new Map(md.map((m) => [m.name, m]));
        const expected = {
            'calculator': ['calculation'],
            'gmail.search': ['email.read', 'email.search'],
            'gmail.getMessage': ['email.read'],
            'gmail.listThreads': ['email.read'],
            'calendar.listCalendars': ['calendar.read'],
            'calendar.listEvents': ['calendar.read', 'calendar.search'],
            'calendar.getEvent': ['calendar.read'],
            'github.searchRepositories': ['github.read', 'github.search'],
            'github.getRepository': ['github.read'],
            'github.listIssues': ['github.read', 'github.issues'],
            'github.listPullRequests': ['github.read', 'github.pull_requests'],
            'filesystem.read': ['filesystem.read'],
            'filesystem.list': ['filesystem.read', 'filesystem.list']
        };
        assert.equal(md.length, 13);
        for (const [name, caps] of Object.entries(expected)) {
            assert.deepEqual(byName.get(name).capabilities, caps, name);
        }
    });
    it('selectTool only selects from provided metadata', () => {
        const onlyCalc = [{ name: 'calculator', description: 'c', capabilities: ['calculation'] }];
        assert.equal(planner.selectTool('幫我算 1+1', onlyCalc).name, 'calculator');
        assert.equal(planner.selectTool('搜尋 Gmail 郵件', onlyCalc), null);
        assert.equal(planner.selectTool('幫我算 1+1', []), null);
        assert.equal(planner.selectTool('幫我算 1+1', null), null);
    });
});

describe('P2-G core integration (auto selection end to end)', () => {
    it('core auto-selects calculator and routes to Registry without OpenCode', async () => {
        registerNativeTools(toolRegistry);
        // The prompt selects calculator; the tool itself rejects a natural-
        // language prompt (input parsing is out of P2-G scope). This proves
        // Core -> Planner auto selection -> ToolRegistry -> calculator ran
        // and OpenCode runtime was never touched.
        const rt = require('../src/services/opencodeRuntime');
        let runtimeCalled = false;
        const orig = rt.execute;
        rt.execute = async () => { runtimeCalled = true; return { result: 'x', mcpTools: [] }; };
        try {
            await assert.rejects(
                () => core.run({ id: 'auto1', prompt: '幫我算 2 + 3', sessionId: 's', tools: [] }, {}),
                /invalid character/
            );
            assert.equal(runtimeCalled, false);
        } finally {
            rt.execute = orig;
        }
    });
    it('core still uses runtime for generic tasks', async () => {
        const rt = require('../src/services/opencodeRuntime');
        const orig = rt.execute;
        rt.execute = async () => ({ result: 'runtime-ok', mcpTools: [] });
        try {
            const out = await core.run({ id: 'auto2', prompt: '幫我寫一個登入功能', sessionId: 's', tools: [] }, {});
            assert.equal(out.result, 'runtime-ok');
        } finally {
            rt.execute = orig;
        }
    });
    it('core source stays free of concrete tool references', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'agent', 'core.js'), 'utf8');
        for (const w of ['calculator', 'gmail', 'calendar', 'github', 'filesystem']) {
            assert.ok(!src.includes(w), `core must not reference ${w}`);
        }
    });
});
