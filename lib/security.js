'use strict';
/**
 * lib/security.js — small crypto helpers.
 *  - OTP codes are low-entropy (6 digits), so we store an HMAC keyed by a
 *    server secret and compare in constant time.
 *  - Session tokens are high-entropy random strings; we store only their
 *    SHA-256 hash, so a leaked database can't be used to impersonate users.
 */
const crypto = require('crypto');

let SECRET = process.env.AUTH_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  // eslint-disable-next-line no-console
  console.warn('[hoy] AUTH_SECRET not set — using a random per-process secret. '
    + 'Codes/sessions will not survive a restart. Set AUTH_SECRET in production.');
}

function hmac(value) {
  return crypto.createHmac('sha256', SECRET).update(String(value)).digest('hex');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}
function sixDigitCode() {
  return String(crypto.randomInt(100000, 1000000));
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { hmac, hashToken, randomToken, sixDigitCode, safeEqual };
