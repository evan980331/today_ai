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

module.exports = { chatLimiter, historyLimiter };
