const crypto = require('crypto');

function secret() {
  return process.env.LICENSE_SECRET || process.env.JWT_SECRET || 'credi-crece-licencia-dev';
}

function firmarToken(deviceId) {
  const ts = Date.now();
  const payload = `${deviceId}.${ts}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verificarToken(deviceId, token) {
  if (!deviceId || !token) return false;
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parts = raw.split('.');
    if (parts.length !== 3) return false;
    const [id, ts, sig] = parts;
    if (id !== deviceId) return false;
    const esperado = crypto.createHmac('sha256', secret()).update(`${id}.${ts}`).digest('hex');
    if (sig.length !== esperado.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado));
  } catch {
    return false;
  }
}

module.exports = { firmarToken, verificarToken };
