const http = require('http');
const url = require('url');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;

function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(JSON.stringify(body));
}

function runDeploy(res) {
  console.log('[DEPLOY] Starting deploy via scripts/deploy.ts');
  const child = spawn('npx', ['hardhat', 'run', 'scripts/deploy.ts'], {
    env: process.env
  });

  let output = '';
  child.stdout.on('data', (d) => {
    const msg = d.toString();
    output += msg;
    console.log('[DEPLOY OUT]', msg.trim());
  });
  child.stderr.on('data', (d) => {
    const msg = d.toString();
    output += msg;
    console.error('[DEPLOY ERR]', msg.trim());
  });
  child.on('close', (code) => {
    console.log(`[DEPLOY] Finished with code ${code}`);
    if (code === 0) {
      return send(res, 200, { ok: true, code, output });
    } else {
      return send(res, 500, { ok: false, code, output });
    }
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url, true);

  if (pathname === '/' || pathname === '/health') {
    return send(res, 200, { ok: true, service: 'predikt-backend', time: new Date().toISOString() });
  }
  if (pathname === '/env') {
    const redact = (k) => ['PRIVATE_KEY','MNEMONIC','ALCHEMY_KEY','INFURA_KEY'].includes(k);
    const env = Object.fromEntries(Object.entries(process.env).map(([k,v]) => [k, redact(k) ? '***' : v]));
    return send(res, 200, { ok: true, env });
  }
  if (pathname === '/version') {
    return send(res, 200, { name: process.env.npm_package_name || 'app', version: process.env.npm_package_version || '0.0.0' });
  }
  if (pathname === '/deploy' && req.method === 'POST') {
    return runDeploy(res);
  }

  return send(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(PORT, () => console.log(`[predikt] listening on :${PORT}`));
