const { query } = require('../config/db');
const { hoyISO } = require('./zonaHoraria');
const { fechaVencimientoCredito } = require('./finanzasNube');

function parseDias(v) {
  if (!v) return ['LUNES'];
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    return ['LUNES'];
  }
}

/** Misma regla que finanzasNube.normalizarFechaDesembolso (DATE MySQL → YYYY-MM-DD). */
function fechaISO(valor) {
  if (valor == null || valor === '') return null;
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    const y = valor.getUTCFullYear();
    const m = String(valor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(valor.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(valor).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return null;
}

function diasEntre(desdeISO, hastaISO) {
  const a = new Date(`${desdeISO}T12:00:00`);
  const b = new Date(`${hastaISO}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function fechaProrrogaISO(v) {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

async function cargarHistorialProrrogas(prestamoIds) {
  if (!prestamoIds.length) return new Map();
  const ph = prestamoIds.map(() => '?').join(',');
  const rows = await query(
    `SELECT id, prestamo_id, semanas_extra, saldo_anterior, nueva_cuota_semanal,
            comentario, fecha_prorroga
     FROM Historial_Prorrogas
     WHERE prestamo_id IN (${ph}) AND deleted_at IS NULL
     ORDER BY fecha_prorroga DESC`,
    prestamoIds
  );
  const byPrestamo = new Map();
  for (const r of rows) {
    const item = {
      id: r.id,
      semanas_extra: Number(r.semanas_extra) || 0,
      saldo_anterior: Number(r.saldo_anterior) || 0,
      nueva_cuota_semanal: Number(r.nueva_cuota_semanal) || 0,
      comentario: r.comentario || null,
      fecha_prorroga: fechaProrrogaISO(r.fecha_prorroga),
    };
    if (!byPrestamo.has(r.prestamo_id)) byPrestamo.set(r.prestamo_id, []);
    byPrestamo.get(r.prestamo_id).push(item);
  }
  return byPrestamo;
}

async function armarReporteVencidos() {
  const hoy = hoyISO();
  const rows = await query(
    `SELECT p.id AS prestamo_id, p.fecha_desembolso, p.plazo_semanas, p.dias_de_cobro,
            p.periodicidad, p.monto_desembolsado, p.monto_total_pagar, p.saldo_pendiente,
            p.cuota_semanal_base, p.estado, p.cliente_id,
            c.id AS codigo_cliente, c.nombre_completo, c.cedula, c.telefono,
            u.nombre_completo AS cobrador,
            (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS total_pagos
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id AND c.deleted_at IS NULL
     LEFT JOIN Usuarios u ON c.cobrador_id = u.id
     WHERE p.estado = 'Activo' AND p.deleted_at IS NULL`
  );

  const filas = [];
  for (const p of rows) {
    const dias = parseDias(p.dias_de_cobro);
    const venc = fechaVencimientoCredito(p.fecha_desembolso, p.plazo_semanas, dias, {
      periodicidad: p.periodicidad,
      tipo_frecuencia: p.periodicidad,
    });
    if (!venc || hoy < venc) continue;
    const pagado = Number(p.total_pagos || 0);
    filas.push({
      id: p.prestamo_id,
      prestamo_id: p.prestamo_id,
      cliente_id: p.cliente_id,
      codigo_cliente: p.codigo_cliente,
      nombre_completo: p.nombre_completo,
      cedula: p.cedula,
      telefono: p.telefono,
      cobrador: p.cobrador || 'Sin asignar',
      fecha_desembolso: fechaISO(p.fecha_desembolso) || String(p.fecha_desembolso || '').slice(0, 10),
      fecha_vencimiento: venc,
      dias_vencido: diasEntre(venc, hoy),
      plazo_semanas: Number(p.plazo_semanas),
      dias_de_cobro: dias,
      periodicidad: p.periodicidad || 'SEMANAL',
      monto_desembolsado: Number(p.monto_desembolsado),
      monto_total_pagar: Number(p.monto_total_pagar),
      total_pagos: pagado,
      saldo_pendiente: Number(p.saldo_pendiente),
      cuota_semanal_base: Number(p.cuota_semanal_base),
      estado: p.estado,
      prorrogas_count: 0,
      semanas_prorroga_total: 0,
      ultima_prorroga: null,
      historial_prorrogas: [],
    });
  }

  const histMap = await cargarHistorialProrrogas(filas.map((f) => f.prestamo_id));
  for (const f of filas) {
    const hist = histMap.get(f.prestamo_id) || [];
    f.historial_prorrogas = hist;
    f.prorrogas_count = hist.length;
    f.semanas_prorroga_total = hist.reduce((s, h) => s + (Number(h.semanas_extra) || 0), 0);
    f.ultima_prorroga = hist[0] || null;
  }

  filas.sort((a, b) => b.dias_vencido - a.dias_vencido || b.saldo_pendiente - a.saldo_pendiente);

  const resumen = {
    cantidad: filas.length,
    con_prorroga: filas.filter((f) => f.prorrogas_count > 0).length,
    sin_prorroga: filas.filter((f) => f.prorrogas_count === 0).length,
    saldo_total: Number(filas.reduce((s, f) => s + f.saldo_pendiente, 0).toFixed(2)),
    capital_total: Number(filas.reduce((s, f) => s + f.monto_desembolsado, 0).toFixed(2)),
    pagado_total: Number(filas.reduce((s, f) => s + f.total_pagos, 0).toFixed(2)),
    semanas_prorroga_total: filas.reduce((s, f) => s + f.semanas_prorroga_total, 0),
  };

  return {
    tipo: 'PRÉSTAMOS VENCIDOS',
    corte: hoy,
    resumen,
    filas,
    cantidad: filas.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Enriquece filas de préstamos activos con vencimiento + historial de prórrogas.
 * Mutates/returns enriched copies suitable for la vista admin de Prórrogas.
 */
async function enriquecerPrestamosProrroga(rows) {
  const hoy = hoyISO();
  const ids = (rows || []).map((p) => p.id).filter(Boolean);
  const histMap = await cargarHistorialProrrogas(ids);
  const { calcularInteresMoraVencido } = require('./moraVencido');

  return (rows || []).map((p) => {
    const dias = parseDias(p.dias_de_cobro);
    const desembolso = fechaISO(p.fecha_desembolso);
    const venc = fechaVencimientoCredito(desembolso || p.fecha_desembolso, p.plazo_semanas, dias, {
      periodicidad: p.periodicidad,
      tipo_frecuencia: p.periodicidad,
    });
    const vencido = !!(venc && hoy >= venc);
    const hist = histMap.get(p.id) || [];
    const semanas_prorroga_total = hist.reduce((s, h) => s + (Number(h.semanas_extra) || 0), 0);
    const base = {
      id: p.id,
      cliente_id: p.cliente_id,
      nombre_completo: p.nombre_completo,
      cedula: p.cedula,
      telefono: p.telefono,
      cobrador: p.cobrador || null,
      monto_desembolsado: Number(p.monto_desembolsado),
      monto_total_pagar: Number(p.monto_total_pagar),
      saldo_pendiente: Number(p.saldo_pendiente),
      cuota_semanal_base: Number(p.cuota_semanal_base),
      plazo_semanas: Number(p.plazo_semanas),
      tasa_interes_aplicada: Number(p.tasa_interes_aplicada),
      estado: p.estado,
      periodicidad: p.periodicidad || 'SEMANAL',
      dias_de_cobro: dias,
      fecha_desembolso: desembolso,
      fecha_vencimiento: venc,
      vencido,
      dias_vencido: vencido && venc ? diasEntre(venc, hoy) : 0,
      historial_prorrogas: hist,
      prorrogas_count: hist.length,
      semanas_prorroga_total,
      ultima_prorroga: hist[0] || null,
    };
    const mora = calcularInteresMoraVencido(base, new Date(), {
      vencido,
      fechaVencimiento: venc,
      prorrogasCount: hist.length,
    });
    return {
      ...base,
      mora_aplica: mora.aplica,
      interes_mora: mora.montoMora,
      semanas_mora: mora.semanasVencidas,
      saldo_con_mora: mora.aplica ? mora.saldoConMora : Number(p.saldo_pendiente),
      mora_mensaje: mora.mensaje,
    };
  });
}

module.exports = { armarReporteVencidos, enriquecerPrestamosProrroga, cargarHistorialProrrogas };
