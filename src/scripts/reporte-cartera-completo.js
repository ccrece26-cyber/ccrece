/**
 * Reporte completo de cartera — clientes, préstamos, pagos, saldos, vencimiento.
 * Uso: node src/scripts/reporte-cartera-completo.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');
const {
  calcularLiquidacionAnticipada,
  fechaVencimientoCredito,
} = require('../utils/finanzasNube');
const { hoyISO } = require('../utils/zonaHoraria');

function n(v) {
  return Number(v || 0);
}

function parseDias(v) {
  if (!v) return ['LUNES'];
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    return ['LUNES'];
  }
}

function fmt(v) {
  return `C$ ${n(v).toLocaleString('es-NI', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fechaStr(v) {
  if (!v) return '—';
  return String(v).slice(0, 10);
}

(async () => {
  const hoy = hoyISO();
  const clientes = await query(
    `SELECT c.id, c.cedula, c.nombre_completo, c.telefono, c.direccion,
            u.nombre_completo AS cobrador
     FROM Clientes c
     LEFT JOIN Usuarios u ON c.cobrador_id = u.id
     WHERE c.deleted_at IS NULL
     ORDER BY c.nombre_completo`
  );

  const prestamos = await query(
    `SELECT p.*, c.cedula, c.nombre_completo,
            (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS total_pagos,
            (SELECT COUNT(*) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS n_pagos,
            (SELECT COALESCE(SUM(monto_pagado), 0) FROM Cuotas_Calendario cc
             WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL) AS sum_cuotas_pagado,
            (SELECT COUNT(*) FROM Cuotas_Calendario cc
             WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL
               AND cc.estado IN ('Pagada', 'Parcial')) AS cuotas_cobradas,
            (SELECT COUNT(*) FROM Cuotas_Calendario cc
             WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL) AS cuotas_total
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE p.deleted_at IS NULL
     ORDER BY c.nombre_completo, p.fecha_desembolso DESC`
  );

  const pagosPorPrestamo = {};
  const allPagos = await query(
    `SELECT pg.prestamo_id, pg.monto_pagado, pg.fecha_pago, u.nombre_completo AS cobrador
     FROM Pagos pg
     LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
     WHERE pg.deleted_at IS NULL
     ORDER BY pg.fecha_pago ASC`
  );
  for (const pg of allPagos) {
    if (!pagosPorPrestamo[pg.prestamo_id]) pagosPorPrestamo[pg.prestamo_id] = [];
    pagosPorPrestamo[pg.prestamo_id].push(pg);
  }

  const resumen = {
    clientes: clientes.length,
    prestamos_activos: 0,
    prestamos_pagados: 0,
    capital_desembolsado: 0,
    total_contrato: 0,
    total_cobrado: 0,
    cartera_pendiente: 0,
    interes_contrato: 0,
  };

  const filas = [];

  for (const p of prestamos) {
    const dias = parseDias(p.dias_de_cobro);
    const capital = n(p.monto_desembolsado);
    const total = n(p.monto_total_pagar);
    const saldo = n(p.saldo_pendiente);
    const pagado = n(p.total_pagos);
    const interes = total - capital;
    const tasaGlobal = n(p.tasa_interes_aplicada) * 100;
    const tasaMensual = (n(p.tasa_interes_aplicada) / (n(p.plazo_semanas) / 4)) * 100;
    const vencimiento = fechaVencimientoCredito(p.fecha_desembolso, p.plazo_semanas, dias);
    const vencido = vencimiento && hoy >= vencimiento;
    const desembolso = fechaStr(p.fecha_desembolso);
    const liq =
      p.estado === 'Activo'
        ? calcularLiquidacionAnticipada(p, new Date(), { pagadoAcumulado: pagado })
        : null;

    if (p.estado === 'Activo') {
      resumen.prestamos_activos += 1;
      resumen.cartera_pendiente += saldo;
    } else if (p.estado === 'Pagado') {
      resumen.prestamos_pagados += 1;
    }
    resumen.capital_desembolsado += capital;
    resumen.total_contrato += total;
    resumen.total_cobrado += pagado;
    resumen.interes_contrato += interes;

    const pagos = pagosPorPrestamo[p.id] || [];
    const pctPagado = total > 0 ? ((pagado / total) * 100).toFixed(1) : '0.0';

    filas.push({
      cliente: p.nombre_completo,
      cedula: p.cedula,
      cobrador: p.cobrador || '—',
      estado: p.estado,
      capital,
      interes,
      total,
      tasa_mensual: tasaMensual.toFixed(1) + '%',
      tasa_global: tasaGlobal.toFixed(1) + '%',
      plazo_sem: n(p.plazo_semanas),
      dias_cobro: dias.join(', '),
      desembolso,
      vencimiento: vencimiento || '—',
      vencido: vencido ? 'SÍ' : 'NO',
      cuota_sem: n(p.cuota_semanal_base),
      pagado,
      pct_pagado: pctPagado + '%',
      saldo,
      n_pagos: n(p.n_pagos),
      cuotas: `${p.cuotas_cobradas}/${p.cuotas_total}`,
      sum_cuotas: n(p.sum_cuotas_pagado),
      liq_hoy: liq ? liq.montoLiquidacion : null,
      tipo_liq: liq ? (liq.vencido ? 'Vencido' : 'Anticipado') : '—',
      ahorro_liq: liq ? liq.descuentoInteres : 0,
      pagos_detalle: pagos,
    });
  }

  console.log('\n' + '═'.repeat(72));
  console.log('  REPORTE COMPLETO DE CARTERA — Credi Crece');
  console.log('  Fecha de corte:', hoy);
  console.log('═'.repeat(72));

  console.log('\n▌ RESUMEN GENERAL\n');
  console.log(`  Clientes en cartera:        ${resumen.clientes}`);
  console.log(`  Préstamos activos:          ${resumen.prestamos_activos}`);
  console.log(`  Préstamos pagados:          ${resumen.prestamos_pagados}`);
  console.log(`  Capital desembolsado:       ${fmt(resumen.capital_desembolsado)}`);
  console.log(`  Interés total contratos:    ${fmt(resumen.interes_contrato)}`);
  console.log(`  Total a pagar (contratos):  ${fmt(resumen.total_contrato)}`);
  console.log(`  Total cobrado (Pagos):      ${fmt(resumen.total_cobrado)}`);
  console.log(`  Cartera pendiente (saldo):  ${fmt(resumen.cartera_pendiente)}`);
  console.log(
    `  % recuperado:               ${resumen.total_contrato > 0 ? ((resumen.total_cobrado / resumen.total_contrato) * 100).toFixed(1) : 0}%`
  );

  console.log('\n' + '─'.repeat(72));
  console.log('▌ DETALLE POR CLIENTE / PRÉSTAMO\n');

  for (const f of filas) {
    console.log('═'.repeat(72));
    console.log(`  ${f.cliente}`);
    console.log(`  Cédula: ${f.cedula}  |  Cobrador: ${f.cobrador}`);
    console.log('─'.repeat(72));
    console.log(`  Estado:              ${f.estado}${f.vencido === 'SÍ' && f.estado === 'Activo' ? ' (VENCIDO)' : ''}`);
    console.log(`  Capital prestado:    ${fmt(f.capital)}`);
    console.log(`  Interés contrato:    ${fmt(f.interes)} (${f.tasa_mensual} mensual → ${f.tasa_global} global)`);
    console.log(`  Total a pagar:       ${fmt(f.total)}`);
    console.log(`  Plazo:               ${f.plazo_sem} semanas`);
    console.log(`  Días de cobro:       ${f.dias_cobro}`);
    console.log(`  Cuota semanal:       ${fmt(f.cuota_sem)}`);
    console.log(`  Fecha desembolso:    ${f.desembolso}`);
    console.log(`  Fecha vencimiento:   ${f.vencimiento}  (${f.vencido === 'SÍ' ? 'vencido' : 'vigente'})`);
    console.log(`  Cuotas calendario:   ${f.cuotas} visitas (${fmt(f.sum_cuotas)} en cuotas)`);
    console.log('─'.repeat(72));
    console.log(`  Pagado (real):       ${fmt(f.pagado)}  (${f.pct_pagado} del contrato) — ${f.n_pagos} pago(s)`);
    console.log(`  Saldo pendiente:     ${fmt(f.saldo)}`);
    if (f.estado === 'Activo' && f.liq_hoy != null) {
      console.log(`  Si liquida hoy:      ${fmt(f.liq_hoy)}  [${f.tipo_liq}]`);
      if (f.ahorro_liq > 0) console.log(`  Ahorro liquidación:  ${fmt(f.ahorro_liq)}`);
    }
    if (f.pagos_detalle.length) {
      console.log('  Historial de pagos:');
      for (const pg of f.pagos_detalle) {
        console.log(
          `    · ${fechaStr(pg.fecha_pago)}  ${fmt(pg.monto_pagado)}  (${pg.cobrador || '—'})`
        );
      }
    } else {
      console.log('  Historial de pagos:  (ninguno registrado en app)');
    }
    console.log('');
  }

  console.log('═'.repeat(72));
  console.log('▌ TABLA RESUMEN\n');
  console.log(
    'Cliente'.padEnd(28) +
      'Estado'.padEnd(8) +
      'Capital'.padStart(10) +
      'Pagado'.padStart(10) +
      'Saldo'.padStart(10) +
      'Vence'.padStart(12) +
      '  Venc.'
  );
  console.log('─'.repeat(72));
  for (const f of filas) {
    console.log(
      f.cliente.slice(0, 27).padEnd(28) +
        f.estado.padEnd(8) +
        fmt(f.capital).padStart(10) +
        fmt(f.pagado).padStart(10) +
        fmt(f.saldo).padStart(10) +
        String(f.vencimiento).padStart(12) +
        `  ${f.vencido}`
    );
  }
  console.log('═'.repeat(72) + '\n');

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
