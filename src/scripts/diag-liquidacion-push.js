/**
 * Simula detección de liquidación en push (mismo criterio que servidor).
 * Uso: node src/scripts/diag-liquidacion-push.js [prestamo_id]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query } = require('../config/db');
const { calcularLiquidacionAnticipada } = require('../utils/finanzasNube');
const { resolverLiquidacionEnPush } = require('../utils/registrarPagoNube');

(async () => {
  const prestamoId = process.argv[2];
  let prestamos;
  if (prestamoId) {
    prestamos = await query(
      `SELECT p.*, c.nombre_completo FROM Prestamos p
       JOIN Clientes c ON c.id = p.cliente_id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [prestamoId]
    );
  } else {
    prestamos = await query(
      `SELECT p.*, c.nombre_completo FROM Prestamos p
       JOIN Clientes c ON c.id = p.cliente_id
       WHERE p.estado = 'Activo' AND p.deleted_at IS NULL AND p.saldo_pendiente > 100
       ORDER BY p.updated_at DESC LIMIT 5`
    );
  }

  for (const p of prestamos) {
    const [pagos] = await query(
      `SELECT COALESCE(SUM(monto_pagado),0) AS t FROM Pagos WHERE prestamo_id = ? AND deleted_at IS NULL`,
      [p.id]
    );
    const pagadoAcumulado = Number(pagos.t || 0);
    const liq = calcularLiquidacionAnticipada(p, new Date(), { pagadoAcumulado });
    const pagoSim = {
      monto_pagado: liq.montoLiquidacion,
      tipo_cobro: 'liquidacion',
      fecha_pago: new Date().toISOString(),
    };
    const res = resolverLiquidacionEnPush(pagoSim, p, pagadoAcumulado);
    const rechazoNormal =
      !res.esLiquidacion && res.montoEfectivo > Number(p.saldo_pendiente) + 0.01;

    console.log('\n---', p.nombre_completo, p.id);
    console.log('  saldo_nube:', p.saldo_pendiente, '| total:', p.monto_total_pagar);
    console.log('  liq.monto:', liq.montoLiquidacion, '| vencido:', liq.vencido);
    console.log('  esLiquidacion:', res.esLiquidacion, '| montoEfectivo:', res.montoEfectivo);
    console.log('  rechazo monto_supera_saldo:', rechazoNormal);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
