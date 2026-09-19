function validateEnv() {
    const isProd = process.env.NODE_ENV === 'production';
    const required = ['DATABASE_URL'];
    if (isProd) {
        required.push('ALLOWED_ORIGINS');
    }
    // AUTH_USERNAME/AUTH_PASSWORD are no longer required: credentials live in
    // Neon auth_users (hashed). Use `npm run auth:setup` with those env vars
    // once to initialize. WORKSPACE_ROOT is Worker-only (workspace.js fallback).

    const missing = required.filter(k => !process.env[k] || !process.env[k].trim());
    if (missing.length) {
        console.error('==========================================');
        console.error('[ENV] Missing required environment variables:');
        missing.forEach(k => console.error(`  - ${k}`));
        console.error('Check .env or deployment env vars');
        console.error('==========================================');
        process.exit(1);
    }

    // Production: validate ALLOWED_ORIGINS content
    if (isProd && process.env.ALLOWED_ORIGINS) {
        const origins = process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
        if (origins.length === 0) {
            console.error('[ENV] ALLOWED_ORIGINS is empty or whitespace-only');
            process.exit(1);
        }
        if (origins.includes('*')) {
            console.error('[ENV] ALLOWED_ORIGINS must not use wildcard * in production (credentials security)');
            process.exit(1);
        }
        // Validate each origin looks like a URL
        for (const o of origins) {
            if (!o.startsWith('http://') && !o.startsWith('https://')) {
                console.error(`[ENV] ALLOWED_ORIGINS entry "${o}" must start with http:// or https://`);
                process.exit(1);
            }
        }
    }

    // Warn for optional but not exit
    if (!process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN.includes('your_')) {
        console.warn('[ENV] GITHUB_PERSONAL_ACCESS_TOKEN not set (GitHub MCP will be disabled)');
    }
    if (!process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN.includes('your_')) {
        console.warn('[ENV] GOOGLE_REFRESH_TOKEN not set (Gmail/Calendar MCP will be disabled)');
    }
    if (process.env.OPENCODE_SERVER_URL) {
        console.log(`[ENV] OPENCODE_SERVER_URL=${process.env.OPENCODE_SERVER_URL}`);
    } else {
        console.log('[ENV] OPENCODE_SERVER_URL not set, using direct opencode run');
    }
    if (process.env.MOCK_OPENCODE === 'true' && isProd) {
        console.error('[ENV] MOCK_OPENCODE=true is forbidden in production');
        process.exit(1);
    }
    // P0.8-4: remote worker must be fully configured or not at all.
    // Half configuration (URL without secret or vice versa) fails loudly in
    // production — never fall back to an insecure or wrong worker silently.
    // Development keeps local fallback with a warning.
    const hasWorkerUrl = !!(process.env.WORKER_URL && process.env.WORKER_URL.trim());
    const hasWorkerSecret = !!(process.env.WORKER_SHARED_SECRET && process.env.WORKER_SHARED_SECRET.trim());
    if (hasWorkerUrl !== hasWorkerSecret) {
        if (isProd) {
            console.error('[ENV] WORKER_URL and WORKER_SHARED_SECRET must both be set (or both unset) in production');
            process.exit(1);
        }
        console.warn('[ENV] WORKER_URL/WORKER_SHARED_SECRET half-configured: remote worker disabled, using local execution');
    } else if (isProd && hasWorkerUrl) {
        console.log('[ENV] remote Agent Worker mode enabled');
    }
    // Remote Worker mode needs no OPENCODE_SERVER_URL: silence this warning
    // when the worker pair is configured so boot logs agree with the
    // health/chat/stream runtime decision (remote first). Local/direct mode
    // keeps the warning.
    if (isProd && !process.env.OPENCODE_SERVER_URL && !(hasWorkerUrl && hasWorkerSecret)) {
        console.warn('[ENV] OPENCODE_SERVER_URL not set: OpenCode runtime unavailable in production (chat returns explicit 503)');
    }
    if (!isProd && !process.env.DATABASE_URL) {
        console.warn('[ENV] DATABASE_URL not set (auth will allow all in dev without DB)');
    }

    // Never log secrets
    console.log('[ENV] validation passed');
}

module.exports = { validateEnv };
