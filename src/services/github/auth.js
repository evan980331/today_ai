// GitHub auth for Native Tools (read-only) — P2-D Phase A foundation.
//
// Independent credential: the GitHub MCP (@modelcontextprotocol/
// server-github) authenticates via GITHUB_PERSONAL_ACCESS_TOKEN. The Native
// GitHub API uses its own GITHUB_TOKEN (fine-grained PAT with read-only
// permissions). Never reuse, copy, or convert the MCP token.
//
// No OAuth flow: GitHub PATs are bearer tokens used directly as
// Authorization: Bearer <token>. The token is read from env per call,
// never persisted, never logged, never placed in error messages.
function githubError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function isPlaceholder(v) {
    return typeof v !== 'string' || !v.trim() || v.includes('your_') || v.includes('example') || v.includes('here');
}

// Reads the token from env only. Throws GITHUB_CONFIG_MISSING (status 400
// so the code survives the ToolRegistry boundary verbatim) when absent.
// Name only in the message — never the value.
function getGitHubToken(env) {
    const e = env || process.env;
    const token = e.GITHUB_TOKEN;
    if (isPlaceholder(token)) {
        throw githubError(400, 'GITHUB_CONFIG_MISSING', 'github is not configured (missing: GITHUB_TOKEN)');
    }
    return token.trim();
}

// Builds request headers. The token never leaves this module except inside
// the Authorization header value itself.
function authHeaders(env) {
    return {
        Authorization: `Bearer ${getGitHubToken(env)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
}

module.exports = { getGitHubToken, authHeaders };
