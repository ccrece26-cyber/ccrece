/**
 * Revierte las cuotas de "vencidos" movidas al aplicar feriado 2026-07-20
 * (script reaplicar-feriado-vencidos): volvían a adelantar la más antigua a 2026-07-21.
 *
 * Criterio (seguro):
 * - fecha_programada = destino (21)
 * - updated_at el día del backfill (2026-07-22)
 * - préstamo cobra el día del feriado (lunes)
 * - hay otra cuota pendiente con fecha < destino (inconsistencia de orden)
 *
 * Restaura la fecha al día de cobro habitual inmediatamente anterior a min(otras pendientes).
 *
 * Uso:
 *   node src/scripts/revertir-movidas-vencidos-feriado.js            # dry-run
 *   CONFIRM=yes node src/scripts/revertir-movidas-vencidos-feriado.js # aplica
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { getConnection, pool } = require('../config/db');
const { incluyeDiaEnFecha } = require('../utils/diasCobro');
const { fechaISO, addDaysISO } = require('../utils/feriados');

const FERIADO = process.argv[2] || '2026-07-20';
const DESTINO = process.argv[3] || '2026-07-21';
const BACKFILL_DAY = process.argv[4] || '2026-07-22';
const APPLY = process.env.CONFIRM === 'yes';

function toISODate(v) {
  return fechaISO(v);
}

function previousCobroDay(beforeISO, dias, periodicidad) {
  let f = addDaysISO(beforeISO, -1);
  for (let i = 0; i < 60; i += 1) {
    if (incluyeDiaEnFecha(f, dias, periodicidad)) return f;
    f = addDaysISO(f, -1);
  }
  return null;
}

(async () => {
  const conn = await getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT c.id AS cliente, c.nombre_completo, p.id AS prestamo_id,
              p.dias_de_cobro, p.periodicidad,
              cc.id AS cuota_id, cc.fecha_programada, cc.estado, cc.updated_at
       FROM Cuotas_Calendario cc
       JOIN Prestamos p ON p.id = cc.prestamo_id AND p.deleted_at IS NULL AND LOWER(p.estado) = 'activo'
       JOIN Clientes c ON c.id = p.cliente_id AND c.deleted_at IS NULL
       WHERE cc.deleted_at IS NULL
         AND cc.estado IN ('Programada', 'Parcial')
         AND cc.fecha_programada = ?
         AND DATE(cc.updated_at) = ?`,
      [DESTINO, BACKFILL_DAY]
    );

    const plan = [];
    for (const r of rows || []) {
      if (!incluyeDiaEnFecha(FERIADO, r.dias_de_cobro, r.periodicidad)) continue;

      const [otras] = await conn.execute(
        `SELECT fecha_programada FROM Cuotas_Calendario
         WHERE prestamo_id = ? AND deleted_at IS NULL
           AND estado IN ('Programada', 'Parcial') AND id <> ?
         ORDER BY fecha_programada ASC`,
        [r.prestamo_id, r.cuota_id]
      );
      const fechasOtras = (otras || []).map((x) => toISODate(x.fecha_programada)).filter(Boolean);
      const minOtra = fechasOtras.find((f) => f < DESTINO) || null;
      // Ancla: si hay pendientes anteriores, día de cobro justo antes de la más antigua;
      // si no, día de cobro justo antes del feriado (no el feriado ni el 21).
      const ancla = minOtra || FERIADO;
      let restaurar = previousCobroDay(ancla, r.dias_de_cobro, r.periodicidad);
      if (!restaurar) continue;
      let guard = 0;
      while (
        (fechasOtras.includes(restaurar) || restaurar === DESTINO || restaurar === FERIADO) &&
        guard < 40
      ) {
        restaurar = previousCobroDay(restaurar, r.dias_de_cobro, r.periodicidad);
        guard += 1;
        if (!restaurar) break;
      }
      if (!restaurar) continue;
      plan.push({
        cliente: r.cliente,
        cuota_id: r.cuota_id,
        de: DESTINO,
        a: restaurar,
        min_otra: minOtra,
        dias: r.dias_de_cobro,
        estado: r.estado,
      });
    }

    console.log(
      JSON.stringify(
        {
          modo: APPLY ? 'APPLY' : 'DRY-RUN',
          feriado: FERIADO,
          destino: DESTINO,
          backfill_day: BACKFILL_DAY,
          candidatas: plan.length,
          sample: plan.slice(0, 10),
        },
        null,
        2
      )
    );

    if (!APPLY) {
      console.log('Sin cambios. Para aplicar: CONFIRM=yes node src/scripts/revertir-movidas-vencidos-feriado.js');
      return;
    }

    await conn.beginTransaction();
    for (const item of plan) {
      await conn.execute(
        `UPDATE Cuotas_Calendario
         SET fecha_programada = ?, updated_at = NOW(), is_synced = 1
         WHERE id = ?`,
        [item.a, item.cuota_id]
      );
    }
    await conn.commit();
    console.log(`Revertidas ${plan.length} cuotas.`);

    // CC-142 check
    const [cc142] = await conn.execute(
      `SELECT cc.fecha_programada, cc.estado
       FROM Clientes c
       JOIN Prestamos p ON p.cliente_id = c.id AND LOWER(p.estado)='activo'
       JOIN Cuotas_Calendario cc ON cc.prestamo_id = p.id AND cc.deleted_at IS NULL
       WHERE c.id = 'CC-142' AND cc.estado IN ('Programada','Parcial')
       ORDER BY cc.fecha_programada LIMIT 6`
    );
    console.log('CC-142 pendientes:', cc142);
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {
      /* ignore */
    }
    throw e;
  } finally {
    conn.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
