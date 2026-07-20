const { query, checkDbConfig, testDbConnection } = require('../config/db');

const TABLAS_PULL = [
  'Clientes',
  'Fiadores',
  'Garantias',
  'Prestamos',
  'Prestamo_Garantias',
  'Cuotas_Calendario',
  'Parametros_Globales',
  'Feriados',
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

const { exigirUsuarioActivo, responderErrorUsuario } = require('../utils/assertUsuarioActivo');
const { rangoDiaLocal } = require('../utils/fechasSql');

async function pushGestiones(req, res) {
  const { gestiones } = req.body;
  if (!Array.isArray(gestiones)) {
    return res.status(400).json({ success: false, message: 'gestiones debe ser un arreglo.' });
  }
  if (!gestiones.length) {
    return res.json({ success: true, procesados: 0 });
  }

  try {
    const cobId = req.operadorId || gestiones[0]?.cobrador_id;
    await exigirUsuarioActivo(cobId);
  } catch (e) {
    return responderErrorUsuario(res, e);
  }

  const omitidos = [];
  let procesados = 0;

  for (const g of gestiones) {
    if (!g?.id) continue;
    const [ex] = await query('SELECT id FROM Gestiones_No_Pago WHERE id = ?', [g.id]);
    if (ex?.length) {
      omitidos.push({ id: g.id, code: 'gestion_ya_existe' });
      continue;
    }
    if (g.prestamo_id) {
      const { inicio, fin } = rangoDiaLocal(g.fecha_gestion || new Date());
      const [dup] = await query(
        `SELECT id FROM Gestiones_No_Pago
         WHERE prestamo_id = ? AND deleted_at IS NULL
           AND fecha_gestion >= ? AND fecha_gestion < ?
         LIMIT 1`,
        [g.prestamo_id, inicio, fin]
      );
      if (dup?.length) {
        omitidos.push({ id: g.id, code: 'gestion_ya_registrada', gestion_existente_id: dup[0].id });
        continue;
      }
    }
    await query(
      `INSERT INTO Gestiones_No_Pago (id, prestamo_id, cobrador_id, motivo, fecha_gestion, latitud, longitud, is_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [g.id, g.prestamo_id, g.cobrador_id, g.motivo, g.fecha_gestion, g.latitud, g.longitud]
    );
    procesados += 1;
  }

  const partial = omitidos.length > 0 && procesados > 0;
  return res.json({
    success: omitidos.length === 0,
    partial,
    procesados,
    omitidos: omitidos.length ? omitidos : undefined,
  });
}

async function healthCheck(req, res) {
  const cfg = checkDbConfig();
  const lite = req.query.lite === '1' || req.query.lite === 'true';
  if (!cfg.ok) {
    return res.status(503).json({
      success: false,
      tidb: 'misconfigured',
      missing: cfg.missing,
      hint: 'En Vercel: Settings → Environment Variables. Copie DB_HOST, DB_USER, DB_PASSWORD, DB_NAME y DB_SSL=true desde su .env local.',
      time: new Date().toISOString(),
    });
  }
  if (lite) {
    return res.json({
      success: true,
      tidb: 'skipped',
      lite: true,
      host: cfg.hostPreview,
      ssl: cfg.ssl,
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
