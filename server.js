// Minimal HTTP server for Heroku so the dyno stays up + trigger deploy.
const http = require('http');
const url = require('url');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;

// Helper to send JSON
function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(JSON.stringify(body));
}

// Run hardhat deploy script and stream logs to console (Heroku logs)
function runDeploy(res, scriptPath) {
  const script = scriptPath || 'scripts/deploy.ts'; // your current script
  const args = ['hardhat', 'run', script]; // no --network flag; rely on RPC_URL in config
  console.log(`[DEPLOY] Running: npx ${args.join(' ')}`);

  const child = spawn('npx', args, { env: process.env });

  let buffer = '';
  child.stdout.on('data', (d) => {
    const msg = d.toString();
    buffer += msg;
    console.log('[DEPLOY OUT]', msg.trimEnd());
  });
  child.stderr.on('data', (d) => {
    const msg = d.toString();
    buffer += msg;
    console.error('[DEPLOY ERR]', msg.trimEnd());
  });
  child.on('close', (code) => {
    console.log(`[DEPLOY] Exit code ${code}`);
    if (code === 0) return send(res, 200, { ok: true, code, output: buffer });
    return send(res, 500, { ok: false, code, output: buffer });
  });
}

const server = http.createServer((req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  // Health
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/healthz')) {
    return send(res, 200, { ok: true, service: 'predikt-backend', time: new Date().toISOString() });
  }

  // Env (redacted)
  if (req.method === 'GET' && pathname === '/env') {
    const redact = (k) => ['PRIVATE_KEY','MNEMONIC','ALCHEMY_KEY','INFURA_KEY'].includes(k);
    const env = Object.fromEntries(Object.entries(process.env).map(([k,v]) => [k, redact(k) ? '***' : v]));
    return send(res, 200, { ok: true, env });
  }

  // Version
  if (req.method === 'GET' && pathname === '/version') {
    return send(res, 200, { name: process.env.npm_package_name || 'app', version: process.env.npm_package_version || '0.0.0' });
  }

  // Deploy endpoint (POST /deploy?script=scripts/deploy.ts)
  if (req.method === 'POST' && pathname === '/deploy') {
    // Optional bearer auth: set HEROKU_DEPLOY_TOKEN to enforce
    const needAuth = !!process.env.HEROKU_DEPLOY_TOKEN;
    if (needAuth) {
      const header = req.headers['authorization'] || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token || token !== process.env.HEROKU_DEPLOY_TOKEN) {
        return send(res, 401, { ok: false, error: 'Unauthorized' });
      }
    }

    const script = query && query.script ? query.script : 'scripts/deploy.ts';
    // Ensure RPC_URL is present since we’re not passing --network
    if (!process.env.RPC_URL) {
      console.error('[DEPLOY ERROR] RPC_URL env is missing');
      return send(res, 500, { ok: false, error: 'RPC_URL env is missing' });
    }
    console.log('[DEPLOY] Triggered via /deploy, script=', script);
    return runDeploy(res, script);
  }

  // 404
  return send(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(PORT, () => console.log(`[predikt] listening on :${PORT}`));
