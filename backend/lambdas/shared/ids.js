const { randomInt } = require('crypto');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomId(length = 8) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/** Compact UTC timestamp YYYYMMDDHHmmss — used in generated commerce names. */
function compactTimestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function sandboxId() {
  return `sb${randomId(8)}`;
}

function sessionId() {
  return `sess_${randomId(7)}`;
}

function syntheticUserId() {
  return `synthetic_${randomId(7)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function expiresAt(daysFromNow) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString();
}

function unixExpiry(daysFromNow) {
  return Math.floor(Date.now() / 1000) + daysFromNow * 86400;
}

module.exports = { randomId, sandboxId, sessionId, syntheticUserId, isoNow, expiresAt, unixExpiry, compactTimestamp };
