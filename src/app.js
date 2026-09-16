require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const cookieParser = require('cookie-parser');
const { validateEnv } = require('./middleware/validateEnv');
const { initDb } = require('./db/db');
const healthRouter = require('./routes/health');
const debugEnvRouter = require('./routes/debugEnv'); // TEMPORARY diagnostic, to be deleted
const chatRouter = require('./routes/chat');
const streamRouter = require('./routes/stream');
const sessionsRouter = require('./routes/sessions');
const { authMiddleware, loginHandler, logoutHandler, meHandler } = require('./middleware/auth');
const { loginLimiter } = require('./middleware/rateLimit');

validateEnv();

const app = express();

// CORS: restrict via ALLOWED_ORIGINS in production, allow all in development
const isProd = process.env.NODE_ENV === 'production';
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : null;

if (isProd) {
    // Production: ALLOWED_ORIGINS is required (validated in validateEnv.js)
    // Never allow * with credentials
    app.use(cors({
        origin: (origin, cb) => {
            if (!origin) return cb(null, true); // same-origin / curl / server-to-server
            if (allowedOrigins && allowedOrigins.includes(origin)) return cb(null, true);
            return cb(null, false); // reject silently — no CORS headers
        },
        credentials: true
    }));
} else {
    // Development: allow all origins for local testing
    app.use(cors());
}

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser());

// Init DB (non-blocking, does not crash on failure)
initDb();
const pingInterval = setInterval(() => {
    const { ping } = require('./db/db');
    ping().catch(() => console.warn('[DB] ping failed'));
}, 30000);
if (pingInterval.unref) pingInterval.unref();

// Static frontend
app.use(express.static(path.join(__dirname, '../public')));

// Routes: health & login are public, rest requires auth
app.use('/api', healthRouter);
app.use('/api', debugEnvRouter); // TEMPORARY diagnostic, to be deleted
app.post('/api/auth/login', loginLimiter, loginHandler);
app.post('/api/auth/logout', logoutHandler);
app.use('/api', authMiddleware);
app.get('/api/auth/me', meHandler);
app.use('/api', chatRouter);
app.use('/api', streamRouter);
app.use('/api', sessionsRouter);

// Consistent error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err);
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Internal Server Error', details: err.details || undefined });
});

// 404 for API
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not Found', details: `${req.method} ${req.path} not found` });
});

module.exports = app;
