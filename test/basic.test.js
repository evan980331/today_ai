const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Architecture checks', () => {
    it('should not contain hardcoded Windows path', () => {
        const files = [
            'src/app.js',
            'src/server.js',
            'src/routes/chat.js',
            'src/db/db.js'
        ];
        for (const f of files) {
            const content = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
            assert.ok(!content.includes('D:\\'), `${f} should not contain D:\\`);
            assert.ok(!content.toLowerCase().includes('powershell.exe'), `${f} should not depend on powershell.exe`);
        }
        // opencode.js is allowed to have platform-guarded powershell for Windows fallback
        const opencodeContent = fs.readFileSync(path.join(__dirname, '../src/services/opencode.js'), 'utf8');
        assert.ok(!opencodeContent.includes('D:\\'), 'opencode.js should not contain D:\\');
        if (opencodeContent.toLowerCase().includes('powershell.exe')) {
            assert.ok(opencodeContent.includes("process.platform === 'win32'"), 'powershell.exe must be guarded by platform check for Linux compatibility');
        }
    });

    it('validateSessionId should accept UUID and reject injection', () => {
        const { validateSessionId } = require('../src/services/session');
        const uuid = '123e4567-e89b-12d3-a456-426614174000';
        assert.equal(validateSessionId(uuid), uuid);
        assert.throws(() => validateSessionId("'; DROP TABLE--"), /Invalid/);
        assert.throws(() => validateSessionId(''), /required/);
    });

    it('opencode service should be importable and have run function', () => {
        const svc = require('../src/services/opencode');
        assert.equal(typeof svc.run, 'function');
        assert.equal(typeof svc.isServerUrlConfigured, 'function');
    });

    it('app should be importable', () => {
        const app = require('../src/app');
        assert.ok(app);
    });
});
