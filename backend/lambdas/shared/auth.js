function checkBearer(event) {
  const expected = process.env.BACKEND_TOKEN;
  if (!expected) {
    // Fail CLOSED: a missing/typo'd BACKEND_TOKEN must not silently make
    // infra-creating endpoints public. (Previously returned { ok: true }.)
    console.error('BACKEND_TOKEN not configured — refusing request (fail closed)');
    return { ok: false, reason: 'server_misconfigured' };
  }

  const header =
    event?.headers?.authorization ||
    event?.headers?.Authorization ||
    '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || token !== expected) {
    return { ok: false, reason: 'invalid_or_missing_bearer_token' };
  }
  return { ok: true };
}

module.exports = { checkBearer };
