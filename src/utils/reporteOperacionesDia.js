/**
 * Datos + Excel del reporte de operaciones por día (pagos, renovaciones, desembolsos, cierres).
 * Usado por el script CLI y por GET /admin/reportes/operaciones-dia.
 */
const XLSX = require('xlsx');
const { query } = require('../config/db');
const { rangoDiaLocal } = require('./fechasSql');
const { toFechaISO, ZONA_NICARAGUA } = require('./zonaHoraria');

const COB_LABEL = {
  'COB-mq879bqw': 'Vielka',
  'COB-mq879qxc': 'Álvaro',
  'USER-ADMIN-1': 'J.Carlos',
};

const num = (n) => {
  const x = Number(String(n ?? 0).replace(/,/g, ''));
  return Number.isFinite(x) ? x : 0;
};

const fmtHora = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(String(v).includes('T') ? v : `${v}`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-NI', {
    timeZone: ZONA_NICARAGUA,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const labelCobrador = (nombre, id) => {
  if (id && COB_LABEL[id]) return COB_LABEL[id];
  const n = String(nombre || '');
  if (/cobrador\s*2/i.test(n)) return 'Álvaro';
  if (/vielka/i.test(n)) return 'Vielka';
  return n || '—';
};

async function cargarDatosOperacionesDia(fechaRaw) {
  const fecha = toFechaISO(fechaRaw);
  const { inicio, fin } = rangoDiaLocal(fecha);

  const renovaciones = await query(
    `SELECT r.id, r.prestamo_anterior_id, r.prestamo_nuevo_id,
            ROUND(r.saldo_pendiente_anterior, 2) AS saldo_anterior,
            ROUND(r.nuevo_desembolso, 2) AS nuevo_monto,
            ROUND(r.efectivo_entregar, 2) AS efectivo,
            ROUND(r.monto_total_a_pagar, 2) AS total_pagar,
            r.plazo_semanas, ROUND(r.tasa_aplicada * 100, 2) AS tasa_pct,
            r.fecha_renovacion,
            u.nombre_completo AS cobrador,
            c.id AS codigo, c.nombre_completo AS cliente, c.cedula,
            pn.numero_recibo_fisico AS recibo
     FROM Renovaciones_Log r
     JOIN Prestamos pn ON pn.id = r.prestamo_nuevo_id AND pn.deleted_at IS NULL
     JOIN Clientes c ON c.id = pn.cliente_id
     JOIN Usuarios u ON u.id = r.cobrador_opero_id
     WHERE r.deleted_at IS NULL
       AND r.fecha_renovacion >= ? AND r.fecha_renovacion < ?
     ORDER BY u.nombre_completo, c.id`,
    [inicio, fin]
  );

  const pagoRenovIds = new Set(renovaciones.map((r) => r.prestamo_anterior_id).filter(Boolean));
  const reciboRenovPorPrestamo = new Map(
    renovaciones.map((r) => [r.prestamo_anterior_id, r.recibo || ''])
  );

  const pagos = await query(
    `SELECT pg.id AS pago_id, pg.monto_pagado, pg.fecha_pago, pg.tipo_cobro,
            pg.prestamo_id, pg.cobrador_id,
            u.nombre_completo AS cobrador,
            c.id AS codigo, c.nombre_completo AS cliente, c.cedula,
            p.numero_recibo_fisico AS recibo, p.estado AS estado_prestamo,
            p.monto_total_pagar,
            (SELECT COALESCE(SUM(px.monto_pagado), 0) FROM Pagos px
             WHERE px.prestamo_id = pg.prestamo_id AND px.deleted_at IS NULL
               AND px.fecha_pago < pg.fecha_pago) AS pagado_antes
     FROM Pagos pg
     JOIN Prestamos p ON p.id = pg.prestamo_id AND p.deleted_at IS NULL
     JOIN Clientes c ON c.id = p.cliente_id AND c.deleted_at IS NULL
     LEFT JOIN Usuarios u ON u.id = pg.cobrador_id
     WHERE pg.deleted_at IS NULL
       AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
     ORDER BY u.nombre_completo, c.nombre_completo, pg.fecha_pago`,
    [inicio, fin]
  );

  const pagosRows = pagos.map((p) => {
    const esRenovacion =
      String(p.tipo_cobro || '').toLowerCase() === 'renovacion' ||
      pagoRenovIds.has(p.prestamo_id);
    const total = num(p.monto_total_pagar);
    const pagadoAntes = num(p.pagado_antes);
    const monto = num(p.monto_pagado);
    const saldoAntes = Math.max(0, Number((total - pagadoAntes).toFixed(2)));
    const saldoDespues =
      String(p.estado_prestamo) === 'Pagado'
        ? 0
        : Math.max(0, Number((saldoAntes - monto).toFixed(2)));
    const reciboRenov = esRenovacion ? reciboRenovPorPrestamo.get(p.prestamo_id) || '' : '';
    return {
      hora: fmtHora(p.fecha_pago),
      cobrador: labelCobrador(p.cobrador, p.cobrador_id),
      codigo: p.codigo,
      cliente: p.cliente || '',
      cedula: p.cedula || '',
      recibo: esRenovacion ? reciboRenov : '',
      monto,
      saldo_antes: saldoAntes,
      saldo_despues: saldoDespues,
      tipo_cobro: p.tipo_cobro || 'abono',
      es_renovacion: esRenovacion ? 'SI' : 'NO',
      estado_prestamo: p.estado_prestamo,
      pago_id: p.pago_id,
    };
  });

  const desembolsos = await query(
    `SELECT p.id AS prestamo_id, p.monto_desembolsado, p.plazo_semanas,
            ROUND(p.tasa_interes_aplicada * 100, 2) AS tasa_pct,
            ROUND(p.monto_total_pagar, 2) AS total_pagar,
            ROUND(p.saldo_pendiente, 2) AS saldo,
            p.numero_recibo_fisico AS recibo, p.fecha_desembolso, p.dias_de_cobro,
            p.renovacion_previa_id,
            c.id AS codigo, c.nombre_completo AS cliente, c.cedula,
            ue.nombre_completo AS cobrador_entrega,
            ue.id AS cobrador_entrega_id,
            CASE WHEN r.id IS NOT NULL OR p.renovacion_previa_id IS NOT NULL THEN 'RENOVACION' ELSE 'NUEVO' END AS tipo
     FROM Prestamos p
     JOIN Clientes c ON c.id = p.cliente_id AND c.deleted_at IS NULL
     LEFT JOIN Usuarios ue ON ue.id = p.cobrador_entrega_id
     LEFT JOIN Renovaciones_Log r ON r.prestamo_nuevo_id = p.id AND r.deleted_at IS NULL
       AND r.fecha_renovacion >= ? AND r.fecha_renovacion < ?
     WHERE p.deleted_at IS NULL AND DATE(p.fecha_desembolso) = ?
     ORDER BY tipo, ue.nombre_completo, c.id`,
    [inicio, fin, fecha]
  );

  const desRows = desembolsos.map((d) => {
    let dias = '';
    try {
      const arr = typeof d.dias_de_cobro === 'string' ? JSON.parse(d.dias_de_cobro) : d.dias_de_cobro;
      dias = Array.isArray(arr) ? arr.join(', ') : String(d.dias_de_cobro || '');
    } catch {
      dias = String(d.dias_de_cobro || '');
    }
    return {
      tipo: d.tipo,
      cobrador: labelCobrador(d.cobrador_entrega, d.cobrador_entrega_id),
      codigo: d.codigo,
      cliente: d.cliente || '',
      cedula: d.cedula || '',
      recibo: d.recibo || '',
      monto: num(d.monto_desembolsado),
      plazo: num(d.plazo_semanas),
      tasa_pct: num(d.tasa_pct),
      total_pagar: num(d.total_pagar),
      saldo: num(d.saldo),
      dias_cobro: dias,
      es_renovacion: d.tipo === 'RENOVACION' ? 'SI' : 'NO',
    };
  });

  const cierres = await query(
    `SELECT u.id AS cobrador_id, u.nombre_completo AS cobrador, cc.monto_efectivo, cc.transacciones,
            cc.observaciones, cc.fecha_cierre
     FROM Cierre_Caja cc
     JOIN Usuarios u ON u.id = cc.cobrador_id
     WHERE cc.deleted_at IS NULL AND DATE(cc.fecha_cierre) = ?
     ORDER BY u.nombre_completo`,
    [fecha]
  );

  const cierresRows = [];
  for (const c of cierres) {
    const [tot] = await query(
      `SELECT COUNT(*) n, COALESCE(SUM(monto_pagado),0) m FROM Pagos
       WHERE deleted_at IS NULL AND cobrador_id=? AND fecha_pago>=? AND fecha_pago<?`,
      [c.cobrador_id, inicio, fin]
    );
    const pagosSuma = { n: Number(tot?.n || 0), m: num(tot?.m) };
    cierresRows.push({
      cobrador: labelCobrador(c.cobrador, c.cobrador_id),
      transacciones: Number(c.transacciones),
      monto_cierre: num(c.monto_efectivo),
      pagos_tx: pagosSuma.n,
      pagos_monto: pagosSuma.m,
      cuadra:
        Number(c.transacciones) === pagosSuma.n &&
        Math.abs(num(c.monto_efectivo) - pagosSuma.m) < 1.01,
      observaciones: c.observaciones || '',
    });
  }

  const renovRows = renovaciones.map((r) => ({
    cobrador: labelCobrador(r.cobrador),
    codigo: r.codigo,
    cliente: r.cliente,
    cedula: r.cedula || '',
    recibo: r.recibo || '',
    saldo_anterior: num(r.saldo_anterior),
    nuevo_monto: num(r.nuevo_monto),
    efectivo: num(r.efectivo),
    total_pagar: num(r.total_pagar),
    plazo: num(r.plazo_semanas),
    tasa_pct: num(r.tasa_pct),
    hora: fmtHora(r.fecha_renovacion),
  }));

  return {
    tipo: 'OPERACIONES DEL DÍA',
    fecha,
    pagos: pagosRows,
    renovaciones: renovRows,
    desembolsos: desRows,
    cierres: cierresRows,
    resumen: {
      pagos_tx: pagosRows.length,
      pagos_monto: Number(pagosRows.reduce((s, p) => s + p.monto, 0).toFixed(2)),
      pagos_renovacion_tx: pagosRows.filter((p) => p.es_renovacion === 'SI').length,
      renovaciones: renovRows.length,
      desembolsos_nuevos: desRows.filter((d) => d.tipo === 'NUEVO').length,
      desembolsos_renovacion: desRows.filter((d) => d.tipo === 'RENOVACION').length,
      monto_desembolsos: Number(desRows.reduce((s, d) => s + d.monto, 0).toFixed(2)),
      cierres_tx: cierresRows.reduce((s, c) => s + c.transacciones, 0),
      cierres_monto: Number(cierresRows.reduce((s, c) => s + c.monto_cierre, 0).toFixed(2)),
    },
    timestamp: new Date().toISOString(),
  };
}

function buildWorkbookOperacionesDia(datos) {
  const { fecha } = datos;
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      (datos.pagos || []).map((p) => ({
        Hora: p.hora,
        Cobrador: p.cobrador,
        Codigo: p.codigo,
        Cliente: p.cliente,
        Cedula: p.cedula,
        Recibo: p.recibo,
        Monto: p.monto,
        'Saldo antes': p.saldo_antes,
        'Saldo despues': p.saldo_despues,
        'Tipo cobro': p.tipo_cobro,
        Renovacion: p.es_renovacion,
        'Estado prestamo': p.estado_prestamo,
      }))
    ),
    'Pagos'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      (datos.renovaciones || []).map((r) => ({
        Hora: r.hora,
        Cobrador: r.cobrador,
        Codigo: r.codigo,
        Cliente: r.cliente,
        Cedula: r.cedula,
        Recibo: r.recibo,
        'Saldo anterior': r.saldo_anterior,
        'Nuevo monto': r.nuevo_monto,
        Efectivo: r.efectivo,
        'Total pagar': r.total_pagar,
        Plazo: r.plazo,
        'Tasa %': r.tasa_pct,
      }))
    ),
    'Renovaciones'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      (datos.desembolsos || []).map((d) => ({
        Tipo: d.tipo,
        Renovacion: d.es_renovacion,
        Cobrador: d.cobrador,
        Codigo: d.codigo,
        Cliente: d.cliente,
        Cedula: d.cedula,
        Recibo: d.recibo,
        Monto: d.monto,
        Plazo: d.plazo,
        'Tasa %': d.tasa_pct,
        'Total pagar': d.total_pagar,
        Saldo: d.saldo,
        'Dias cobro': d.dias_cobro,
      }))
    ),
    'Desembolsos'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      (datos.cierres || []).map((c) => ({
        Cobrador: c.cobrador,
        'Tx cierre': c.transacciones,
        'Monto cierre': c.monto_cierre,
        'Tx pagos': c.pagos_tx,
        'Monto pagos': c.pagos_monto,
        Cuadra: c.cuadra ? 'SI' : 'NO',
        Observaciones: c.observaciones,
      }))
    ),
    'Cierres'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { Concepto: 'Fecha', Valor: fecha },
      { Concepto: 'Pagos (tx)', Valor: datos.resumen?.pagos_tx },
      { Concepto: 'Pagos (monto)', Valor: datos.resumen?.pagos_monto },
      { Concepto: 'Pagos renovacion (tx)', Valor: datos.resumen?.pagos_renovacion_tx },
      { Concepto: 'Renovaciones', Valor: datos.resumen?.renovaciones },
      { Concepto: 'Desembolsos nuevos', Valor: datos.resumen?.desembolsos_nuevos },
      { Concepto: 'Desembolsos renovacion', Valor: datos.resumen?.desembolsos_renovacion },
      { Concepto: 'Monto desembolsado total', Valor: datos.resumen?.monto_desembolsos },
      { Concepto: 'Cierres (tx)', Valor: datos.resumen?.cierres_tx },
      { Concepto: 'Cierres (monto)', Valor: datos.resumen?.cierres_monto },
    ]),
    'Resumen'
  );

  return wb;
}

function workbookToBuffer(wb) {
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  cargarDatosOperacionesDia,
  buildWorkbookOperacionesDia,
  workbookToBuffer,
  labelCobrador,
  fmtHora,
  num,
  COB_LABEL,
};
