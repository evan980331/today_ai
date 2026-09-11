const rateLimit = require('express-rate-limit');

const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '請求過於頻繁，請稍後再試 (Rate limited)' }
});

const historyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: '登入嘗試過多，請 15 分鐘後再試' }
});

module.exports = { chatLimiter, historyLimiter, loginLimiter };
