const crypto = require('crypto');

// Password hashing using Node.js built-in crypto.scrypt (no extra dependency).
// Stored format: scrypt$<salt hex>$<derivedKey hex>
// Salt: 16 bytes random. scrypt params: N=16384, r=8, p=1, keyLen=64
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64 };

function hashPassword(password) {
    if (typeof password !== 'string' || password.length === 0) throw new Error('password is required');
    if (password.length > 1024) throw new Error('password too long');
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keyLen, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p });
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const saltHex = parts[1];
    const hashHex = parts[2];
    try {
        const salt = Buffer.from(saltHex, 'hex');
        const expected = Buffer.from(hashHex, 'hex');
        if (salt.length !== 16 || expected.length !== SCRYPT_PARAMS.keyLen) return false;
        const derived = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keyLen, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p });
        if (derived.length !== expected.length) return false;
        return crypto.timingSafeEqual(derived, expected);
    } catch {
        return false;
    }
}

module.exports = { hashPassword, verifyPassword, SCRYPT_PARAMS };
