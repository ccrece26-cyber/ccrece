require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

(async () => {
  const mismatches = await query(
    `SELECT c.nombre_completo, c.cedula, p.id,
            (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos pg WHERE pg.prestamo_id=p.id AND pg.deleted_at IS NULL) AS sp,
            (SELECT COALESCE(SUM(monto_pagado),0) FROM Cuotas_Calendario cc WHERE cc.prestamo_id=p.id AND cc.deleted_at IS NULL) AS sc
     FROM Prestamos p JOIN Clientes c ON c.id=p.cliente_id
     WHERE p.deleted_at IS NULL
       AND ABS(
         (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos pg WHERE pg.prestamo_id=p.id AND pg.deleted_at IS NULL)
         - (SELECT COALESCE(SUM(monto_pagado),0) FROM Cuotas_Calendario cc WHERE cc.prestamo_id=p.id AND cc.deleted_at IS NULL)
       ) > 1.5`
  );
  console.log('\n=== PAGOS vs CUOTAS (diff > 1.50) ===');
  for (const r of mismatches) {
    console.log(`  ${r.nombre_completo} (${r.cedula}) pagos=${r.sp} cuotas=${r.sc} diff=${Number(r.sp) - Number(r.sc)}`);
  }

  const jul3 = await query(
    `SELECT COALESCE(registrado_por_admin,0) AS admin, COUNT(*) AS n, ROUND(SUM(monto_pagado),2) AS m
     FROM Pagos WHERE deleted_at IS NULL AND DATE(fecha_pago)='2026-07-03'
     GROUP BY COALESCE(registrado_por_admin,0)`
  );
  console.log('\n=== 3 JULIO desglose ===', jul3);

  const cierres = await query(
    `SELECT cc.id, cc.fecha_cierre, cc.monto_efectivo, cc.monto_esperado, u.nombre_completo
     FROM Cierre_Caja cc LEFT JOIN Usuarios u ON u.id=cc.cobrador_id
     WHERE cc.deleted_at IS NULL ORDER BY cc.fecha_cierre`
  );
  console.log('\n=== CIERRES DETALLE ===');
  for (const c of cierres) console.log(c);

  const cobJul2 = (
    await query(
      `SELECT ROUND(SUM(monto_pagado),2) AS m, COUNT(*) AS n
       FROM Pagos WHERE deleted_at IS NULL AND COALESCE(registrado_por_admin,0)=0
         AND DATE(fecha_pago)='2026-07-02'`
    )
  )[0];
  console.log('\nCobros campo 2-jul:', cobJul2);

  const pagados = await query(
    `SELECT c.nombre_completo, c.cedula, p.saldo_pendiente, p.fecha_liquidacion
     FROM Prestamos p JOIN Clientes c ON c.id=p.cliente_id
     WHERE p.estado='Pagado' AND p.deleted_at IS NULL`
  );
  console.log('\n=== PRÉSTAMOS LIQUIDADOS (4) ===');
  for (const p of pagados) console.log(`  ${p.nombre_completo} | saldo ${p.saldo_pendiente} | liq ${p.fecha_liquidacion}`);

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
