// Minimal HTTP server for Heroku so the dyno stays up.
const http = require('http');
const url = require('url');
const PORT = process.env.PORT || 3000;
function send(res, status, body, headers={}) {
  res.writeHead(status, Object.assign({'Content-Type': 'application/json'}, headers));
  res.end(JSON.stringify(body));
}
const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url, true);
  if (pathname === '/' || pathname === '/health' || pathname === '/healthz') {
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
  send(res, 404, { ok: false, error: 'Not Found' });
});
server.listen(PORT, () => console.log(`[predikt] listening on :${PORT}`));
