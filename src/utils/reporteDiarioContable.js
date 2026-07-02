const { query } = require('../config/db');
const { rangoDiaLocal } = require('./fechasSql');
const { hoyISO } = require('./zonaHoraria');
const {
  calcularLiquidacionAnticipada,
  fechaVencimientoCredito,
  prestamoEstaVencido,
} = require('./finanzasNube');

const BRAND_RUC = '1612710930000T';
const BRAND_NOMBRE = 'Credi Crece';

function fmtFechaHora(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    const h = String(v.getHours()).padStart(2, '0');
    const min = String(v.getMinutes()).padStart(2, '0');
    const s = String(v.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
  }
  return String(v).replace('T', ' ').slice(0, 19);
}

function fmtFechaISO(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function num(v) {
  return Number(v || 0);
}

function parseDias(raw) {
  if (!raw) return ['LUNES'];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) && arr.length ? arr.map((d) => String(d).toUpperCase()) : ['LUNES'];
  } catch {
    return ['LUNES'];
  }
}

function cuotaDelDia(prestamo) {
  const base = num(prestamo.cuota_semanal_base);
  const dias = parseDias(prestamo.dias_de_cobro);
  const freq = Math.max(1, dias.length);
  return Number((base / freq).toFixed(2));
}

function inferirTipoCobro(pago, prestamo, pagadoAntes, refDate) {
  const monto = num(pago.monto_pagado);
  const saldoAntes = Math.max(0, num(prestamo.monto_total_pagar) - pagadoAntes);
  const estadoPost = String(prestamo.estado || 'Activo');
  const cuota = cuotaDelDia(prestamo);

  if (estadoPost === 'Pagado' || num(prestamo.saldo_pendiente) <= 0.01) {
    const liq = calcularLiquidacionAnticipada(
      { ...prestamo, saldo_pendiente: saldoAntes },
      refDate,
      { pagadoAcumulado: pagadoAntes }
    );
    if (Math.abs(monto - liq.montoLiquidacion) < 0.05) {
      return liq.vencido ? 'Liquidación (crédito vencido)' : 'Liquidación anticipada';
    }
    return 'Liquidación / cancelación total';
  }

  if (cuota > 0 && Math.abs(monto - cuota) < 0.05) return 'Cuota del día';
  if (cuota > 0 && monto > cuota * 1.15) {
    const n = Math.round(monto / cuota);
    if (n >= 2 && Math.abs(monto - n * cuota) < 0.15) return `Cuotas múltiples (${n})`;
  }
  return 'Abono personalizado';
}

function estadoVencimientoTexto(prestamo, refDate) {
  const venc = fechaVencimientoCredito(
    prestamo.fecha_desembolso,
    prestamo.plazo_semanas,
    parseDias(prestamo.dias_de_cobro)
  );
  const vencido = prestamoEstaVencido(prestamo, refDate);
  return {
    estado_vencimiento: vencido ? 'VENCIDO' : 'VIGENTE',
    fecha_vencimiento: venc,
  };
}

/**
 * Diario contable de cobros — día calendario Nicaragua (06:00 a 06:00).
 * @param {string} fechaISO — YYYY-MM-DD
 */
