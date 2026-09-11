function validateEnv() {
    const required = ['DATABASE_URL'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
        console.error('==========================================');
        console.error('[ENV] 缺少必要環境變數，服務將退出:');
        missing.forEach(k => console.error(`  - ${k}`));
        console.error('請檢查 .env 或 Render/Railway 環境變數設定');
        console.error('==========================================');
        process.exit(1);
    }
    if (!process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN.includes('your_')) {
        console.warn('[ENV] 警告: GITHUB_PERSONAL_ACCESS_TOKEN 未設定或為佔位符，GitHub MCP 將無法使用');
    }
    console.log('[ENV] 環境變數檢查通過');
}

module.exports = { validateEnv };
