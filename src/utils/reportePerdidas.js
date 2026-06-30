const { query } = require('../config/db');
const { rangoPeriodoLocal } = require('./fechasSql');

function fmtFecha(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

function fmtFechaHora(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().replace('T', ' ').slice(0, 19);
}

async function armarReportePerdidas(desde, hasta) {
  const { inicio, fin } = rangoPeriodoLocal(desde, hasta);

  const filas = await query(
    `SELECT cp.id, cp.prestamo_id, cp.motivo, cp.monto_perdida, cp.saldo_anterior,
            cp.monto_desembolsado, cp.monto_pagado_acumulado, cp.dias_vencido,
            cp.fecha_vencimiento, cp.fecha_castigo,
            c.id AS codigo_cliente, c.nombre_completo, c.cedula, c.telefono,
            u.nombre_completo AS admin_nombre,
            ua.nombre_completo AS cobrador,
            p.monto_total_pagar
     FROM Castigos_Perdida cp
     JOIN Clientes c ON cp.cliente_id = c.id AND c.deleted_at IS NULL
     LEFT JOIN Usuarios u ON cp.admin_id = u.id
     LEFT JOIN Prestamos p ON cp.prestamo_id = p.id
     LEFT JOIN Usuarios ua ON c.cobrador_id = ua.id
     WHERE cp.deleted_at IS NULL
       AND cp.fecha_castigo >= ? AND cp.fecha_castigo < ?
     ORDER BY cp.fecha_castigo DESC`,
    [inicio, fin]
  );

  const rows = filas.map((r) => ({
    codigo_cliente: r.codigo_cliente,
    nombre_completo: r.nombre_completo,
    cedula: r.cedula,
    telefono: r.telefono,
    cobrador: r.cobrador || 'Sin asignar',
    prestamo_id: r.prestamo_id,
    monto_desembolsado: Number(r.monto_desembolsado),
    monto_total_pagar: Number(r.monto_total_pagar || 0),
    monto_pagado_acumulado: Number(r.monto_pagado_acumulado),
    saldo_anterior: Number(r.saldo_anterior ?? r.monto_perdida),
    monto_perdida: Number(r.monto_perdida),
    dias_vencido: Number(r.dias_vencido || 0),
    fecha_vencimiento: fmtFecha(r.fecha_vencimiento),
    fecha_castigo: fmtFechaHora(r.fecha_castigo),
    motivo: r.motivo,
    admin_nombre: r.admin_nombre || 'Administrador',
  }));

  const resumen = {
    cantidad: rows.length,
    monto_perdido_total: Number(rows.reduce((s, f) => s + f.monto_perdida, 0).toFixed(2)),
    capital_afectado: Number(rows.reduce((s, f) => s + f.monto_desembolsado, 0).toFixed(2)),
    pagado_antes_castigo: Number(rows.reduce((s, f) => s + f.monto_pagado_acumulado, 0).toFixed(2)),
  };

  return {
    tipo: 'CASTIGOS A PÉRDIDA',
    periodo: { desde, hasta },
    resumen,
    filas: rows,
    cantidad: rows.length,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { armarReportePerdidas };
