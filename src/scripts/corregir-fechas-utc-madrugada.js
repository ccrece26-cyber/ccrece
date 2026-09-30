/**
 * Corrige fechas UTC de madrugada (00:00–05:59) que en realidad son
 * la tarde/noche del día anterior en Nicaragua (legado toISOString).
 * Resta 6 horas solo a esos registros.
 *
 * Uso: node src/scripts/corregir-fechas-utc-madrugada.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query } = require('../config/db');

const dry = process.argv.includes('--dry-run');

(async () => {
  const pred =
    `HOUR(fecha_pago) < 6 AND deleted_at IS NULL`;
  const predG =
    `HOUR(fecha_gestion) < 6 AND (deleted_at IS NULL OR deleted_at = '')`;

  const sampleP = await query(
    `SELECT id, DATE_FORMAT(fecha_pago,'%Y-%m-%d %H:%i:%s') fp, monto_pagado
     FROM Pagos WHERE ${pred}
     ORDER BY fecha_pago DESC LIMIT 15`
  );
  const [cntP] = await query(`SELECT COUNT(*) n FROM Pagos WHERE ${pred}`);
  const sampleG = await query(
    `SELECT id, DATE_FORMAT(fecha_gestion,'%Y-%m-%d %H:%i:%s') fg, motivo
     FROM Gestiones_No_Pago WHERE ${predG}
     ORDER BY fecha_gestion DESC LIMIT 10`
  );
  const [cntG] = await query(`SELECT COUNT(*) n FROM Gestiones_No_Pago WHERE ${predG}`);

  console.log({ dry, pagos_a_corregir: cntP.n, gestiones_a_corregir: cntG.n });
  console.log('sample_pagos', sampleP);
  console.log('sample_gestiones', sampleG);

  if (dry) {
    console.log('Dry-run: sin cambios.');
    process.exit(0);
  }

  const rP = await query(
    `UPDATE Pagos
     SET fecha_pago = DATE_SUB(fecha_pago, INTERVAL 6 HOUR)
     WHERE ${pred}`
  );
  const rG = await query(
    `UPDATE Gestiones_No_Pago
     SET fecha_gestion = DATE_SUB(fecha_gestion, INTERVAL 6 HOUR)
     WHERE ${predG}`
  );

  console.log({
    pagos_updated: rP?.affectedRows ?? rP,
    gestiones_updated: rG?.affectedRows ?? rG,
  });

  // Verificación: CC-106 y CC-10
  const check = await query(
    `SELECT 'pago' t, c.id codigo, DATE_FORMAT(pg.fecha_pago,'%Y-%m-%d %H:%i:%s') f
     FROM Pagos pg JOIN Prestamos p ON p.id=pg.prestamo_id JOIN Clientes c ON c.id=p.cliente_id
     WHERE c.id IN ('CC-106','CC-10') AND pg.deleted_at IS NULL
     ORDER BY pg.fecha_pago DESC LIMIT 4`
  );
  const checkG = await query(
    `SELECT c.id codigo, DATE_FORMAT(g.fecha_gestion,'%Y-%m-%d %H:%i:%s') f
     FROM Gestiones_No_Pago g JOIN Prestamos p ON p.id=g.prestamo_id JOIN Clientes c ON c.id=p.cliente_id
     WHERE c.id='CC-10' ORDER BY g.fecha_gestion DESC LIMIT 2`
  );
  console.log('check_pagos', check);
  console.log('check_sandra', checkG);

  const [hoyBleed] = await query(
    `SELECT COUNT(*) n FROM Pagos
     WHERE deleted_at IS NULL AND fecha_pago >= '2026-09-30 00:00:00' AND fecha_pago < '2026-09-30 06:00:00'`
  );
  console.log({ madrugada_hoy_restante: hoyBleed.n });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
