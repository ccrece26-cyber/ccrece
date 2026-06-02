const { query, checkDbConfig, testDbConnection } = require('../config/db');

const TABLAS_PULL = [
  'Clientes',
  'Fiadores',
  'Garantias',
  'Prestamos',
  'Prestamo_Garantias',
  'Cuotas_Calendario',
  'Parametros_Globales',
];

async function pullTabla(tabla, since, cobradorId) {
  if (tabla === 'Clientes' && cobradorId) {
    return query(
      `SELECT * FROM Clientes
       WHERE cobrador_id = ? AND updated_at > ? AND deleted_at IS NULL
       ORDER BY updated_at ASC`,
      [cobradorId, since]
    );
  }
  if (tabla === 'Prestamos' && cobradorId) {
    return query(
      `SELECT p.* FROM Prestamos p
       INNER JOIN Clientes c ON p.cliente_id = c.id
       WHERE c.cobrador_id = ? AND p.updated_at > ? AND p.deleted_at IS NULL
       ORDER BY p.updated_at ASC`,
      [cobradorId, since]
    );
  }
  if (tabla === 'Fiadores' && cobradorId) {
    return query(
      `SELECT f.* FROM Fiadores f
       INNER JOIN Clientes c ON f.cliente_id = c.id
       WHERE c.cobrador_id = ? AND f.updated_at > ? AND f.deleted_at IS NULL
       ORDER BY f.updated_at ASC`,
      [cobradorId, since]
    );
  }
  if (tabla === 'Cuotas_Calendario' && cobradorId) {
    return query(
      `SELECT cc.* FROM Cuotas_Calendario cc
       INNER JOIN Prestamos p ON cc.prestamo_id = p.id
       INNER JOIN Clientes c ON p.cliente_id = c.id
       WHERE c.cobrador_id = ? AND cc.updated_at > ? AND cc.deleted_at IS NULL
       ORDER BY cc.updated_at ASC`,
      [cobradorId, since]
    );
  }
  if ((tabla === 'Garantias' || tabla === 'Prestamo_Garantias') && cobradorId) {
    return [];
  }
  return query(
    `SELECT * FROM ${tabla} WHERE updated_at > ? AND deleted_at IS NULL ORDER BY updated_at ASC`,
    [since]
  );
}

/**
 * Pull: descarga cambios remotos desde lastSync (ISO datetime).
 */
async function pullChanges(req, res) {
  try {
    const since = req.query.since || '1970-01-01 00:00:00';
    const cobradorId = req.query.cobrador_id || null;

    const entries = await Promise.all(
      TABLAS_PULL.map(async (tabla) => [tabla, await pullTabla(tabla, since, cobradorId)])
    );
    const payload = Object.fromEntries(entries);

    return res.json({
      success: true,
      serverTime: new Date().toISOString(),
      data: payload,
    });
  } catch (error) {
    console.error('Pull error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function pushGestiones(req, res) {
  const { gestiones } = req.body;
  if (!Array.isArray(gestiones)) {
    return res.status(400).json({ success: false, message: 'gestiones debe ser un arreglo.' });
  }
  if (!gestiones.length) {
    return res.json({ success: true, procesados: 0 });
  }

  const ids = gestiones.map((g) => g.id).filter(Boolean);
  const ph = ids.map(() => '?').join(',');
  const existentes = ids.length
    ? await query(`SELECT id FROM Gestiones_No_Pago WHERE id IN (${ph})`, ids)
    : [];
  const existSet = new Set(existentes.map((r) => r.id));
  const nuevas = gestiones.filter((g) => g.id && !existSet.has(g.id));

  for (const g of nuevas) {
    await query(
      `INSERT INTO Gestiones_No_Pago (id, prestamo_id, cobrador_id, motivo, fecha_gestion, latitud, longitud, is_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [g.id, g.prestamo_id, g.cobrador_id, g.motivo, g.fecha_gestion, g.latitud, g.longitud]
    );
  }

  return res.json({ success: true, procesados: nuevas.length });
}

async function healthCheck(req, res) {
  const cfg = checkDbConfig();
  if (!cfg.ok) {
    return res.status(503).json({
      success: false,
      tidb: 'misconfigured',
      missing: cfg.missing,
      hint: 'En Vercel: Settings → Environment Variables. Copie DB_HOST, DB_USER, DB_PASSWORD, DB_NAME y DB_SSL=true desde su .env local.',
      time: new Date().toISOString(),
    });
  }
  try {
    await testDbConnection();
    return res.json({
      success: true,
      tidb: 'connected',
      host: cfg.hostPreview,
      ssl: cfg.ssl,
      time: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      tidb: 'disconnected',
      message: error.message,
      host: cfg.hostPreview,
      ssl: cfg.ssl,
      hint: cfg.vercel
        ? 'Revise que DB_HOST sea el host de TiDB Cloud (no 127.0.0.1) y DB_SSL=true en Vercel.'
        : undefined,
      time: new Date().toISOString(),
    });
  }
}

module.exports = { pullChanges, pushGestiones, healthCheck };
