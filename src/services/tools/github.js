// GitHub Native Tools (read-only): github.searchRepositories / github.getRepository / github.listIssues / github.listPullRequests.
//
// Built with defineTool() per the P2-A contract. Uses only the Phase A
// foundation (src/services/github/auth.js + client.js) — no GitHub MCP
// involvement. Error mapping (GITHUB_* / ABORTED / TIMEOUT) lives in the
// client and passes through untouched.
//
// The Agent Core never imports this file — tools reach execution only via
// Planner -> ToolRegistry.
//
// Test seam: setGitHubClientFactory(fn) injects a mock client factory;
// resetGitHubClientFactory() restores the real GitHub REST client.
const { defineTool } = require('./tool');
const { createGitHubClient } = require('../github/client');

let clientFactory = null;

function setGitHubClientFactory(fn) {
    clientFactory = fn;
}

function resetGitHubClientFactory() {
    clientFactory = null;
}

function getClient() {
    if (clientFactory) return clientFactory();
    return createGitHubClient();
}

function inputError(toolName, message) {
    return Object.assign(new Error(`${toolName}: ${message}`), { status: 400, code: 'TOOL_INVALID_INPUT' });
}

function checkAborted(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

function checkMaxResults(toolName, value, def) {
    if (value === undefined || value === null) return def;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) {
        throw inputError(toolName, 'maxResults must be an integer between 1 and 50');
    }
    return value;
}

function checkState(toolName, value) {
    if (value === undefined || value === null) return 'open';
    if (value !== 'open' && value !== 'closed' && value !== 'all') {
        throw inputError(toolName, 'state must be one of: open, closed, all');
    }
    return value;
}

function parseOwnerRepo(input) {
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!trimmed) {
            throw inputError('github', 'owner/repo must be a non-empty string');
        }
        const parts = trimmed.split('/');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
            throw inputError('github', 'owner/repo must be in format "owner/repo"');
        }
        return { owner: parts[0], repo: parts[1] };
    }
    return null;
}

function checkOwnerRepo(toolName, obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw inputError(toolName, 'input must be an object with owner and repo');
    }
    if (typeof obj.owner !== 'string' || !obj.owner.trim()) {
        throw inputError(toolName, 'owner must be a non-empty string');
    }
    if (typeof obj.repo !== 'string' || !obj.repo.trim()) {
        throw inputError(toolName, 'repo must be a non-empty string');
    }
    return { owner: obj.owner.trim(), repo: obj.repo.trim() };
}

// --- Tool definitions -----------------------------------------------------

const githubSearchRepositories = defineTool({
    name: 'github.searchRepositories',
    description: 'Search GitHub repositories (read-only) by query string',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'GitHub search query, e.g. "language:javascript stars:>1000"' },
            maxResults: { type: 'number', description: 'max repositories to return (1-50, default 10)' }
        },
        required: ['query']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const query = typeof input === 'string' ? input.trim() : input && typeof input === 'object' && !Array.isArray(input)
            ? typeof input.query === 'string' ? input.query.trim() : ''
            : '';
        if (!query) {
            throw inputError('github.searchRepositories', 'query must be a non-empty string');
        }
        const maxResults = checkMaxResults('github.searchRepositories', typeof input === 'object' && input !== null ? input.maxResults : undefined, 10);
        const client = getClient();
        const data = await client.request('/search/repositories', {
            query: { q: query, per_page: maxResults },
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        const items = Array.isArray(data && data.items) ? data.items : [];
        const repositories = items.map((r) => ({
            id: r.id,
            name: r.name,
            fullName: r.full_name,
            private: r.private === true,
            htmlUrl: r.html_url,
            description: r.description || null
        }));
        return {
            result: {
                query,
                repositories,
                totalCount: typeof data.total_count === 'number' ? data.total_count : repositories.length
            },
            mcpTools: ['github.searchRepositories']
        };
    }
});

