function validateEnv() {
    const required = ['DATABASE_URL'];
    const optional = ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'OPENCODE_SERVER_URL', 'PORT', 'MCP_TIMEOUT_MS', 'ALLOWED_ORIGINS'];

    const missing = required.filter(k => !process.env[k] || !process.env[k].trim());
    if (missing.length) {
        console.error('==========================================');
        console.error('[ENV] Missing required environment variables:');
        missing.forEach(k => console.error(`  - ${k}`));
        console.error('Check .env or deployment env vars');
        console.error('==========================================');
        process.exit(1);
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
    if (process.env.MOCK_OPENCODE === 'true' && process.env.NODE_ENV === 'production') {
        console.warn('[ENV] WARNING: MOCK_OPENCODE=true in production - mock will be disabled');
    }

    // Never log secrets
    console.log('[ENV] validation passed');
}

module.exports = { validateEnv };
