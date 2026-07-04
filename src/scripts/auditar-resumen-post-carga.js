/**
 * Resumen post carga masiva: días de cobro en campo, integridad básica.
 * Uso: node src/scripts/auditar-resumen-post-carga.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');
const { hoyISO } = require('../utils/zonaHoraria');
const { rangoDiaLocal } = require('../utils/fechasSql');

const FECHA_CARGA = '2026-07-01';

(async () => {
  const hoy = hoyISO();
  console.log('\n=== AUDITORÍA POST CARGA MASIVA — TiDB Cloud ===');
  console.log('Hoy (Nicaragua):', hoy);
  console.log('Referencia carga masiva:', FECHA_CARGA);

  const fechas = (
    await query(
      `SELECT
         (SELECT DATE(MIN(created_at)) FROM Clientes WHERE deleted_at IS NULL) AS min_cli,
         (SELECT DATE(MAX(created_at)) FROM Clientes WHERE deleted_at IS NULL) AS max_cli,
         (SELECT COUNT(*) FROM Clientes WHERE deleted_at IS NULL) AS n_cli,
         (SELECT DATE(MIN(fecha_desembolso)) FROM Prestamos WHERE deleted_at IS NULL) AS min_des,
         (SELECT DATE(MIN(fecha_pago)) FROM Pagos WHERE deleted_at IS NULL) AS min_pago,
         (SELECT DATE(MAX(fecha_pago)) FROM Pagos WHERE deleted_at IS NULL) AS max_pago`
    )
  )[0];
  console.log('\nFechas clave:', fechas);

  const prestamos = await query(
    `SELECT estado, COUNT(*) AS n FROM Prestamos WHERE deleted_at IS NULL GROUP BY estado`
  );
  console.log('\nPréstamos por estado:', prestamos);

  const totales = (
    await query(
      `SELECT
         (SELECT COUNT(*) FROM Pagos WHERE deleted_at IS NULL) AS pagos_all,
         (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos WHERE deleted_at IS NULL) AS monto_all,
         (SELECT COUNT(*) FROM Pagos WHERE deleted_at IS NULL AND registrado_por_admin=1) AS pagos_admin,
         (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos WHERE deleted_at IS NULL AND registrado_por_admin=1) AS monto_admin,
         (SELECT COUNT(*) FROM Pagos WHERE deleted_at IS NULL AND COALESCE(registrado_por_admin,0)=0) AS pagos_cob,
         (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos WHERE deleted_at IS NULL AND COALESCE(registrado_por_admin,0)=0) AS monto_cob,
         (SELECT COALESCE(SUM(saldo_pendiente),0) FROM Prestamos WHERE deleted_at IS NULL AND estado='Activo') AS cartera`
    )
  )[0];
  console.log('\nTotales pagos:', totales);

  const porDia = await query(
    `SELECT DATE(fecha_pago) AS dia,
            SUM(CASE WHEN COALESCE(registrado_por_admin,0)=1 THEN 1 ELSE 0 END) AS n_admin,
            SUM(CASE WHEN COALESCE(registrado_por_admin,0)=0 THEN 1 ELSE 0 END) AS n_cobrador,
            COUNT(*) AS n_total,
            ROUND(SUM(monto_pagado),2) AS monto
     FROM Pagos WHERE deleted_at IS NULL
     GROUP BY DATE(fecha_pago) ORDER BY dia`
  );
  console.log('\n=== PAGOS POR DÍA (todos) ===');
  for (const r of porDia) {
    console.log(
      `  ${r.dia} | total ${r.n_total} (admin ${r.n_admin} + cobrador ${r.n_cobrador}) | C$ ${Number(r.monto).toFixed(2)}`
    );
  }

  const { inicio: iniCarga } = rangoDiaLocal(FECHA_CARGA);
  const cobrosCampo = await query(
    `SELECT DATE(fecha_pago) AS dia, COUNT(*) AS n, ROUND(SUM(monto_pagado),2) AS monto
     FROM Pagos
     WHERE deleted_at IS NULL AND COALESCE(registrado_por_admin,0)=0
       AND fecha_pago >= ?
     GROUP BY DATE(fecha_pago) ORDER BY dia`,
    [iniCarga]
  );
  console.log(`\n=== COBROS EN CAMPO (desde ${FECHA_CARGA}, excl. histórico admin) ===`);
  let diasCobro = 0;
  let totalCampo = 0;
  let pagosCampo = 0;
  for (const r of cobrosCampo) {
    if (Number(r.n) > 0) diasCobro += 1;
    pagosCampo += Number(r.n);
    totalCampo += Number(r.monto);
    console.log(`  ${r.dia} | ${r.n} pagos | C$ ${Number(r.monto).toFixed(2)}`);
  }
  console.log(`\nDías con cobros en campo: ${diasCobro}`);
  console.log(`Total cobros campo: ${pagosCampo} pagos | C$ ${totalCampo.toFixed(2)}`);

  const cierres = await query(
    `SELECT DATE(fecha_cierre) AS d, COUNT(*) AS n, ROUND(SUM(monto_efectivo),2) AS monto
     FROM Cierre_Caja WHERE deleted_at IS NULL
     GROUP BY DATE(fecha_cierre) ORDER BY d`
  );
  console.log('\n=== CIERRES DE CAJA ===');
  for (const r of cierres) console.log(`  ${r.d} | ${r.n} cierres | C$ ${Number(r.monto).toFixed(2)}`);

  const dup = (
    await query(
      `SELECT COUNT(*) AS n FROM (
         SELECT prestamo_id, DATE(fecha_pago) AS d, COUNT(*) AS c
         FROM Pagos WHERE deleted_at IS NULL
         GROUP BY prestamo_id, DATE(fecha_pago) HAVING c > 1
       ) t`
    )
  )[0];
  console.log('\nPréstamos con 2+ pagos el mismo día:', dup.n);

  const saldoBad = (
    await query(
      `SELECT COUNT(*) AS n FROM Prestamos p
       WHERE p.deleted_at IS NULL AND p.estado='Activo'
         AND ABS(p.saldo_pendiente - GREATEST(0, p.monto_total_pagar - (
           SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos pg
           WHERE pg.prestamo_id=p.id AND pg.deleted_at IS NULL
         ))) > 1.5`
    )
  )[0];
  console.log('Activos con saldo vs pagos descuadrado (>C$1.50):', saldoBad.n);

  const pagosCuotas = (
    await query(
      `SELECT COUNT(*) AS n FROM (
         SELECT p.id
         FROM Prestamos p
         WHERE p.deleted_at IS NULL
           AND ABS(
             (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos pg WHERE pg.prestamo_id=p.id AND pg.deleted_at IS NULL)
             - (SELECT COALESCE(SUM(monto_pagado),0) FROM Cuotas_Calendario cc WHERE cc.prestamo_id=p.id AND cc.deleted_at IS NULL)
           ) > 1.5
       ) t`
    )
  )[0];
  console.log('Préstamos con pagos ≠ cuotas (diff >C$1.50):', pagosCuotas.n);

  const multiAct = await query(
    `SELECT cliente_id, COUNT(*) AS n FROM Prestamos
     WHERE estado='Activo' AND deleted_at IS NULL GROUP BY cliente_id HAVING n > 1`
  );
  console.log('Clientes con 2+ préstamos activos:', multiAct.length);

  const gestiones = await query(
    `SELECT DATE(fecha_gestion) AS d, COUNT(*) AS n
     FROM Gestiones_No_Pago WHERE deleted_at IS NULL AND fecha_gestion >= ?
     GROUP BY DATE(fecha_gestion) ORDER BY d`,
    [iniCarga]
  );
  console.log('\nGestiones no pago desde carga:', gestiones.length ? gestiones : 'ninguna');

  const cobPorDia = await query(
    `SELECT DATE(pg.fecha_pago) AS dia, u.nombre_completo AS cobrador,
            COUNT(*) AS n, ROUND(SUM(pg.monto_pagado),2) AS monto
     FROM Pagos pg
     LEFT JOIN Usuarios u ON u.id = pg.cobrador_id
     WHERE pg.deleted_at IS NULL AND COALESCE(pg.registrado_por_admin,0)=0
       AND pg.fecha_pago >= ?
     GROUP BY DATE(pg.fecha_pago), u.nombre_completo
     ORDER BY dia, cobrador`,
    [iniCarga]
  );
  console.log('\n=== COBROS POR COBRADOR Y DÍA ===');
  for (const r of cobPorDia) {
    console.log(`  ${r.dia} | ${r.cobrador || '(sin cobrador)'} | ${r.n} | C$ ${Number(r.monto).toFixed(2)}`);
  }

  if (saldoBad.n === 0 && pagosCuotas.n === 0 && multiAct.length === 0) {
    console.log('\n✅ Integridad básica: OK (sin descuadres graves detectados).');
  } else {
    console.log('\n⚠ Hay hallazgos que revisar — ejecutar auditar-integridad-nube.js para detalle.');
  }

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
