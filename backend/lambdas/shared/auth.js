function checkBearer(event) {
  const expected = process.env.BACKEND_TOKEN;
  if (!expected) return { ok: true };

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
