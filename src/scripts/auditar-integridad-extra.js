require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');

(async () => {
  const checks = [];

  const [neg] = await query(
    `SELECT COUNT(*) AS n FROM Prestamos WHERE deleted_at IS NULL AND saldo_pendiente < -0.01`
  );
  checks.push({ check: 'Saldos negativos', ok: Number(neg.n) === 0, valor: Number(neg.n) });

  const perdidasMal = await query(
    `SELECT c.nombre_completo, p.saldo_pendiente FROM Prestamos p
     JOIN Clientes c ON c.id = p.cliente_id
     WHERE p.deleted_at IS NULL AND p.estado = 'Perdida' AND p.saldo_pendiente > 0.01`
  );
  checks.push({ check: 'Perdida con saldo > 0', ok: !perdidasMal.length, casos: perdidasMal });

  const pagadosMal = await query(
    `SELECT c.nombre_completo, p.saldo_pendiente FROM Prestamos p
     JOIN Clientes c ON c.id = p.cliente_id
     WHERE p.deleted_at IS NULL AND p.estado = 'Pagado' AND p.saldo_pendiente > 0.01`
  );
  checks.push({ check: 'Pagado con saldo > 0', ok: !pagadosMal.length, casos: pagadosMal });

  const castigosSin = await query(
    `SELECT c.nombre_completo, p.estado FROM Castigos_Perdida cp
     JOIN Prestamos p ON p.id = cp.prestamo_id
     JOIN Clientes c ON c.id = cp.cliente_id
     WHERE cp.deleted_at IS NULL AND p.estado <> 'Perdida'`
  );
  checks.push({ check: 'Castigo sin estado Perdida', ok: !castigosSin.length, casos: castigosSin });

  const [castigos] = await query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(monto_perdida), 0) AS total
     FROM Castigos_Perdida WHERE deleted_at IS NULL`
  );
  checks.push({
    check: 'Castigos a pérdida',
    ok: true,
    cantidad: Number(castigos.n),
    monto_total: Number(castigos.total),
  });

  const [prorrogas] = await query(
    `SELECT COUNT(*) AS n FROM Historial_Prorrogas WHERE deleted_at IS NULL`
  );
  checks.push({ check: 'Prórrogas', ok: true, cantidad: Number(prorrogas.n) });

  const [orphanPagos] = await query(
    `SELECT COUNT(*) AS n FROM Pagos pg
     LEFT JOIN Prestamos p ON p.id = pg.prestamo_id AND p.deleted_at IS NULL
     WHERE pg.deleted_at IS NULL AND p.id IS NULL`
  );
  checks.push({ check: 'Pagos huérfanos', ok: Number(orphanPagos.n) === 0, valor: Number(orphanPagos.n) });

  const cuotasPendPerdida = await query(
    `SELECT c.nombre_completo, COUNT(*) AS pend
     FROM Prestamos p
     JOIN Clientes c ON c.id = p.cliente_id
     JOIN Cuotas_Calendario cc ON cc.prestamo_id = p.id AND cc.deleted_at IS NULL
     WHERE p.estado = 'Perdida' AND cc.estado IN ('Programada', 'Parcial')
     GROUP BY c.nombre_completo`
  );
  checks.push({
    check: 'Perdida con cuotas Programada/Parcial',
    ok: !cuotasPendPerdida.length,
    casos: cuotasPendPerdida,
  });

  const estados = await query(
    `SELECT estado, COUNT(*) AS n, COALESCE(SUM(saldo_pendiente), 0) AS saldo
     FROM Prestamos WHERE deleted_at IS NULL GROUP BY estado ORDER BY estado`
  );

  const activosDetalle = await query(
    `SELECT c.nombre_completo, p.saldo_pendiente, p.monto_total_pagar,
            (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS pagos,
            ABS(p.saldo_pendiente - GREATEST(0, p.monto_total_pagar - (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL))) AS diff
     FROM Prestamos p JOIN Clientes c ON c.id = p.cliente_id
     WHERE p.deleted_at IS NULL AND p.estado = 'Activo'
     ORDER BY c.nombre_completo`
  );

  console.log(JSON.stringify({ fecha: new Date().toISOString(), checks, estados, activosDetalle }, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
