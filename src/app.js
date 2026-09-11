require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const cookieParser = require('cookie-parser');
const { validateEnv } = require('./middleware/validateEnv');
const { initDb } = require('./db/db');
const healthRouter = require('./routes/health');
const chatRouter = require('./routes/chat');
const sessionsRouter = require('./routes/sessions');
const { authMiddleware, loginHandler, logoutHandler, meHandler } = require('./middleware/auth');
const { loginLimiter } = require('./middleware/rateLimit');

validateEnv();

const app = express();

// CORS: allow all in development, restrict via ALLOWED_ORIGINS in production
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : null;
if (allowedOrigins) {
    app.use(cors({
        origin: (origin, cb) => {
            if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) return cb(null, true);
            return cb(new Error('Not allowed by CORS'));
        }
    }));
} else {
    // In production without explicit origins, still allow but log warning
    if (process.env.NODE_ENV === 'production') {
        console.warn('[CORS] ALLOWED_ORIGINS not set, allowing all origins');
    }
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
app.post('/api/auth/login', loginLimiter, loginHandler);
app.post('/api/auth/logout', logoutHandler);
app.use('/api', authMiddleware);
app.get('/api/auth/me', meHandler);
app.use('/api', chatRouter);
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
