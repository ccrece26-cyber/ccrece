const { query } = require('../config/db');
const { optimizarOrdenVisita } = require('./rutaOptima');

/** Centro de Estelí, Nicaragua — punto de partida cobrador */
const ESTELI_CENTRO = { lat: 13.0914, lng: -86.3534 };

async function runSql(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

async function obtenerRutaIdOperador(operadorId, conn = null) {
  const rows = await runSql(
    conn,
    `SELECT id FROM Rutas WHERE cobrador_id = ? AND activa = 1 AND deleted_at IS NULL LIMIT 1`,
    [operadorId]
  );
  return rows[0]?.id || null;
}

async function ensureRutaForOperador(
  operadorId,
  nombreOperador,
  descripcion = 'Ruta diaria automatica — Esteli',
  conn = null
) {
  const existente = await obtenerRutaIdOperador(operadorId, conn);
  if (existente) return existente;

  const rutaId = `RUTA-${operadorId}`;
  await runSql(
    conn,
    `INSERT INTO Rutas (id, nombre, descripcion, cobrador_id, activa, is_synced)
     VALUES (?, ?, ?, ?, 1, 1)
     ON DUPLICATE KEY UPDATE cobrador_id = VALUES(cobrador_id), activa = 1, updated_at = NOW()`,
    [rutaId, `Ruta ${nombreOperador || operadorId}`, descripcion, operadorId]
  );
  return rutaId;
}

async function ensureRutaForCobrador(cobradorId, nombreCobrador, conn = null) {
  return ensureRutaForOperador(cobradorId, nombreCobrador, 'Ruta diaria automatica — Esteli', conn);
}

async function quitarClienteDeRutaOperador(operadorId, clienteId, conn = null) {
  const rutaId = await obtenerRutaIdOperador(operadorId, conn);
  if (!rutaId) return false;
  await runSql(conn, `DELETE FROM Ruta_Clientes WHERE ruta_id = ? AND cliente_id = ?`, [rutaId, clienteId]);
  return true;
}

async function listarIdsClientesEnRuta(operadorId, conn = null) {
  const rutaId = await obtenerRutaIdOperador(operadorId, conn);
  if (!rutaId) return [];
  const rows = await runSql(
    conn,
    `SELECT cliente_id FROM Ruta_Clientes WHERE ruta_id = ? ORDER BY orden_visita`,
    [rutaId]
  );
  return rows.map((r) => r.cliente_id);
}

async function quitarClienteDeOtrasRutas(clienteId, rutaIdDestino, conn = null) {
  await runSql(
    conn,
    `DELETE FROM Ruta_Clientes WHERE cliente_id = ? AND ruta_id != ?`,
    [clienteId, rutaIdDestino]
  );
}

/** Un cliente solo puede estar en la ruta de su cobrador asignado. */
async function sincronizarRutaClienteAsignado(clienteId, cobradorId, nombreCobrador = null, conn = null) {
  if (!cobradorId) {
    await runSql(conn, `DELETE FROM Ruta_Clientes WHERE cliente_id = ?`, [clienteId]);
    return null;
  }
  const rutaId = await ensureRutaForCobrador(cobradorId, nombreCobrador, conn);
  await quitarClienteDeOtrasRutas(clienteId, rutaId, conn);
  await agregarClienteARuta(rutaId, clienteId, conn);
  return rutaId;
}

async function agregarClienteARuta(rutaId, clienteId, conn = null) {
  const maxRows = await runSql(
    conn,
    `SELECT COALESCE(MAX(orden_visita), 0) AS m FROM Ruta_Clientes WHERE ruta_id = ?`,
    [rutaId]
  );
  const orden = (maxRows[0]?.m || 0) + 1;
  await runSql(
    conn,
    `INSERT INTO Ruta_Clientes (ruta_id, cliente_id, orden_visita)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ruta_id = VALUES(ruta_id)`,
    [rutaId, clienteId, orden]
  );
}

async function optimizarOrdenRuta(rutaId, startLat = ESTELI_CENTRO.lat, startLng = ESTELI_CENTRO.lng, conn = null) {
  const clientes = await runSql(
    conn,
    `SELECT c.id, c.latitud, c.longitud
     FROM Clientes c
     JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
     WHERE rc.ruta_id = ? AND c.deleted_at IS NULL`,
    [rutaId]
  );
  if (!clientes.length) return;

  const ordenados = optimizarOrdenVisita(clientes, startLat, startLng);
  if (!ordenados.length) return;

  const cases = ordenados.map((c, i) => `WHEN '${c.id.replace(/'/g, "''")}' THEN ${i + 1}`).join(' ');
  const ids = ordenados.map((c) => `'${c.id.replace(/'/g, "''")}'`).join(',');
  await runSql(
    conn,
    `UPDATE Ruta_Clientes SET orden_visita = CASE cliente_id ${cases} END
     WHERE ruta_id = ? AND cliente_id IN (${ids})`,
    [rutaId]
  );
}

async function sincronizarRutasCobradores() {
  const operadores = await query(
    `SELECT u.id, u.nombre_completo, r.nombre AS rol FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id
     WHERE r.nombre IN ('COBRADOR', 'ADMIN') AND u.activo = 1 AND u.deleted_at IS NULL`
  );
  let creadas = 0;
  for (const c of operadores) {
    const antes = await query(
      `SELECT id FROM Rutas WHERE cobrador_id = ? AND activa = 1 LIMIT 1`,
      [c.id]
    );
    if (!antes.length) {
      const desc =
        c.rol === 'ADMIN' ? 'Ruta campo administrador — Esteli' : 'Ruta diaria automatica — Esteli';
      await ensureRutaForOperador(c.id, c.nombre_completo, desc);
      creadas++;
    }
  }
  return { total: operadores.length, creadas };
}

async function vincularClientesCobradorARuta(cobradorId) {
  const rutaId = await ensureRutaForCobrador(cobradorId);
  const clientes = await query(
    `SELECT id FROM Clientes WHERE cobrador_id = ? AND deleted_at IS NULL`,
    [cobradorId]
  );
  for (const cl of clientes) {
    await sincronizarRutaClienteAsignado(cl.id, cobradorId, null, null);
  }
  await optimizarOrdenRuta(rutaId);
  return rutaId;
}

/** Elimina clientes en rutas que no coinciden con su cobrador_id asignado. */
async function repararRutasClientesDuplicadas(conn = null) {
  const sql = `DELETE rc FROM Ruta_Clientes rc
     INNER JOIN Rutas r ON rc.ruta_id = r.id
     INNER JOIN Clientes c ON rc.cliente_id = c.id
     WHERE c.deleted_at IS NULL
       AND c.cobrador_id IS NOT NULL
       AND r.cobrador_id IS NOT NULL
       AND c.cobrador_id != r.cobrador_id`;
  if (conn) {
    const [result] = await conn.execute(sql);
    return result.affectedRows || 0;
  }
  const { pool } = require('../config/db');
  const [result] = await pool.execute(sql);
  return result.affectedRows || 0;
}

module.exports = {
  ESTELI_CENTRO,
  ensureRutaForOperador,
  ensureRutaForCobrador,
  obtenerRutaIdOperador,
  quitarClienteDeRutaOperador,
  listarIdsClientesEnRuta,
  quitarClienteDeOtrasRutas,
  sincronizarRutaClienteAsignado,
  agregarClienteARuta,
  optimizarOrdenRuta,
  sincronizarRutasCobradores,
  vincularClientesCobradorARuta,
  repararRutasClientesDuplicadas,
};
