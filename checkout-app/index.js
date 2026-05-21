/**
 * SandboxAgent — Per-Sandbox Checkout View
 *
 * Tiny Node.js HTTP server that gets deployed as ONE ECS Fargate task per
 * sandbox. Reads its config from env vars (injected via task definition) so
 * each sandbox shows merchant-specific data + the real Aplazo checkout link.
 *
 * Zero external deps — uses built-in `http` to keep the image tiny.
 */

const http = require('http');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const SANDBOX_ID       = process.env.SANDBOX_ID       || 'unknown';
const MERCHANT_ID      = process.env.MERCHANT_ID      || 'unknown';
const MERCHANT_NAME    = process.env.MERCHANT_NAME    || 'unknown';
const INTEGRATION_TYPE = process.env.INTEGRATION_TYPE || 'API';
const CHECKOUT_URL     = process.env.CHECKOUT_URL     || '';
const RDS_INSTANCE     = process.env.RDS_INSTANCE     || 'unknown';
const ECS_SERVICE      = process.env.ECS_SERVICE      || 'unknown';
const CREATED_AT       = process.env.CREATED_AT       || new Date().toISOString();
const AWS_REGION       = process.env.AWS_REGION       || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const HOST_NAME        = os.hostname();
const STARTED_AT       = new Date().toISOString();

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

function renderPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Sandbox ${esc(SANDBOX_ID)} — ${esc(MERCHANT_NAME)}</title>
<style>
  :root {
    --bg: #0b0d12; --panel: #141821; --panel-2: #1b2030; --border: #232a3a;
    --text: #e6e9ef; --text-dim: #8b93a7; --accent: #6c8cff; --accent-2: #9d7bff;
    --ok: #3ecf8e; --shadow: 0 8px 24px rgba(0,0,0,.35);
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         color: var(--text); padding: 40px 20px;
         background: radial-gradient(1200px 600px at 20% -10%, #1a2240 0%, transparent 60%),
                     radial-gradient(900px 500px at 90% 0%, #2a1a40 0%, transparent 55%), var(--bg); }
  .wrap { max-width: 880px; margin: 0 auto; }
  header { margin-bottom: 32px; }
  .brand { font-size: 13px; color: var(--text-dim); letter-spacing: 2px; margin-bottom: 4px; }
  h1 { margin: 0 0 6px; font-size: 32px; letter-spacing: -0.5px; }
  .subtitle { color: var(--text-dim); font-size: 15px; }
  .badge {
    display: inline-block; background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white; font-weight: 600; font-size: 11px; padding: 3px 10px;
    border-radius: 999px; letter-spacing: 0.5px; margin-left: 8px; vertical-align: middle;
  }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
          padding: 24px; box-shadow: var(--shadow); margin-bottom: 18px; }
  .card h2 { margin: 0 0 16px; font-size: 13px; color: var(--text-dim);
             letter-spacing: 0.4px; text-transform: uppercase; font-weight: 700; }
  .row { display: grid; grid-template-columns: 160px 1fr; gap: 12px; padding: 8px 0; font-size: 14px; }
  .row .k { color: var(--text-dim); }
  .row .v { color: var(--text); word-break: break-all; }
  .row .v code { background: var(--panel-2); padding: 2px 6px; border-radius: 4px;
                 font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .cta { display: inline-flex; align-items: center; gap: 10px;
         background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: white;
         text-decoration: none; padding: 14px 22px; border-radius: 10px;
         font-weight: 600; font-size: 15px; transition: transform .08s ease; box-shadow: var(--shadow); }
  .cta:hover { transform: translateY(-1px); }
  .cta-row { margin-top: 8px; }
  .pill { display: inline-block; padding: 3px 10px; font-size: 11px; border-radius: 999px;
          background: var(--panel-2); border: 1px solid var(--border); color: var(--text-dim); margin-right: 6px; }
  .pill.ok { color: var(--ok); border-color: rgba(62,207,142,0.4); }
  .footer { color: var(--text-dim); font-size: 12px; text-align: center; margin-top: 36px; line-height: 1.6; }
  .footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="brand">aplazo</div>
    <h1>Sandbox <code style="color: var(--accent);">${esc(SANDBOX_ID)}</code><span class="badge">LIVE</span></h1>
    <div class="subtitle">Isolated AWS environment provisioned by SandboxAgent for <strong>${esc(MERCHANT_NAME)}</strong></div>
  </header>

  <div class="card">
    <h2>Merchant integration</h2>
    <div class="row"><div class="k">Merchant ID</div><div class="v"><code>${esc(MERCHANT_ID)}</code></div></div>
    <div class="row"><div class="k">Merchant name</div><div class="v">${esc(MERCHANT_NAME)}</div></div>
    <div class="row"><div class="k">Integration type</div><div class="v"><span class="pill">${esc(INTEGRATION_TYPE)}</span></div></div>
    <div class="row"><div class="k">Sandbox created</div><div class="v">${esc(CREATED_AT)}</div></div>
  </div>

  ${CHECKOUT_URL ? `
  <div class="card">
    <h2>Run integration test</h2>
    <div style="color: var(--text-dim); font-size: 14px; margin-bottom: 16px;">
      A real loan has been created against this sandbox's merchant credentials.
      Click below to open the Aplazo checkout and complete the test flow.
    </div>
    <div class="cta-row">
      <a class="cta" href="${esc(CHECKOUT_URL)}" target="_blank" rel="noopener">Open test checkout →</a>
    </div>
  </div>
  ` : ''}

  <div class="card">
    <h2>AWS infrastructure</h2>
    <div class="row"><div class="k">Region</div><div class="v"><code>${esc(AWS_REGION)}</code></div></div>
    <div class="row"><div class="k">ECS service</div><div class="v"><code>${esc(ECS_SERVICE)}</code> <span class="pill ok">running</span></div></div>
    <div class="row"><div class="k">RDS instance</div><div class="v"><code>${esc(RDS_INSTANCE)}</code> <span class="pill ok">available</span></div></div>
    <div class="row"><div class="k">Container host</div><div class="v"><code>${esc(HOST_NAME)}</code></div></div>
    <div class="row"><div class="k">Container started</div><div class="v">${esc(STARTED_AT)}</div></div>
  </div>

  <div class="footer">
    Provisioned by <a href="https://www.aplazo.ai/engineering/sandboxagent-demo-may2026.html" target="_blank">SandboxAgent</a>
    · APLAZO Hackathon 2026<br>
    Tagged with <code style="font-size:11px;">expires=2026-05-30</code> — auto-cleanup by DevOps reaper
  </div>

</div>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const log = (status) => console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${status} sandbox=${SANDBOX_ID}`);

  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sandbox: SANDBOX_ID, merchant: MERCHANT_ID }));
    log(200);
    return;
  }

  if (req.url === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sandboxId: SANDBOX_ID, merchantId: MERCHANT_ID, merchantName: MERCHANT_NAME,
      integrationType: INTEGRATION_TYPE, rdsInstance: RDS_INSTANCE, ecsService: ECS_SERVICE,
      region: AWS_REGION, container: HOST_NAME, startedAt: STARTED_AT,
    }));
    log(200);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderPage());
  log(200);
});

server.listen(PORT, () => {
  console.log(`SandboxAgent checkout view listening on :${PORT}`);
  console.log(`  sandbox=${SANDBOX_ID} merchant=${MERCHANT_ID} (${MERCHANT_NAME})`);
});
