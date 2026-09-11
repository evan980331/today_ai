const app = require('./app');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const HOST = process.env.HOST || '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
    console.log(`==========================================`);
    console.log(` Today AI listening on http://${HOST}:${PORT}`);
    console.log(` ENV: ${process.env.NODE_ENV || 'development'}`);
    console.log(` OPENCODE_SERVER_URL: ${process.env.OPENCODE_SERVER_URL || '(direct run)'}`);
    console.log(`==========================================`);
});

function shutdown(signal) {
    console.log(`[Server] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
