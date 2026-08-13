const { query } = require('../config/db');

const CLAVE_GLOBAL = 'CARTERA_DEMO_VERSION';
const claveCobrador = (cobradorId) => `CARTERA_VERSION_${cobradorId}`;

async function runQuery(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

async function setParametro(conn, clave, valor, descripcion) {
  const ex = await runQuery(conn, `SELECT id FROM Parametros_Globales WHERE clave = ? LIMIT 1`, [
    clave,
  ]);
  if (ex?.length) {
    await runQuery(
      conn,
      `UPDATE Parametros_Globales SET valor = ?, updated_at = NOW() WHERE clave = ?`,
      [valor, clave]
    );
  } else {
    const id = `PG-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await runQuery(
      conn,
      `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
       VALUES (?, ?, ?, ?, 1)`,
      [id, clave, valor, descripcion]
    );
  }
}

async function listCobradorIds(conn) {
  const rows = await runQuery(
    conn,
    `SELECT DISTINCT cobrador_id AS id FROM Rutas
     WHERE cobrador_id IS NOT NULL AND deleted_at IS NULL AND activa = 1
     UNION
     SELECT DISTINCT cobrador_id AS id FROM Clientes
     WHERE cobrador_id IS NOT NULL AND deleted_at IS NULL`
  );
  return [...new Set((rows || []).map((r) => r.id).filter(Boolean))];
}

/**
 * Incrementa versión de cartera.
 * - Con cobradorId(s): solo esos cobradores verán cambio (recomendado).
 * - Sin ids: bump global + todos los cobradores con ruta/clientes.
 *
 * Uso:
 *   bumpCarteraVersion()
 *   bumpCarteraVersion(conn)
 *   bumpCarteraVersion(conn, 'COB-xxx')
 *   bumpCarteraVersion(conn, ['COB-a', 'COB-b'])
 */
async function bumpCarteraVersion(conn = null, cobradorIds = null) {
  const version = new Date().toISOString();
  let ids = cobradorIds;
  if (ids != null && !Array.isArray(ids)) ids = [ids];
  ids = (ids || []).map((x) => String(x || '').trim()).filter(Boolean);

  if (!ids.length) {
    await setParametro(
      conn,
      CLAVE_GLOBAL,
      version,
      'Versión global cartera (fallback sync app)'
    );
    ids = await listCobradorIds(conn);
  }

  for (const id of ids) {
    await setParametro(
      conn,
      claveCobrador(id),
      version,
      `Versión cartera cobrador ${id}`
    );
  }

  return { version, cobradorIds: ids };
}

/** Lee versión efectiva para un cobrador (propia o global). */
async function leerCarteraVersionCobrador(cobradorId, conn = null) {
  const propia = await runQuery(
    conn,
    `SELECT valor FROM Parametros_Globales WHERE clave = ? LIMIT 1`,
    [claveCobrador(cobradorId)]
  );
  if (propia?.[0]?.valor) return String(propia[0].valor);
  const global = await runQuery(
    conn,
    `SELECT valor FROM Parametros_Globales WHERE clave = ? LIMIT 1`,
    [CLAVE_GLOBAL]
  );
  return String(global?.[0]?.valor || '0');
}

module.exports = {
  bumpCarteraVersion,
  leerCarteraVersionCobrador,
  CLAVE_GLOBAL,
  claveCobrador,
};
