const crypto = require('node:crypto');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TTL_MS = 12 * 60 * 60 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function issueToken(userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return e > Date.now() ? u : null;
}

module.exports = { hashPassword, verifyPassword, issueToken, readToken, TTL_MS };