const githubGetRepository = defineTool({
    name: 'github.getRepository',
    description: 'Get a GitHub repository by owner/repo (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' }
        },
        required: ['owner', 'repo']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: the deterministic planner passes a string as step input
        const shorthand = parseOwnerRepo(input);
        let owner, repo;
        if (shorthand) {
            ({ owner, repo } = shorthand);
        } else {
            ({ owner, repo } = checkOwnerRepo('github.getRepository', input));
        }
        const client = getClient();
        const data = await client.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return {
            result: {
                owner: data.owner?.login || owner,
                name: data.name,
                fullName: data.full_name,
                private: data.private === true,
                description: data.description || null,
                htmlUrl: data.html_url,
                defaultBranch: data.default_branch,
                language: data.language || null,
                stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : 0,
                forks: typeof data.forks_count === 'number' ? data.forks_count : 0,
                openIssues: typeof data.open_issues_count === 'number' ? data.open_issues_count : 0
            },
            mcpTools: ['github.getRepository']
        };
    }
});

const githubListIssues = defineTool({
    name: 'github.listIssues',
    description: 'List GitHub issues for a repository (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', description: 'Issue state: open, closed, or all (default open)' },
            maxResults: { type: 'number', description: 'max issues to return (1-50, default 10)' }
        },
        required: ['owner', 'repo']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: the deterministic planner passes a string as step input
        const shorthand = parseOwnerRepo(input);
        let owner, repo;
        let state = 'open';
        let maxResults = 10;
        if (shorthand) {
            ({ owner, repo } = shorthand);
        } else {
            const obj = input;
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
                throw inputError('github.listIssues', 'input must be an object with owner and repo');
            }
            ({ owner, repo } = checkOwnerRepo('github.listIssues', obj));
            state = checkState('github.listIssues', obj.state);
            maxResults = checkMaxResults('github.listIssues', obj.maxResults, 10);
        }
        const client = getClient();
        const data = await client.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
            query: { state, per_page: maxResults },
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        const items = Array.isArray(data) ? data : [];
        const issues = items.map((item) => ({
            number: item.number,
            title: item.title,
            state: item.state,
            htmlUrl: item.html_url,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            isPullRequest: !!item.pull_request
        }));
        return {
            result: {
                owner,
                repo,
                issues
            },
            mcpTools: ['github.listIssues']
        };
    }
});

const githubListPullRequests = defineTool({
    name: 'github.listPullRequests',
    description: 'List GitHub pull requests for a repository (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', description: 'PR state: open, closed, or all (default open)' },
            maxResults: { type: 'number', description: 'max pull requests to return (1-50, default 10)' }
        },
        required: ['owner', 'repo']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: the deterministic planner passes a string as step input
        const shorthand = parseOwnerRepo(input);
        let owner, repo;
        let state = 'open';
        let maxResults = 10;
        if (shorthand) {
            ({ owner, repo } = shorthand);
        } else {
            const obj = input;
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
                throw inputError('github.listPullRequests', 'input must be an object with owner and repo');
            }
            ({ owner, repo } = checkOwnerRepo('github.listPullRequests', obj));
            state = checkState('github.listPullRequests', obj.state);
            maxResults = checkMaxResults('github.listPullRequests', obj.maxResults, 10);
        }
        const client = getClient();
        const data = await client.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
            query: { state, per_page: maxResults },
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        const items = Array.isArray(data) ? data : [];
        const pullRequests = items.map((item) => ({
            number: item.number,
            title: item.title,
            state: item.state,
            htmlUrl: item.html_url,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            mergedAt: item.merged_at
        }));
        return {
            result: {
                owner,
                repo,
                pullRequests
            },
            mcpTools: ['github.listPullRequests']
        };
    }
});

module.exports = {
    githubSearchRepositories,
    githubGetRepository,
    githubListIssues,
    githubListPullRequests,
    setGitHubClientFactory,
    resetGitHubClientFactory
};