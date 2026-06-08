const { exigirUsuarioActivo, extraerOperadorId, responderErrorUsuario } = require('../utils/assertUsuarioActivo');

const METODOS_LECTURA = new Set(['GET', 'HEAD', 'OPTIONS']);

function rutaSolicitud(req) {
  const raw = req.originalUrl || req.url || req.path || '';
  return String(raw).split('?')[0];
}

function esRutaPublica(req) {
  const p = rutaSolicitud(req);
  if (p === '/' || p === '/api' || p === '/api/') return true;
  if (p === '/api/health' || p === '/api/status') return true;
  if (p.startsWith('/api/auth/')) return true;
  if (p.startsWith('/api/licencia/')) return true;
  // Montado en /api: req.path suele ser /auth/login, /licencia/..., etc.
  if (p === '/health' || p === '/status') return true;
  if (p.startsWith('/auth/')) return true;
  if (p.startsWith('/licencia/')) return true;
  return false;
}

/**
 * Bloquea escrituras en TiDB si el operador (header o body) está inactivo.
 */
async function guardEscrituraActiva(req, res, next) {
  if (esRutaPublica(req)) return next();
  if (METODOS_LECTURA.has(req.method)) return next();

  const operadorId = extraerOperadorId(req);
  if (!operadorId) {
    return res.status(401).json({
      success: false,
      message: 'Identificación de usuario requerida (X-Operador-Id).',
    });
  }

  try {
    await exigirUsuarioActivo(operadorId);
    req.operadorId = operadorId;
    return next();
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

module.exports = { guardEscrituraActiva };
