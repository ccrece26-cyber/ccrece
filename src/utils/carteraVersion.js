const { query } = require('../config/db');

/** Incrementa versión global para que las apps redescarguen ruta (asignaciones, cuotas, etc.). */
async function bumpCarteraVersion(conn = null) {
  const version = new Date().toISOString();
  const run = async (q, sql, params) => {
    if (q) {
      const [rows] = await q.execute(sql, params);
      return rows;
    }
    return query(sql, params);
  };
  const q = conn || null;
  const ex = await run(q, `SELECT id FROM Parametros_Globales WHERE clave = 'CARTERA_DEMO_VERSION' LIMIT 1`);
  if (ex?.length || ex?.[0]) {
    await run(
      q,
      `UPDATE Parametros_Globales SET valor = ?, updated_at = NOW() WHERE clave = 'CARTERA_DEMO_VERSION'`,
      [version]
    );
  } else {
    const id = `PG-${Date.now()}`;
    await run(
      q,
      `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
       VALUES (?, 'CARTERA_DEMO_VERSION', ?, 'Versión cartera para sync app', 1)`,
      [id, version]
    );
  }
  return version;
}

module.exports = { bumpCarteraVersion };