async function buildReporteDiarioContable(fechaISO = hoyISO()) {
  const fecha = String(fechaISO).slice(0, 10);
  const { inicio, fin } = rangoDiaLocal(fecha);

  const pagos = await query(
    `SELECT pg.id AS pago_id, pg.prestamo_id, pg.monto_pagado, pg.fecha_pago,
            pg.cobrador_id, pg.operador_id, pg.registrado_por_admin,
            pg.latitud, pg.longitud,
            c.id AS cliente_id, c.nombre_completo, c.cedula, c.telefono,
            uc.nombre_completo AS cobrador_asignado,
            uo.nombre_completo AS cobrador_registro,
            uop.nombre_completo AS operador_nombre,
            p.monto_desembolsado, p.monto_total_pagar, p.saldo_pendiente,
            p.cuota_semanal_base, p.dias_de_cobro, p.plazo_semanas,
            p.fecha_desembolso, p.estado AS estado_prestamo,
            p.tasa_interes_aplicada, p.numero_recibo_fisico,
            (SELECT COALESCE(SUM(px.monto_pagado), 0) FROM Pagos px
             WHERE px.prestamo_id = pg.prestamo_id AND px.deleted_at IS NULL
               AND px.fecha_pago < pg.fecha_pago) AS pagado_antes_pago
     FROM Pagos pg
     INNER JOIN Prestamos p ON pg.prestamo_id = p.id AND p.deleted_at IS NULL
     INNER JOIN Clientes c ON p.cliente_id = c.id AND c.deleted_at IS NULL
     LEFT JOIN Usuarios uc ON c.cobrador_id = uc.id
     LEFT JOIN Usuarios uo ON pg.cobrador_id = uo.id
     LEFT JOIN Usuarios uop ON pg.operador_id = uop.id
     WHERE pg.deleted_at IS NULL AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
     ORDER BY pg.fecha_pago ASC, c.nombre_completo ASC`,
    [inicio, fin]
  );

  const gestiones = await query(
    `SELECT g.id, g.prestamo_id, g.motivo, g.fecha_gestion, g.registrado_por_admin,
            c.id AS cliente_id, c.nombre_completo, c.cedula,
            u.nombre_completo AS cobrador_nombre, p.saldo_pendiente
     FROM Gestiones_No_Pago g
     INNER JOIN Prestamos p ON g.prestamo_id = p.id AND p.deleted_at IS NULL
     INNER JOIN Clientes c ON p.cliente_id = c.id AND c.deleted_at IS NULL
     LEFT JOIN Usuarios u ON g.cobrador_id = u.id
     WHERE g.deleted_at IS NULL AND g.fecha_gestion >= ? AND g.fecha_gestion < ?
     ORDER BY g.fecha_gestion ASC`,
    [inicio, fin]
  );

  const cierres = await query(
    `SELECT cc.id, cc.cobrador_id, cc.fecha_cierre, cc.monto_efectivo, cc.transacciones,
            cc.observaciones, u.nombre_completo AS cobrador_nombre, u.email
     FROM Cierre_Caja cc
     LEFT JOIN Usuarios u ON cc.cobrador_id = u.id
     WHERE cc.deleted_at IS NULL AND DATE(cc.fecha_cierre) = DATE(?)`,
    [fecha]
  );

  const lineas = [];
  const porTipo = new Map();
  const porCobrador = new Map();
  const porCanal = { cobrador: { n: 0, monto: 0 }, administracion: { n: 0, monto: 0 } };
  let totalCobrado = 0;
  let totalCapitalDesembolsado = 0;
  let liquidaciones = 0;

  for (const row of pagos) {
    const monto = num(row.monto_pagado);
    const pagadoAntes = num(row.pagado_antes_pago);
    const totalPagar = num(row.monto_total_pagar);
    const saldoAntes = Math.max(0, Number((totalPagar - pagadoAntes).toFixed(2)));
    const saldoDespues = Math.max(0, Number((totalPagar - pagadoAntes - monto).toFixed(2)));
    const refDate = new Date(row.fecha_pago);
    const tipo = inferirTipoCobro(row, row, pagadoAntes, refDate);
    const { estado_vencimiento, fecha_vencimiento } = estadoVencimientoTexto(row, refDate);
    const porAdmin = Number(row.registrado_por_admin) === 1;
    const canal = porAdmin ? 'Administración (campo)' : 'Cobrador en ruta';
    const cobrador = row.cobrador_registro || row.cobrador_asignado || '—';
    const interesPactado = Math.max(0, num(row.monto_total_pagar) - num(row.monto_desembolsado));

    if (tipo.includes('Liquidación')) liquidaciones += 1;
    totalCobrado += monto;
    totalCapitalDesembolsado += num(row.monto_desembolsado);

    porTipo.set(tipo, { n: (porTipo.get(tipo)?.n || 0) + 1, monto: (porTipo.get(tipo)?.monto || 0) + monto });
    porCobrador.set(cobrador, { n: (porCobrador.get(cobrador)?.n || 0) + 1, monto: (porCobrador.get(cobrador)?.monto || 0) + monto });
    const canalKey = porAdmin ? 'administracion' : 'cobrador';
    porCanal[canalKey].n += 1;
    porCanal[canalKey].monto += monto;

    lineas.push({
      fecha_contable: fecha,
      hora_cobro: fmtFechaHora(row.fecha_pago),
      comprobante_id: row.pago_id,
      codigo_cliente: row.cliente_id,
      cliente: row.nombre_completo,
      cedula: row.cedula,
      telefono: row.telefono || '',
      prestamo_id: row.prestamo_id,
      recibo_fisico: row.numero_recibo_fisico || '',
      cobrador,
      canal,
      tipo_cobro: tipo,
      moneda: 'NIO',
      monto_cobrado: monto,
      capital_desembolsado: num(row.monto_desembolsado),
      interes_pactado_total: interesPactado,
      monto_total_pagar: totalPagar,
      saldo_antes: saldoAntes,
      saldo_despues: num(row.estado_prestamo) === 'Pagado' ? 0 : num(row.saldo_pendiente),
      saldo_calculado_despues: saldoDespues,
      estado_prestamo: row.estado_prestamo,
      estado_vencimiento,
      fecha_vencimiento: fmtFechaISO(fecha_vencimiento),
      fecha_desembolso: fmtFechaISO(row.fecha_desembolso),
      cuota_semanal: num(row.cuota_semanal_base),
      cuota_del_dia: cuotaDelDia(row),
      plazo_semanas: num(row.plazo_semanas),
      tasa_interes_pct: Number((num(row.tasa_interes_aplicada) * 100).toFixed(2)),
      gps: num(row.latitud) || num(row.longitud) ? 'SI' : 'NO',
      cuenta_sugerida_debe: '105 - Caja general',
      cuenta_sugerida_haber: estado_vencimiento === 'VENCIDO' ? '130 - Cartera vencida' : '120 - Cartera vigente',
    });
  }

  const resumenTipo = [...porTipo.entries()].map(([tipo_cobro, v]) => ({
    tipo_cobro,
    cantidad: v.n,
    monto: Number(v.monto.toFixed(2)),
  }));

  const resumenCobrador = [...porCobrador.entries()].map(([cobrador, v]) => ({
    cobrador,
    cantidad: v.n,
    monto: Number(v.monto.toFixed(2)),
  }));

  const totalCierres = cierres.reduce((s, c) => s + num(c.monto_efectivo), 0);

  return {
    tipo: 'DIARIO DE COBROS',
    encabezado: {
      empresa: BRAND_NOMBRE,
      ruc: BRAND_RUC,
      pais: 'Nicaragua',
      moneda: 'Córdoba (NIO)',
      fecha_contable: fecha,
      rango_nicaragua: { inicio, fin },
      generado: new Date().toISOString(),
      nota_contable:
        'Libro auxiliar de recuperación diaria. Las cuentas sugeridas son referencia; ajuste según catálogo del contador.',
    },
    resumen: {
      pagos_registrados: pagos.length,
      monto_total_cobrado: Number(totalCobrado.toFixed(2)),
      liquidaciones: liquidaciones,
      gestiones_no_pago: gestiones.length,
      cierres_caja: cierres.length,
      monto_cierres_caja: Number(totalCierres.toFixed(2)),
      diferencia_cobros_vs_cierre:
        cierres.length > 0 ? Number((totalCobrado - totalCierres).toFixed(2)) : null,
      por_canal: porCanal,
    },
    resumen_tipo_cobro: resumenTipo,
    resumen_por_cobrador: resumenCobrador,
    lineas,
    gestiones_no_pago: gestiones.map((g) => ({
      fecha: fmtFechaHora(g.fecha_gestion),
      cliente: g.nombre_completo,
      cedula: g.cedula,
      cobrador: g.cobrador_nombre,
      motivo: g.motivo,
      saldo_prestamo: num(g.saldo_pendiente),
      canal: Number(g.registrado_por_admin) === 1 ? 'Administración' : 'Cobrador',
    })),
    cierres_caja: cierres.map((c) => ({
      cobrador: c.cobrador_nombre,
      email: c.email,
      fecha_cierre: fmtFechaISO(c.fecha_cierre),
      monto_efectivo: num(c.monto_efectivo),
      transacciones: num(c.transacciones),
      observaciones: c.observaciones || '',
    })),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { buildReporteDiarioContable };
