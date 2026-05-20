const { ok, error, parseBody } = require('../shared/response');

/**
 * fetch_config — auth-gated runtime config endpoint.
 *
 * Replaces hardcoded CONFIG.apiKey / CONFIG.backendToken in the frontend.
 * The frontend POSTs the Google id_token (from Sign In With Google) here
 * after a successful login. We verify the token via Google's tokeninfo
 * endpoint (no JWKS parsing needed) and only return secrets to verified
 * @aplazo.mx accounts.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY  — returned to the client (used by the agent loop)
 *   BACKEND_TOKEN      — returned to the client (used to call the 7 tools)
 *   GOOGLE_CLIENT_ID   — expected `aud` claim
 *   ALLOWED_DOMAIN     — expected `hd` claim (default 'aplazo.mx')
 *   MODEL              — optional, default 'claude-sonnet-4-20250514'
 *   MAX_ITERATIONS     — optional, default 12
 */
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

exports.handler = async (event) => {
  const headers = event?.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  const [scheme, idToken] = auth.split(' ');
  if (scheme !== 'Bearer' || !idToken) {
    return error(401, 'missing_id_token', 'Authorization: Bearer <google_id_token> required');
  }

  const allowedDomain = process.env.ALLOWED_DOMAIN || 'aplazo.mx';
  const expectedAud = process.env.GOOGLE_CLIENT_ID;
  if (!expectedAud) return error(500, 'misconfigured', 'GOOGLE_CLIENT_ID env var not set');

  let claims;
  try {
    const r = await fetch(`${TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`);
    if (!r.ok) {
      const body = await r.text();
      return error(401, 'invalid_token', `tokeninfo returned ${r.status}: ${body.slice(0, 200)}`);
    }
    claims = await r.json();
  } catch (e) {
    return error(502, 'tokeninfo_unreachable', e.message);
  }

  if (claims.aud !== expectedAud) {
    return error(401, 'aud_mismatch', `Token issued for a different client`);
  }
  if (claims.email_verified !== 'true' && claims.email_verified !== true) {
    return error(401, 'email_not_verified', 'Google email is not verified');
  }
  if (claims.hd !== allowedDomain) {
    return error(403, 'domain_not_allowed', `Access restricted to @${allowedDomain} accounts (got hd=${claims.hd || 'none'})`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(claims.exp) <= now) {
    return error(401, 'token_expired', 'Google id_token has expired');
  }

  return ok({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    backendToken:    process.env.BACKEND_TOKEN || '',
    model:           process.env.MODEL || 'claude-sonnet-4-20250514',
    maxIterations:   Number(process.env.MAX_ITERATIONS || 12),
    user: {
      email: claims.email,
      name:  claims.name,
      sub:   claims.sub,
    },
  });
};
