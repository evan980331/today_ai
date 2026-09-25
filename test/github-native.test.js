// P2-D Phase A: Native GitHub auth / REST client foundation tests.
// Mock transport + fake token only — never real GitHub API, never real token.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../src/services/github/auth');
const { createGitHubClient, API_BASE, scrub } = require('../src/services/github/client');
const { registerNativeTools, NATIVE_TOOL_NAMES } = require('../src/services/tools/nativeTools');
const toolRegistry = require('../src/services/tools/toolRegistry');
const { defineTool, toMetadata, validateToolInput, createExecutionContext } = require('../src/services/tools/tool');
const {
    githubSearchRepositories,
    githubGetRepository,
    githubListIssues,
    githubListPullRequests,
    setGitHubClientFactory,
    resetGitHubClientFactory
} = require('../src/services/tools/github');

const FAKE = 'test-github-token';
const TEST_ENV = { GITHUB_TOKEN: FAKE };

function jsonResponse(data) {
    return { ok: true, json: async () => data };
}

function errResponse(status, body, headers) {
    return { ok: false, status, text: async () => body, headers: headers || {} };
}

describe('P2-D Phase A auth', () => {
    it('A credential missing -> GITHUB_CONFIG_MISSING (name only)', () => {
        assert.throws(() => auth.getGitHubToken({}), (e) => e.code === 'GITHUB_CONFIG_MISSING' && /GITHUB_TOKEN/.test(e.message));
        assert.throws(() => auth.getGitHubToken({ GITHUB_TOKEN: 'your_token_here' }), (e) => e.code === 'GITHUB_CONFIG_MISSING');
    });
    it('B auth header injection (Bearer + version headers, token not exposed to caller separately)', () => {
        const h = auth.authHeaders(TEST_ENV);
        assert.equal(h.Authorization, `Bearer ${FAKE}`);
        assert.equal(h.Accept, 'application/vnd.github+json');
        assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
        assert.ok(!Object.keys(h).some((k) => /token/i.test(k) && k !== 'Authorization'));
    });
});

