// Vercel serverless entrypoint for the Today AI Express app.
//
// Why this file exists: the repository previously had no function entry
// (`api/` or `vercel.json`), so no Vercel deployment built from this tree
// could serve `/` as a function at all.
//
// What it does NOT do (by design):
// - never calls app.listen() (serverless has no long-lived listener;
//   see src/server.js, used only for node/npm start)
// - never spawns processes or starts workers/OpenCode (see P0.8-12 and
//   scripts/build-check.js, which enforces this boundary)
// - never invents environment variables: src/app.js validateEnv() still
//   fails fast when production env is missing; configure env in the
//   Vercel dashboard instead (see docs/deployment-checklist.md).
//
// The require() is lazy (inside the handler) so module load never executes
// app initialization; the app boots on first invocation and is reused by
// Node's module cache on warm invocations.
module.exports = (req, res) => {
    // Vercel rewrites /api/:path* -> /api may mutate req.url to /api in some
    // runtime versions (warning: "rewrites now route using destination path").
    // Restore original path from Vercel forwarding headers when possible.
    // Local http.createServer tests pass original url unchanged, so this is no-op there.
    if (req.url === '/api' || req.url === '/api/') {
        const cand = req.headers['x-matched-path']
            || req.headers['x-vercel-matched-path']
            || req.headers['x-invoke-path']
            || req.headers['x-forwarded-uri']
            || req.headers['x-original-uri']
            || req.headers['x-vercel-original-uri'];
        if (cand && typeof cand === 'string' && cand.startsWith('/api/')) {
            req.url = cand;
        }
    }
    const app = require('../src/app');
    return app(req, res);
};
