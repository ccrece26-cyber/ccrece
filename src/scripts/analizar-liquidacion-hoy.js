require('dotenv').config();
const { query } = require('../config/db');
const { calcularLiquidacionAnticipada } = require('../utils/finanzasNube');
const { hoyISO, rangoDiaNicaragua } = require('../utils/zonaHoraria');

(async () => {
  const hoy = hoyISO();
  const { inicio, fin } = rangoDiaNicaragua(hoy);

  const prestamos = await query(
    `SELECT p.*, c.nombre_completo, c.cedula, u.nombre_completo AS cobrador
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id
     LEFT JOIN Usuarios u ON c.cobrador_id = u.id
     WHERE p.estado = 'Pagado' AND p.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM Pagos pg
         WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL
           AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
       )
     ORDER BY p.updated_at DESC`,
    [inicio, fin]
  );

  for (const p of prestamos) {
    const pagos = await query(
      `SELECT id, monto_pagado, fecha_pago, cobrador_id
       FROM Pagos WHERE prestamo_id = ? AND deleted_at IS NULL
       ORDER BY fecha_pago ASC`,
      [p.id]
    );

    const plazo = Number(p.plazo_semanas);
    const tasaGlobal = Number(p.tasa_interes_aplicada);
    const tasaMensual = tasaGlobal / (plazo / 4);
    const capital = Number(p.monto_desembolsado);
    const interesOriginal = Number((capital * tasaGlobal).toFixed(2));
    const totalOriginal = Number(p.monto_total_pagar);
    const totalPagado = pagos.reduce((s, x) => s + Number(x.monto_pagado), 0);

    const ultimoPagoHoy = pagos.filter(
      (pg) => pg.fecha_pago >= inicio && pg.fecha_pago < fin
    );
    const pagadoAntesUltimo = totalPagado - ultimoPagoHoy.reduce((s, x) => s + Number(x.monto_pagado), 0);
    const saldoAntesUltimo = Number((totalOriginal - pagadoAntesUltimo).toFixed(2));

    const fechaLiq = ultimoPagoHoy.length
      ? new Date(ultimoPagoHoy[ultimoPagoHoy.length - 1].fecha_pago)
      : new Date();

    const liq = calcularLiquidacionAnticipada(
      { ...p, saldo_pendiente: saldoAntesUltimo },
      fechaLiq
    );

    console.log('═══════════════════════════════════════════════════');
    console.log('CLIENTE:', p.nombre_completo);
    console.log('Cédula:', p.cedula, '| Cobrador:', p.cobrador);
    console.log('Préstamo ID:', p.id);
    console.log('───────────────────────────────────────────────────');
    console.log('CAPITAL PRESTADO:     C$', capital.toFixed(2));
    console.log('Fecha desembolso:    ', String(p.fecha_desembolso).slice(0, 10));
    console.log('Plazo:               ', plazo, 'semanas (', plazo / 4, 'meses × 10% mensual)');
    console.log('Tasa mensual:        ', (tasaMensual * 100).toFixed(1) + '%');
    console.log('Tasa global contrato:', (tasaGlobal * 100).toFixed(1) + '%');
    console.log('Interés total contrato: C$', interesOriginal.toFixed(2));
    console.log('Total a pagar contrato: C$', totalOriginal.toFixed(2));
    console.log('Cuota semanal:        C$', Number(p.cuota_semanal_base).toFixed(2));
    console.log('───────────────────────────────────────────────────');
    console.log('HISTORIAL DE PAGOS (' + pagos.length + ' registros, total C$' + totalPagado.toFixed(2) + '):');
    for (const pg of pagos) {
      const esHoy = pg.fecha_pago >= inicio && pg.fecha_pago < fin ? ' ← HOY' : '';
      console.log(
        '  ',
        String(pg.fecha_pago).slice(0, 19),
        'C$' + Number(pg.monto_pagado).toFixed(2) + esHoy
      );
    }
    console.log('───────────────────────────────────────────────────');
    console.log('ANTES DE LIQUIDAR HOY:');
    console.log('  Pagado acumulado:   C$', pagadoAntesUltimo.toFixed(2));
    console.log('  Saldo pendiente:    C$', saldoAntesUltimo.toFixed(2));
    console.log('LIQUIDACIÓN ANTICIPADA (al momento del pago):');
    console.log('  Semanas transcurridas:', liq.semanasUsadas, 'de', plazo);
    console.log(
      '  Tasa global efectiva:',
      ((liq.semanasUsadas / plazo) * tasaGlobal * 100).toFixed(2) + '%',
      '(vs',
      (tasaGlobal * 100).toFixed(1) + '% contrato)'
    );
    const tasaAjustada = tasaMensual * (liq.semanasUsadas / 4);
    const interesAjustado = Number((capital * tasaAjustada).toFixed(2));
    console.log('  Interés ajustado:   C$', interesAjustado.toFixed(2), '(vs C$' + interesOriginal.toFixed(2) + ' contrato)');
    console.log('  Capital + interés ajustado: C$', (capital + interesAjustado).toFixed(2));
    console.log('  Monto liquidación calculado: C$', liq.montoLiquidacion.toFixed(2));
    console.log('  Monto pagado hoy:   C$', ultimoPagoHoy.reduce((s, x) => s + Number(x.monto_pagado), 0).toFixed(2));
    console.log('  Ahorro por liquidar anticipado: C$', liq.descuentoInteres.toFixed(2));
    console.log('  (Sin liquidación habría pagado: C$' + saldoAntesUltimo.toFixed(2) + ' más de cuotas)');
    console.log('═══════════════════════════════════════════════════\n');
  }

  if (!prestamos.length) {
    console.log('No hay préstamos liquidados con actividad hoy:', hoy);
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
