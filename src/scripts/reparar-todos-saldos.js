/**
 * Repara saldos y cuotas de TODOS los préstamos activos según pagos reales en nube.
 * Uso: node src/scripts/reparar-todos-saldos.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getConnection, query } = require('../config/db');
const { aplicarMontoACuotas } = require('../utils/registrarPagoNube');

async function repararPrestamo(conn, prestamoId, dryRun) {
  const [prestamo] = await conn.execute(
    `SELECT p.*, c.nombre_completo, c.cedula FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id WHERE p.id = ? LIMIT 1`,
    [prestamoId]
  );
  if (!prestamo.length) return null;
  const p = prestamo[0];

  const [pagosRows] = await conn.execute(
    `SELECT id, monto_pagado FROM Pagos WHERE prestamo_id = ? AND deleted_at IS NULL ORDER BY fecha_pago`,
    [prestamoId]
  );

  if (dryRun) {
    const [cuotasSum] = await conn.execute(
      `SELECT COALESCE(SUM(monto_pagado), 0) AS pagado FROM Cuotas_Calendario
       WHERE prestamo_id = ? AND deleted_at IS NULL`,
      [prestamoId]
    );
    const sumPagos = pagosRows.reduce((s, pg) => s + Number(pg.monto_pagado), 0);
    const saldoEsp = Math.max(0, Number((Number(p.monto_total_pagar) - sumPagos).toFixed(2)));
    return {
      cliente: p.nombre_completo,
      saldo_antes: Number(p.saldo_pendiente),
      saldo_esperado_pagos: saldoEsp,
      cuotas_pagado: Number(cuotasSum[0].pagado),
      pagos_sum: sumPagos,
    };
  }

  await conn.execute(
    `UPDATE Cuotas_Calendario SET monto_pagado = 0, estado = 'Programada', updated_at = NOW()
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );

  for (const pg of pagosRows) {
    await aplicarMontoACuotas(conn, prestamoId, Number(pg.monto_pagado));
  }

  const [cuotasSum2] = await conn.execute(
    `SELECT COALESCE(SUM(monto_pagado), 0) AS pagado FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const sumPagos = pagosRows.reduce((s, pg) => s + Number(pg.monto_pagado), 0);
  const nuevoSaldo = Math.max(
    0,
    Number((Number(p.monto_total_pagar) - Number(cuotasSum2[0].pagado)).toFixed(2))
  );
  const estado = nuevoSaldo <= 0.01 ? 'Pagado' : 'Activo';

  await conn.execute(
    `UPDATE Prestamos SET saldo_pendiente = ?, estado = ?, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
    [nuevoSaldo, estado, prestamoId]
  );

  return {
    cliente: p.nombre_completo,
    saldo_antes: Number(p.saldo_pendiente),
    saldo_despues: nuevoSaldo,
    pagos_reales: sumPagos,
    estado,
  };
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const activos = await query(
    `SELECT p.id FROM Prestamos p WHERE p.estado IN ('Activo','Pagado') AND p.deleted_at IS NULL`
  );

  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const resultados = [];
    for (const row of activos) {
      const r = await repararPrestamo(conn, row.id, dryRun);
      if (r) resultados.push(r);
    }
    if (dryRun) {
      await conn.rollback();
      console.log('DRY RUN — sin cambios:\n');
    } else {
      await conn.commit();
      console.log('Reparación completada:\n');
    }
    const cambios = resultados.filter(
      (r) => Math.abs((r.saldo_despues ?? r.saldo_esperado_pagos) - r.saldo_antes) > 0.01
    );
    console.table(resultados);
    console.log('Préstamos con cambio de saldo:', cambios.length);
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
