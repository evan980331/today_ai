const rateLimit = require('express-rate-limit');

const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 8, // 每 IP 每分鐘 8 次
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '請求過於頻繁，請稍後再試 (Rate limited)' }
});

const historyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = { chatLimiter, historyLimiter };
