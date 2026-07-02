require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');
const { montoVisitaHoy, esCuotaDiaDesembolso } = require('../utils/diasCobro');
const {
  seleccionarCuotaAgenda,
  montoCobroDelDia,
  pendienteCuota,
  esCuotaFantasma,
} = require('../utils/cuotasCalendario');
const { hoyISO } = require('../utils/zonaHoraria');
const { fechaVencimientoCredito, prestamoEstaVencido } = require('../utils/finanzasNube');
const { calcularLiquidacionAnticipada } = require('../utils/finanzasNube');

const buscar = process.argv.slice(2).join(' ') || 'andrea isabel gonzalez';

async function main() {
  const hoy = hoyISO();
  console.log('Hoy:', hoy, '\n');

  const rows = await query(
    `SELECT c.nombre_completo, c.id AS cliente_id, p.*
     FROM Clientes c
     JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
     WHERE LOWER(c.nombre_completo) LIKE ?`,
    [`%${buscar.toLowerCase()}%`]
  );

  if (!rows.length) {
    console.log('No encontrado:', buscar);
    return;
  }

  for (const p of rows) {
    let dias = p.dias_de_cobro;
    try {
      dias = typeof dias === 'string' ? JSON.parse(dias) : dias;
    } catch {
      dias = ['LUNES'];
    }

    const venc = fechaVencimientoCredito(p.fecha_desembolso, p.plazo_semanas, dias);
    const vencido = prestamoEstaVencido(p);

    const cuotas = await query(
      `SELECT id, fecha_programada, monto_programado, monto_pagado, estado
       FROM Cuotas_Calendario
       WHERE prestamo_id = ? AND deleted_at IS NULL
       ORDER BY fecha_programada ASC`,
      [p.id]
    );

    const cuotasPend = cuotas.filter((c) => ['Programada', 'Parcial'].includes(c.estado));
    const cuotasPendHoy = cuotasPend.filter((c) => String(c.fecha_programada).slice(0, 10) <= hoy);

    const pagos = await query(
      `SELECT COALESCE(SUM(monto_pagado),0) AS t FROM Pagos WHERE prestamo_id=? AND deleted_at IS NULL`,
      [p.id]
    );

    const cuotaSel = seleccionarCuotaAgenda(cuotasPendHoy, p, hoy, esCuotaDiaDesembolso, montoVisitaHoy);
    const montoAgenda = montoCobroDelDia(cuotaSel, p, montoVisitaHoy);
    const visita = montoVisitaHoy(p.cuota_semanal_base, p.dias_de_cobro);

    const liq = calcularLiquidacionAnticipada(p, new Date(), {
      pagadoAcumulado: Number(pagos[0]?.t || 0),
    });

    console.log('===', p.nombre_completo, '===');
    console.log({
      prestamo_id: p.id,
      saldo_pendiente: p.saldo_pendiente,
      monto_total_pagar: p.monto_total_pagar,
      cuota_semanal_base: p.cuota_semanal_base,
      plazo_semanas: p.plazo_semanas,
      dias_de_cobro: dias,
      fecha_desembolso: p.fecha_desembolso,
      fecha_vencimiento: venc,
      vencido,
      sum_pagos: pagos[0]?.t,
      visita_teorica: visita,
      cuota_seleccionada: cuotaSel
        ? {
            fecha: cuotaSel.fecha_programada,
            prog: cuotaSel.monto_programado,
            pag: cuotaSel.monto_pagado,
            pend: pendienteCuota(cuotaSel),
            estado: cuotaSel.estado,
            fantasma: esCuotaFantasma(pendienteCuota(cuotaSel), p.saldo_pendiente, visita),
          }
        : null,
      monto_agenda: montoAgenda,
      liquidacion_vencido: liq.vencido ? liq.montoLiquidacion : null,
      cuotas_pendientes_total: cuotasPend.length,
    });

    console.log('\nCuotas pendientes (primeras 8):');
    cuotasPend.slice(0, 8).forEach((c) => {
      console.log(
        `  ${String(c.fecha_programada).slice(0, 10)} | prog=${c.monto_programado} pag=${c.monto_pagado} pend=${pendienteCuota(c)} | ${c.estado}`
      );
    });

    console.log('\nCuotas pendientes (últimas 5):');
    cuotasPend.slice(-5).forEach((c) => {
      console.log(
        `  ${String(c.fecha_programada).slice(0, 10)} | prog=${c.monto_programado} pag=${c.monto_pagado} pend=${pendienteCuota(c)} | ${c.estado}`
      );
    });

    const sumCuotasPagado = cuotas.reduce((s, c) => s + Number(c.monto_pagado || 0), 0);
    const sumCuotasProg = cuotas.reduce((s, c) => s + Number(c.monto_programado || 0), 0);
    console.log('\nSuma calendario: prog=', sumCuotasProg.toFixed(2), 'pag=', sumCuotasPagado.toFixed(2));

    console.log('\nÚltimas cuotas Pagadas (transición a pendientes):');
    const pagadas = cuotas.filter((c) => c.estado === 'Pagada');
    pagadas.slice(-5).forEach((c) => {
      console.log(`  ${c.fecha_programada} | prog=${c.monto_programado} pag=${c.monto_pagado} | ${c.estado}`);
    });
    const primeraPend = cuotasPend[0];
    if (primeraPend) {
      console.log('\nPrimera cuota pendiente:', primeraPend);
      console.log('String fecha slice(0,10):', String(primeraPend.fecha_programada).slice(0, 10));
      console.log('Comparación > hoy:', String(primeraPend.fecha_programada).slice(0, 10) > hoy);
    }

    // Simular bug de fecha Date vs ISO
    const cuotaSelBug = (() => {
      for (const c of cuotasPendHoy) {
        const fechaCuota = String(c.fecha_programada || '').slice(0, 10);
        if (hoy && fechaCuota && fechaCuota > hoy) continue;
        return { c, fechaCuota };
      }
      return null;
    })();
    console.log('\nDebug fecha (primer cuota pendiente):', cuotaSelBug);
  }
}

main().finally(() => pool.end());
