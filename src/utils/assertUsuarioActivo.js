const { query } = require('../config/db');

const MSG_INACTIVO =
  'Cuenta desactivada. No puede modificar datos en la nube. Puede desinstalar la aplicación.';

async function runSql(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

/**
 * Verifica que el usuario exista y activo = 1. Lanza error con code cuenta_inactiva si no.
 */
async function exigirUsuarioActivo(usuarioId, conn = null) {
  if (!usuarioId) {
    const e = new Error('Identificación de usuario requerida.');
    e.status = 401;
    throw e;
  }
  const rows = await runSql(
    conn,
    `SELECT u.id, u.activo, u.nombre_completo, r.nombre AS rol
     FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id
     WHERE u.id = ? AND u.deleted_at IS NULL
     LIMIT 1`,
    [usuarioId]
  );
  if (!rows.length) {
    const e = new Error('Usuario no encontrado.');
    e.status = 403;
    throw e;
  }
  if (!Number(rows[0].activo)) {
    const e = new Error(MSG_INACTIVO);
    e.code = 'cuenta_inactiva';
    e.status = 403;
    throw e;
  }
  return rows[0];
}

function extraerOperadorId(req) {
  const header = req.headers['x-operador-id'];
  if (header) return String(header).trim();

  const b = req.body || {};
  if (b.cobradorId) return b.cobradorId;
  if (b.cobrador_id) return b.cobrador_id;
  if (b.operador_id) return b.operador_id;
  if (b.admin_id) return b.admin_id;

  if (req.params?.cobradorId) return req.params.cobradorId;

  const q = req.query || {};
  if (q.operador_id) return q.operador_id;
  if (q.admin_id) return q.admin_id;
  if (q.cobrador_id) return q.cobrador_id;

  if (Array.isArray(b.gestiones) && b.gestiones[0]?.cobrador_id) return b.gestiones[0].cobrador_id;
  if (Array.isArray(b.pagos) && b.pagos[0]?.cobrador_id) return b.pagos[0].cobrador_id;

  return null;
}

function responderErrorUsuario(res, e) {
  const status = e.status || (e.code === 'cuenta_inactiva' ? 403 : 500);
  return res.status(status).json({
    success: false,
    code: e.code || null,
    message: e.message,
  });
}

module.exports = {
  MSG_INACTIVO,
  exigirUsuarioActivo,
  extraerOperadorId,
  responderErrorUsuario,
};
