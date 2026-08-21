/**
 * Adjunta datos de Renovaciones_Log a filas de Prestamos (para documento / efectivo en mano).
 */
async function enriquecerPrestamosConRenovacion(connOrQuery, prestamos) {
  const list = Array.isArray(prestamos) ? prestamos.filter((p) => p?.id) : [];
  if (!list.length) return list;

  const run = async (sql, params) => {
    if (typeof connOrQuery === 'function') {
      return connOrQuery(sql, params);
    }
    if (connOrQuery && typeof connOrQuery.execute === 'function') {
      const [rows] = await connOrQuery.execute(sql, params);
      return rows;
    }
    const { query } = require('../config/db');
    return query(sql, params);
  };

  const ids = list.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const logs = await run(
    `SELECT id AS renovacion_log_id, prestamo_nuevo_id, prestamo_anterior_id,
            saldo_pendiente_anterior, nuevo_desembolso, base_nominal, efectivo_entregar,
            cobrador_opero_id, cobrador_entrega_id, plazo_semanas AS plazo_renovacion
     FROM Renovaciones_Log
     WHERE prestamo_nuevo_id IN (${ph})`,
    ids
  );
  const byNuevo = new Map((logs || []).map((r) => [r.prestamo_nuevo_id, r]));

  return list.map((p) => {
    const r = byNuevo.get(p.id);
    if (!r) return p;
    return {
      ...p,
      renovacion_log_id: r.renovacion_log_id,
      saldo_pendiente_anterior: r.saldo_pendiente_anterior,
      nuevo_desembolso: r.nuevo_desembolso,
      base_nominal: r.base_nominal,
      efectivo_entregar: r.efectivo_entregar,
    };
  });
}

module.exports = { enriquecerPrestamosConRenovacion };
