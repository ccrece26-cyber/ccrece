/**
 * Repara descuadres saldo/total vs calendario en TiDB producción.
 * Uso: node src/scripts/reparar-descuadres-produccion.js [--dry-run] [--env=.env.nuevo]
 */
const path = require('path');
const envFile = process.argv.find((a) => a.startsWith('--env='))?.split('=')[1] || '.env.nuevo';
require('dotenv').config({ path: path.join(__dirname, '../../', envFile) });
const { getConnection, query } = require('../config/db');
const { recalcularSaldoPrestamoDesdeCuotas } = require('../utils/registrarPagoNube');

const TOLERANCIA = 1.5;
const dryRun = process.argv.includes('--dry-run');

async function anularPagosDuplicadosDia(conn) {
  const dupes = await query(
    `SELECT p.id AS prestamo_id, c.nombre_completo, DATE(pg.fecha_pago) AS dia,
            GROUP_CONCAT(pg.id ORDER BY pg.fecha_pago SEPARATOR ',') AS pago_ids
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE pg.deleted_at IS NULL AND p.deleted_at IS NULL
     GROUP BY p.id, c.nombre_completo, DATE(pg.fecha_pago)
     HAVING COUNT(*) > 1`
  );

  const anulados = [];
  for (const d of dupes) {
    const ids = String(d.pago_ids || '').split(',').filter(Boolean);
    for (let i = 1; i < ids.length; i += 1) {
      if (!dryRun) {
        await conn.execute(
          `UPDATE Pagos SET deleted_at = NOW(), updated_at = NOW(), is_synced = 1 WHERE id = ?`,
          [ids[i]]
        );
      }
      anulados.push({ cliente: d.nombre_completo, conservado: ids[0], anulado: ids[i] });
    }
  }
  return anulados;
}

async function repararPrestamoRapido(conn, prestamoId) {
  const [row] = await conn.execute(
    `SELECT p.id, p.saldo_pendiente, p.monto_total_pagar, c.nombre_completo,
            (SELECT COALESCE(SUM(monto_programado), 0) FROM Cuotas_Calendario
             WHERE prestamo_id = p.id AND deleted_at IS NULL) AS total_cuotas,
            (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos
             WHERE prestamo_id = p.id AND deleted_at IS NULL) AS total_pagos
     FROM Prestamos p
     JOIN Clientes c ON c.id = p.cliente_id
     WHERE p.id = ? AND p.deleted_at IS NULL LIMIT 1`,
    [prestamoId]
  );
  if (!row.length) return null;
  const r = row[0];
  const saldoAntes = Number(r.saldo_pendiente || 0);
  const totalAntes = Number(r.monto_total_pagar || 0);
  const totalCuotas = Number(r.total_cuotas || 0);
  const saldoCuotas = Math.max(0, Number((totalCuotas - Number(r.total_pagos || 0)).toFixed(2)));
  const diffTotal = Number((totalAntes - totalCuotas).toFixed(2));
  const diffSaldo = Number((saldoAntes - saldoCuotas).toFixed(2));
  if (Math.abs(diffTotal) <= 0.02 && Math.abs(diffSaldo) <= TOLERANCIA) return null;

  if (!dryRun) {
    if (Math.abs(diffTotal) > 0.02) {
      await conn.execute(
        `UPDATE Prestamos SET monto_total_pagar = ?, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
        [totalCuotas, prestamoId]
      );
    }
    await recalcularSaldoPrestamoDesdeCuotas(conn, prestamoId);
  }

  const [after] = dryRun
    ? [{ saldo_pendiente: saldoCuotas, monto_total_pagar: totalCuotas }]
    : await conn.execute(
        `SELECT saldo_pendiente, monto_total_pagar FROM Prestamos WHERE id = ?`,
        [prestamoId]
      );

  return {
    cliente: r.nombre_completo,
    saldo_antes: saldoAntes,
    saldo_despues: Number(after[0]?.saldo_pendiente ?? saldoCuotas),
    total_antes: totalAntes,
    total_despues: Number(after[0]?.monto_total_pagar ?? totalCuotas),
  };
}

(async () => {
  console.log(`\nReparación producción (${envFile})${dryRun ? ' [DRY RUN]' : ''}\n`);
  const candidatos = await query(
    `SELECT p.id FROM Prestamos p
     WHERE p.deleted_at IS NULL AND p.estado = 'Activo'
       AND (
         ABS(p.monto_total_pagar - (SELECT COALESCE(SUM(monto_programado),0) FROM Cuotas_Calendario cc
              WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL)) > 0.02
         OR ABS(p.saldo_pendiente - (
              SELECT COALESCE(SUM(GREATEST(0, cc.monto_programado - COALESCE(cc.monto_pagado,0))),0)
              FROM Cuotas_Calendario cc WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL
            )) > ${TOLERANCIA}
       )`
  );

  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const anulados = await anularPagosDuplicadosDia(conn);
    const reparados = [];
    for (const c of candidatos) {
      const r = await repararPrestamoRapido(conn, c.id);
      if (r) reparados.push(r);
    }
    for (const d of anulados) {
      const [p] = await conn.execute(
        `SELECT prestamo_id FROM Pagos WHERE id = ? LIMIT 1`,
        [d.conservado]
      );
      if (p[0]?.prestamo_id) {
        const r = await repararPrestamoRapido(conn, p[0].prestamo_id);
        if (r) reparados.push(r);
      }
    }

    if (dryRun) {
      await conn.rollback();
      console.log('Sin cambios (dry run).\n');
    } else {
      await conn.commit();
      console.log('Cambios aplicados.\n');
    }

    console.log('Pagos duplicados anulados:', anulados.length);
    console.log('Préstamos reparados:', reparados.length);
    for (const r of reparados) {
      console.log(
        `  ${r.cliente}: saldo C$ ${r.saldo_antes.toFixed(2)} → C$ ${r.saldo_despues.toFixed(2)}` +
          (Math.abs(r.total_antes - r.total_despues) > 0.02
            ? ` | total C$ ${r.total_antes.toFixed(2)} → C$ ${r.total_despues.toFixed(2)}`
            : '')
      );
    }
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