describe('P2-D Phase A client', () => {
    it('E successful GET', async () => {
        const client = createGitHubClient({
            fetchFn: async () => jsonResponse({ id: 1 }),
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        assert.deepEqual(await client.request('/repos/o/r'), { id: 1 });
    });
    it('T GitHub API headers sent', async () => {
        let seen = null;
        const client = createGitHubClient({
            fetchFn: async (url, opts) => { seen = { url, opts }; return jsonResponse({}); },
            getHeaders: async () => auth.authHeaders(TEST_ENV)
        });
        await client.request('/rate_limit');
        assert.ok(seen.url.startsWith(`${API_BASE}/rate_limit`));
        assert.equal(seen.opts.method, 'GET');
        assert.equal(seen.opts.headers.Accept, 'application/vnd.github+json');
        assert.equal(seen.opts.headers['X-GitHub-Api-Version'], '2022-11-28');
        assert.ok(seen.opts.headers.Authorization.startsWith('Bearer '));
    });
    it('S query encoding', async () => {
        let seen = null;
        const client = createGitHubClient({
            fetchFn: async (url) => { seen = url; return jsonResponse({}); },
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        await client.request('/search/repositories', { query: { q: 'a b+c', per_page: 5 } });
        assert.ok(seen.includes('q=a+b%2Bc') || seen.includes('q=a%20b%2Bc'));
        assert.ok(seen.includes('per_page=5'));
    });
    it('F/G/H/I POST/PUT/PATCH/DELETE rejected without network', async () => {
        let calls = 0;
        const client = createGitHubClient({
            fetchFn: async () => { calls += 1; return jsonResponse({}); },
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            await assert.rejects(() => client.request('/repos/o/r', { method: m }), (e) => e.code === 'GITHUB_UPSTREAM' && /read-only/.test(e.message));
        }
        assert.equal(calls, 0);
    });
    it('J arbitrary URL rejected', async () => {
        let calls = 0;
        const client = createGitHubClient({
            fetchFn: async () => { calls += 1; return jsonResponse({}); },
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        for (const bad of ['https://evil.com/x', '//evil.com/x', 'repos/o/r', '/..%2Fetc', '..\\win', 'HTTPS://api.github.com/x']) {
            await assert.rejects(() => client.request(bad), (e) => e.code === 'GITHUB_UPSTREAM', bad);
        }
        assert.equal(calls, 0);
    });
    it('K timeout stays caller-side (abort -> ABORTED, never UPSTREAM)', async () => {
        const client = createGitHubClient({
            fetchFn: async (url, opts) => {
                await new Promise((resolve, reject) => {
                    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                });
            },
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        const c = new AbortController();
        setTimeout(() => c.abort(), 20);
        await assert.rejects(() => client.request('/x', { signal: c.signal }), (e) => e.code === 'ABORTED');
    });
    it('L abort -> ABORTED', async () => {
        const client = createGitHubClient({
            fetchFn: async (url, opts) => {
                await new Promise((resolve, reject) => {
                    if (opts.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                });
            },
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        const c = new AbortController();
        const p = client.request('/x', { signal: c.signal });
        c.abort();
        await assert.rejects(p, (e) => e.code === 'ABORTED');
    });
    it('M 401 -> GITHUB_UNAUTHORIZED', async () => {
        const client = createGitHubClient({
            fetchFn: async () => errResponse(401, 'Bad credentials'),
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'GITHUB_UNAUTHORIZED');
    });
    it('N 403 without rate-limit headers -> GITHUB_FORBIDDEN', async () => {
        const client = createGitHubClient({
            fetchFn: async () => errResponse(403, 'Resource not accessible by integration'),
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'GITHUB_FORBIDDEN');
    });
    it('N2 403 + exhausted rate limit -> GITHUB_RATE_LIMITED', async () => {
        const client = createGitHubClient({
            fetchFn: async () => errResponse(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }),
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'GITHUB_RATE_LIMITED');
    });
    it('O 404 -> GITHUB_NOT_FOUND', async () => {
        const client = createGitHubClient({
            fetchFn: async () => errResponse(404, 'Not Found'),
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'GITHUB_NOT_FOUND');
    });
    it('P 429 -> GITHUB_RATE_LIMITED', async () => {
        const client = createGitHubClient({
            fetchFn: async () => errResponse(429, 'slow down'),
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'GITHUB_RATE_LIMITED');
    });
    it('Q 5xx -> GITHUB_UPSTREAM', async () => {
        const client = createGitHubClient({
            fetchFn: async () => errResponse(503, 'Service Unavailable'),
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'GITHUB_UPSTREAM');
    });
    it('R network error -> GITHUB_UPSTREAM', async () => {
        const client = createGitHubClient({
            fetchFn: async () => { throw new Error('fetch failed'); },
            getHeaders: async () => ({ Authorization: `Bearer ${FAKE}` })
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'GITHUB_UPSTREAM');
    });
    it('C/D token never in errors or outputs', async () => {
        const secret = 'ghp_testleak0123456789abcdef';
        const client = createGitHubClient({
            fetchFn: async () => errResponse(401, `Bad credentials ${secret}`),
            getHeaders: async () => ({ Authorization: `Bearer ${secret}` })
        });
        await assert.rejects(() => client.request('/x'), (e) => {
            assert.ok(!String(e.message).includes(secret), 'token leaked in error');
            return e.code === 'GITHUB_UNAUTHORIZED';
        });
        assert.ok(!scrub(`Bearer ${secret}`).includes(secret));
        // success path returns API data only, never headers
        const okClient = createGitHubClient({
            fetchFn: async () => jsonResponse({ login: 'octocat' }),
            getHeaders: async () => ({ Authorization: `Bearer ${secret}` })
        });
        const out = await okClient.request('/user');
        assert.ok(!JSON.stringify(out).includes(secret));
    });
});

describe('P2-D Phase B: GitHub Native Tools', () => {
    const names = [
        'github.searchRepositories',
        'github.getRepository',
        'github.listIssues',
        'github.listPullRequests'
    ];

    function registerGitHubTools() {
        toolRegistry._clearForTests();
        const registration = registerNativeTools(toolRegistry);
        return registration;
    }

    function useClient(request) {
        setGitHubClientFactory(() => ({ request }));
    }

    function repoData() {
        return {
            id: 7,
            name: 'repo',
            full_name: 'octocat/repo',
            private: false,
            html_url: 'https://github.com/octocat/repo',
            description: 'A repository',
            default_branch: 'main',
            language: 'JavaScript',
            stargazers_count: 12,
            forks_count: 3,
            open_issues_count: 2,
            owner: { login: 'octocat', email: 'private@example.test' },
            permissions: { admin: true }
        };
    }

    before(() => {
        toolRegistry._clearForTests();
        resetGitHubClientFactory();
    });

    after(() => {
        resetGitHubClientFactory();
        toolRegistry._clearForTests();
    });

    it('A registers four GitHub tools in the fifteen-tool native set', () => {
        const registration = registerGitHubTools();
        assert.deepEqual(NATIVE_TOOL_NAMES, [
            'calculator', 'gmail.search', 'gmail.getMessage', 'gmail.listThreads',
            'calendar.listCalendars', 'calendar.listEvents', 'calendar.getEvent',
            ...names,
            'filesystem.read', 'filesystem.list', 'filesystem.write', 'filesystem.createDirectory'
        ]);
        assert.deepEqual(registration.registered, NATIVE_TOOL_NAMES);
        assert.equal(toolRegistry.list().length, 15);
        assert.deepEqual(toolRegistry.list().filter((tool) => tool.name.startsWith('github.')).map((tool) => tool.name), names);
    });

    it('B exposes the defineTool metadata contract for every GitHub tool', () => {
        const tools = [githubSearchRepositories, githubGetRepository, githubListIssues, githubListPullRequests];
        for (const [index, tool] of tools.entries()) {
            assert.equal(tool.name, names[index]);
            assert.ok(tool.description);
            assert.equal(typeof tool.inputSchema, 'object');
            assert.equal(tool.readOnly, true);
            assert.equal(tool.needsApproval, false);
            assert.equal(typeof tool.execute, 'function');
            assert.ok(Object.isFrozen(tool));
            assert.deepEqual(toolRegistry.describe(tool.name), toMetadata(tool));
        }
    });

    it('C searchRepositories uses GET query parameters and sanitizes results', async () => {
        let seen;
        useClient(async (path, options) => {
            seen = { path, options };
            return {
                total_count: 1,
                items: [{ id: 1, name: 'repo', full_name: 'o/repo', private: false, html_url: 'https://x', description: null, owner: { email: 'hidden' } }]
            };
        });
        registerGitHubTools();
        const out = await toolRegistry.execute(names[0], { query: ' language:js ', maxResults: 5 });
        assert.equal(seen.path, '/search/repositories');
        assert.deepEqual(seen.options.query, { q: 'language:js', per_page: 5 });
        assert.deepEqual(out.result, {
            query: 'language:js',
            repositories: [{ id: 1, name: 'repo', fullName: 'o/repo', private: false, htmlUrl: 'https://x', description: null }],
            totalCount: 1
        });
        assert.deepEqual(out.mcpTools, [names[0]]);
    });

    it('D searchRepositories defaults maxResults and rejects required query failures', async () => {
        let seen;
        useClient(async (path, options) => { seen = { path, options }; return { items: [] }; });
        registerGitHubTools();
        await toolRegistry.execute(names[0], { query: 'stars:>10' });
        assert.equal(seen.options.query.per_page, 10);
        for (const input of [{}, { query: '' }, { query: '   ' }, { query: 1 }, []]) {
            await assert.rejects(() => toolRegistry.execute(names[0], input), (e) => e.code === 'TOOL_INVALID_INPUT');
        }
    });

    it('E searchRepositories enforces maxResults boundaries', async () => {
        let seen;
        useClient(async (path, options) => { seen = options; return { items: [] }; });
        registerGitHubTools();
        await toolRegistry.execute(names[0], { query: 'x', maxResults: 1 });
        assert.equal(seen.query.per_page, 1);
        await toolRegistry.execute(names[0], { query: 'x', maxResults: 50 });
        assert.equal(seen.query.per_page, 50);
        for (const value of [0, 51, 1.5, '10']) {
            await assert.rejects(() => toolRegistry.execute(names[0], { query: 'x', maxResults: value }), (e) => e.code === 'TOOL_INVALID_INPUT');
        }
    });

    it('F getRepository maps documented fields and strips account metadata', async () => {
        let seen;
        useClient(async (path, options) => { seen = { path, options }; return repoData(); });
        registerGitHubTools();
        const out = await toolRegistry.execute(names[1], { owner: 'octocat', repo: 'repo' });
        assert.equal(seen.path, '/repos/octocat/repo');
        assert.equal(seen.options.signal, null);
        assert.deepEqual(out.result, {
            owner: 'octocat', name: 'repo', fullName: 'octocat/repo', private: false,
            description: 'A repository', htmlUrl: 'https://github.com/octocat/repo',
            defaultBranch: 'main', language: 'JavaScript', stars: 12, forks: 3, openIssues: 2
        });
        assert.deepEqual(out.mcpTools, [names[1]]);
    });

    it('G getRepository accepts owner/repo string shorthand', async () => {
        let seen;
        useClient(async (path) => { seen = path; return repoData(); });
        registerGitHubTools();
        await toolRegistry.execute(names[1], 'octocat/repo');
        assert.equal(seen, '/repos/octocat/repo');
    });

    it('H getRepository validates required and malformed owner/repo input', async () => {
        useClient(async () => repoData());
        registerGitHubTools();
        for (const input of [{}, { owner: '', repo: 'r' }, { owner: 'o', repo: '' }, { owner: 'o' }, { repo: 'r' }, '', 'octocat', 'o/r/extra', [], null]) {
            await assert.rejects(() => toolRegistry.execute(names[1], input), (e) => e.code === 'TOOL_INVALID_INPUT');
        }
    });

    it('I getRepository URL-encodes path segments and rejects traversal forms', async () => {
        const paths = [];
        setGitHubClientFactory(() => createGitHubClient({
            fetchFn: async (url) => { paths.push(new URL(url).pathname); return jsonResponse(repoData()); },
            getHeaders: async () => ({})
        }));
        registerGitHubTools();
        await toolRegistry.execute(names[1], { owner: 'octo/name', repo: 'repo?x=1' });
        assert.equal(paths[0], '/repos/octo%2Fname/repo%3Fx%3D1');
        for (const input of ['../repo', 'owner/../repo']) {
            await assert.rejects(() => toolRegistry.execute(names[1], input), (e) => e.code === 'GITHUB_UPSTREAM' || e.code === 'TOOL_INVALID_INPUT');
        }
    });

    it('J listIssues sends state and pagination query and sanitizes issue fields', async () => {
        let seen;
        useClient(async (path, options) => {
            seen = { path, options };
            return [{ number: 4, title: 'Bug', state: 'open', html_url: 'https://x/4', created_at: '2026-01-01', updated_at: '2026-01-02', pull_request: {}, user: { login: 'private' }, labels: [] }];
        });
        registerGitHubTools();
        const out = await toolRegistry.execute(names[2], { owner: 'o', repo: 'r', state: 'all', maxResults: 7 });
        assert.equal(seen.path, '/repos/o/r/issues');
        assert.deepEqual(seen.options.query, { state: 'all', per_page: 7 });
        assert.deepEqual(out.result.issues, [{ number: 4, title: 'Bug', state: 'open', htmlUrl: 'https://x/4', createdAt: '2026-01-01', updatedAt: '2026-01-02', isPullRequest: true }]);
        assert.deepEqual(out.mcpTools, [names[2]]);
    });

    it('K listIssues supports shorthand and defaults to open issues', async () => {
        let seen;
        useClient(async (path, options) => { seen = { path, options }; return []; });
        registerGitHubTools();
        const out = await toolRegistry.execute(names[2], 'o/r');
        assert.equal(seen.path, '/repos/o/r/issues');
        assert.deepEqual(seen.options.query, { state: 'open', per_page: 10 });
        assert.deepEqual(out.result, { owner: 'o', repo: 'r', issues: [] });
    });

    it('L listIssues validates state, owner/repo, and maxResults', async () => {
        useClient(async () => []);
        registerGitHubTools();
        for (const input of [{ owner: 'o', repo: 'r', state: 'pending' }, { owner: 'o', repo: 'r', maxResults: 0 }, { owner: 'o' }, { owner: '', repo: 'r' }, { owner: 'o', repo: '' }, 'o']) {
            await assert.rejects(() => toolRegistry.execute(names[2], input), (e) => e.code === 'TOOL_INVALID_INPUT');
        }
    });

    it('M listPullRequests uses the pulls endpoint and returns only documented fields', async () => {
        let seen;
        useClient(async (path, options) => {
            seen = { path, options };
            return [{ number: 9, title: 'Change', state: 'closed', html_url: 'https://x/9', created_at: '2026-02-01', updated_at: '2026-02-02', merged_at: '2026-02-03', user: { email: 'hidden' }, requested_reviewers: [] }];
        });
        registerGitHubTools();
        const out = await toolRegistry.execute(names[3], { owner: 'o', repo: 'r', state: 'closed', maxResults: 3 });
        assert.equal(seen.path, '/repos/o/r/pulls');
        assert.deepEqual(seen.options.query, { state: 'closed', per_page: 3 });
        assert.deepEqual(out.result.pullRequests, [{ number: 9, title: 'Change', state: 'closed', htmlUrl: 'https://x/9', createdAt: '2026-02-01', updatedAt: '2026-02-02', mergedAt: '2026-02-03' }]);
        assert.deepEqual(out.mcpTools, [names[3]]);
    });

    it('N listPullRequests supports shorthand', async () => {
        let seen;
        useClient(async (path, options) => { seen = { path, options }; return []; });
        registerGitHubTools();
        const out = await toolRegistry.execute(names[3], 'o/r');
        assert.equal(seen.path, '/repos/o/r/pulls');
        assert.deepEqual(seen.options.query, { state: 'open', per_page: 10 });
        assert.deepEqual(out.result, { owner: 'o', repo: 'r', pullRequests: [] });
    });

    it('O listPullRequests validates state, owner/repo, and maxResults', async () => {
        useClient(async () => []);
        registerGitHubTools();
        for (const input of [{ owner: 'o', repo: 'r', state: 'pending' }, { owner: 'o', repo: 'r', maxResults: 51 }, { repo: 'r' }, { owner: 'o', repo: '' }, 'o/r/extra']) {
            await assert.rejects(() => toolRegistry.execute(names[3], input), (e) => e.code === 'TOOL_INVALID_INPUT');
        }
    });

    it('P all registry executions return the matching mcpTools metadata', async () => {
        useClient(async (path) => {
            if (path === '/search/repositories') return { items: [] };
            if (path.endsWith('/issues') || path.endsWith('/pulls')) return [];
            return repoData();
        });
        registerGitHubTools();
        const inputs = [{ query: 'x' }, { owner: 'o', repo: 'r' }, { owner: 'o', repo: 'r' }, { owner: 'o', repo: 'r' }];
        for (const [index, input] of inputs.entries()) {
            const out = await toolRegistry.execute(names[index], input);
            assert.deepEqual(out.mcpTools, [names[index]]);
        }
    });

    it('Q Planner selects each GitHub tool without Planner changes', () => {
        const planner = require('../src/agent/planner');
        for (const name of names) {
            const steps = planner.plan({ prompt: 'octocat/repo', tools: [name] });
            assert.deepEqual(steps[0], { id: 'step-1', kind: 'tool', name, input: 'octocat/repo', description: `tool:${name}` });
        }
    });

    it('R encoded traversal cannot escape a repository path', async () => {
        const paths = [];
        setGitHubClientFactory(() => createGitHubClient({
            fetchFn: async (url) => { paths.push(new URL(url).pathname); return jsonResponse([]); },
            getHeaders: async () => ({})
        }));
        registerGitHubTools();
        await assert.rejects(
            () => toolRegistry.execute(names[2], { owner: '../..', repo: 'r' }),
            (e) => e.code === 'GITHUB_UPSTREAM'
        );
        assert.equal(paths.length, 0);
    });

    it('S native tool requests cannot select arbitrary HTTP methods or paths', async () => {
        const calls = [];
        useClient(async (path, options) => { calls.push({ path, options }); return []; });
        registerGitHubTools();
        await toolRegistry.execute(names[2], { owner: 'o', repo: 'r' });
        await toolRegistry.execute(names[3], { owner: 'o', repo: 'r' });
        assert.deepEqual(calls.map((call) => call.options), [
            { query: { state: 'open', per_page: 10 }, signal: null },
            { query: { state: 'open', per_page: 10 }, signal: null }
        ]);
        assert.ok(calls.every((call) => /^\/repos\/[^/]+\/[^/]+\/(issues|pulls)$/.test(call.path)));
    });

    it('T propagates all GitHub upstream error codes unchanged', async () => {
        for (const code of ['GITHUB_CONFIG_MISSING', 'GITHUB_UNAUTHORIZED', 'GITHUB_FORBIDDEN', 'GITHUB_RATE_LIMITED', 'GITHUB_NOT_FOUND', 'GITHUB_UPSTREAM']) {
            useClient(async () => { throw Object.assign(new Error('upstream'), { code, status: 400 }); });
            registerGitHubTools();
            await assert.rejects(() => toolRegistry.execute(names[0], { query: 'x' }), (e) => e.code === code);
        }
    });

    it('U preserves ABORTED and TIMEOUT at the registry boundary', async () => {
        const controller = new AbortController();
        useClient(async () => { throw Object.assign(new Error('aborted'), { code: 'ABORTED' }); });
        registerGitHubTools();
        await assert.rejects(() => toolRegistry.execute(names[0], { query: 'x' }, { signal: controller.signal }), (e) => e.code === 'ABORTED');

        useClient(async () => new Promise(() => {}));
        registerGitHubTools();
        await assert.rejects(() => toolRegistry.execute(names[0], { query: 'x' }, { timeoutMs: 20 }), (e) => e.code === 'TIMEOUT');
    });

    it('V validates the native credential boundary using GITHUB_TOKEN only', () => {
        assert.throws(() => auth.getGitHubToken({ GITHUB_PERSONAL_ACCESS_TOKEN: 'decoy' }), (e) => e.code === 'GITHUB_CONFIG_MISSING');
        assert.equal(auth.getGitHubToken({ GITHUB_TOKEN: FAKE }), FAKE);
    });

    it('W never returns the injected credential in errors or tool output', async () => {
        const secret = 'ghp_phaseBfake123456';
        setGitHubClientFactory(() => createGitHubClient({
            fetchFn: async () => jsonResponse({ items: [{ id: 1, name: 'repo', full_name: 'o/r', private: false, html_url: 'https://x', description: 'public', owner: { email: secret } }] }),
            getHeaders: async () => ({})
        }));
        registerGitHubTools();
        const out = await toolRegistry.execute(names[0], { query: 'x' });
        assert.ok(!JSON.stringify(out).includes(secret));
        setGitHubClientFactory(() => createGitHubClient({
            fetchFn: async () => errResponse(503, `failure ${secret}`),
            getHeaders: async () => ({})
        }));
        registerGitHubTools();
        await assert.rejects(() => toolRegistry.execute(names[0], { query: 'x' }), (e) => !e.message.includes(secret) && e.code === 'GITHUB_UPSTREAM');
    });

    it('X resets the injected client and native registry cleanly', () => {
        registerGitHubTools();
        assert.equal(toolRegistry.list().length, 15);
        resetGitHubClientFactory();
        toolRegistry._clearForTests();
        assert.equal(toolRegistry.list().length, 0);
    });
});
