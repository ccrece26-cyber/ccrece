const { query } = require('../config/db');
const { leerParametrosFinancieros } = require('../utils/parametrosFinancieros');
const { initSecuenciaCliente } = require('../utils/clienteId');
const { etiquetaVisitaDesdePago } = require('./visitaEtiquetas');
const {
  diaCobroHoy,
  montoVisitaHoy,
  debeSugerirCobroEnFecha,
  esCuotaDiaDesembolso,
  fechaCalendarioISO,
} = require('./diasCobro');
const { rangoDiaLocal } = require('../utils/fechasSql');
const { capMontoAlSaldo } = require('./cobroMontos');
const { seleccionarCuotaAgenda, montoCobroDelDia } = require('./cuotasCalendario');

/**
 * Ruta del día para administrador.
 * @param {{ adminId?: string, alcance?: 'todos'|'ruta' }} opciones
 *   - alcance `ruta`: solo clientes en la ruta campo del admin (requiere adminId)
 *   - alcance `todos`: toda la cartera activa con cobro hoy (default)
 */
async function loadAgendaAdminHoy(opciones = {}) {
    const { adminId, alcance = 'todos' } = opciones;
    const soloRuta = alcance === 'ruta' && adminId;
    const hoy = fechaCalendarioISO();
    const { inicio: diaIni, fin: diaFin } = rangoDiaLocal(hoy);
    await initSecuenciaCliente(query);
    const secRows = await query(`SELECT valor FROM Parametros_Globales WHERE clave = 'SEC_CLIENTE'`);
    const secuencia = secRows[0]?.valor || '0';

    let clientes;
    if (soloRuta) {
      clientes = await query(
        `SELECT DISTINCT c.*,
                COALESCE(rc.orden_visita, 999) AS orden_visita,
                rc.ruta_id,
                u.nombre_completo AS cobrador_asignado,
                c.cobrador_id AS cobrador_asignado_id
         FROM Clientes c
         INNER JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
         INNER JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
         INNER JOIN Rutas r ON rc.ruta_id = r.id AND r.cobrador_id = ? AND r.activa = 1 AND r.deleted_at IS NULL
         LEFT JOIN Usuarios u ON c.cobrador_id = u.id AND u.deleted_at IS NULL
         WHERE c.deleted_at IS NULL
         ORDER BY orden_visita ASC, c.nombre_completo ASC`,
        [adminId]
      );
    } else {
      clientes = await query(
        `SELECT DISTINCT c.*,
                COALESCE(rc_admin.orden_visita, rc.orden_visita, 999) AS orden_visita,
                COALESCE(rc_admin.ruta_id, rc.ruta_id) AS ruta_id,
                u.nombre_completo AS cobrador_asignado,
                c.cobrador_id AS cobrador_asignado_id
         FROM Clientes c
         INNER JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
         LEFT JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
         LEFT JOIN Rutas r ON rc.ruta_id = r.id AND r.activa = 1 AND r.deleted_at IS NULL
         LEFT JOIN Ruta_Clientes rc_admin ON c.id = rc_admin.cliente_id
           AND rc_admin.ruta_id = CONCAT('RUTA-', ?)
         LEFT JOIN Usuarios u ON c.cobrador_id = u.id AND u.deleted_at IS NULL
         WHERE c.deleted_at IS NULL
         ORDER BY orden_visita ASC, c.nombre_completo ASC`,
        [adminId || '']
      );
    }

    const rutas = await query(
      `SELECT * FROM Rutas WHERE activa = 1 AND deleted_at IS NULL ORDER BY cobrador_id`
    );

    const rutaIds = rutas.map((r) => r.id);
    let ruta_clientes = [];
    if (rutaIds.length) {
      const ph = rutaIds.map(() => '?').join(',');
      ruta_clientes = await query(
        `SELECT rc.ruta_id, rc.cliente_id, rc.orden_visita FROM Ruta_Clientes rc WHERE rc.ruta_id IN (${ph})`,
        rutaIds
      );
    }

    const clienteIds = clientes.map((c) => c.id);
    let prestamos = [];
    let cuotas = [];
    let fiadores = [];

    if (clienteIds.length) {
      const ph2 = clienteIds.map(() => '?').join(',');
      const activosRows = await query(
        `SELECT * FROM Prestamos WHERE cliente_id IN (${ph2}) AND estado = 'Activo' AND deleted_at IS NULL
         ORDER BY fecha_desembolso DESC`,
        clienteIds
      );
      const activoPorCliente = new Map();
      for (const p of activosRows) {
        if (!activoPorCliente.has(p.cliente_id)) activoPorCliente.set(p.cliente_id, p);
      }
      prestamos = [...activoPorCliente.values()];
      const prestamoIds = prestamos.map((p) => p.id);
      if (prestamoIds.length) {
        const ph3 = prestamoIds.map(() => '?').join(',');
        cuotas = await query(
          `SELECT * FROM Cuotas_Calendario
           WHERE prestamo_id IN (${ph3}) AND estado IN ('Programada','Parcial')
             AND fecha_programada <= ? AND deleted_at IS NULL
           ORDER BY fecha_programada`,
          [...prestamoIds, hoy]
        );
        const fiadorIds = [...new Set(prestamos.map((p) => p.fiador_id).filter(Boolean))];
        if (fiadorIds.length) {
          const phF = fiadorIds.map(() => '?').join(',');
          fiadores = await query(`SELECT * FROM Fiadores WHERE id IN (${phF}) AND deleted_at IS NULL`, fiadorIds);
        } else {
          fiadores = await query(
            `SELECT * FROM Fiadores WHERE cliente_id IN (${ph2}) AND deleted_at IS NULL`,
            clienteIds
          );
        }
      }
    }

    const hoyDia = diaCobroHoy();
    const agenda = [];
    let pagos_hoy = [];
    let gestiones_hoy = [];

    if (clienteIds.length) {
      const ph2 = clienteIds.map(() => '?').join(',');
      gestiones_hoy = await query(
        `SELECT g.*, p.cliente_id
         FROM Gestiones_No_Pago g
         INNER JOIN Prestamos p ON g.prestamo_id = p.id
         WHERE g.fecha_gestion >= ? AND g.fecha_gestion < ?
           AND g.deleted_at IS NULL
           AND p.cliente_id IN (${ph2})`,
        [diaIni, diaFin, ...clienteIds]
      );
    }

    pagos_hoy = await query(
      `SELECT pg.*, p.cliente_id, p.estado, p.saldo_pendiente, p.fecha_desembolso, p.plazo_semanas,
              p.dias_de_cobro, c.nombre_completo, c.telefono
       FROM Pagos pg
       INNER JOIN Prestamos p ON pg.prestamo_id = p.id
       INNER JOIN Clientes c ON p.cliente_id = c.id
       WHERE pg.fecha_pago >= ? AND pg.fecha_pago < ?
         AND pg.deleted_at IS NULL AND c.deleted_at IS NULL
         ${soloRuta ? 'AND c.cobrador_id = ?' : ''}`,
      soloRuta ? [diaIni, diaFin, adminId] : [diaIni, diaFin]
    );

    const prestamoPorId = new Map(prestamos.map((p) => [p.id, p]));
    let clienteMap = new Map(clientes.map((c) => [c.id, c]));

    const extraPrestamoIds = [
      ...new Set(pagos_hoy.map((pg) => pg.prestamo_id).filter((id) => id && !prestamoPorId.has(id))),
    ];
    if (extraPrestamoIds.length) {
      const phE = extraPrestamoIds.map(() => '?').join(',');
      const extras = await query(
        `SELECT * FROM Prestamos WHERE id IN (${phE}) AND deleted_at IS NULL`,
        extraPrestamoIds
      );
      for (const p of extras) {
        prestamoPorId.set(p.id, p);
        prestamos.push(p);
      }
    }

    const extraClienteIds = [
      ...new Set(pagos_hoy.map((pg) => pg.cliente_id).filter((id) => id && !clienteMap.has(id))),
    ];
    if (extraClienteIds.length) {
      const phC = extraClienteIds.map(() => '?').join(',');
      const extrasC = await query(
        `SELECT c.*, COALESCE(rc.orden_visita, 999) AS orden_visita,
                u.nombre_completo AS cobrador_asignado, c.cobrador_id AS cobrador_asignado_id
         FROM Clientes c
         LEFT JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
         LEFT JOIN Usuarios u ON c.cobrador_id = u.id
         WHERE c.id IN (${phC}) AND c.deleted_at IS NULL`,
        extraClienteIds
      );
      for (const c of extrasC) {
        clienteMap.set(c.id, c);
        clientes.push(c);
      }
    }

    const pagoPorPrestamo = new Map(pagos_hoy.map((pg) => [pg.prestamo_id, pg]));
    const gestionPorPrestamo = new Map(gestiones_hoy.map((g) => [g.prestamo_id, g]));
    const prestamosEnAgenda = new Set();

    const estadoVisitaDesdePago = (prestamoId) => {
      const pg = pagoPorPrestamo.get(prestamoId);
      if (!pg) return null;
      if (Number(pg.registrado_por_admin) === 1) return 'cobrado_admin';
      return 'cobrado';
    };

    const pushAgendaItem = (c, p, cuotaPend, extra = {}) => {
      if (!p?.id || prestamosEnAgenda.has(p.id)) return;
      prestamosEnAgenda.add(p.id);
      const montoDiaRaw = montoCobroDelDia(cuotaPend, p, montoVisitaHoy);
      const montoDia = capMontoAlSaldo(montoDiaRaw, p.saldo_pendiente);
      const ev =
        extra.estado_visita ??
        (pagoPorPrestamo.has(p.id)
          ? estadoVisitaDesdePago(p.id)
          : gestionPorPrestamo.has(p.id)
            ? 'no_pago'
            : 'pendiente');
      agenda.push({
        cuota_id: cuotaPend?.id || `visita-${p.id}`,
        prestamo_id: p.id,
        monto_programado: extra.monto_programado ?? montoDia,
        monto_pagado: cuotaPend?.monto_pagado || extra.monto_pagado || 0,
        fecha_programada: cuotaPend?.fecha_programada || hoy,
        estado_cuota: cuotaPend?.estado || extra.estado_cuota || 'Programada',
        cliente_id: c.id,
        codigo_cliente: c.id,
        nombre_completo: c.nombre_completo,
        telefono: c.telefono,
        direccion: c.direccion,
        cedula: c.cedula,
        latitud: c.latitud,
        longitud: c.longitud,
        orden_visita: c.orden_visita,
        saldo_pendiente: p.saldo_pendiente,
        cuota_semanal_base: p.cuota_semanal_base,
        dias_de_cobro: p.dias_de_cobro,
        fecha_desembolso: p.fecha_desembolso,
        plazo_semanas: p.plazo_semanas,
        monto_total_pagar: p.monto_total_pagar,
        estado_prestamo: p.estado,
        dia_cobro: hoyDia,
        cobrador_asignado: c.cobrador_asignado || null,
        cobrador_asignado_id: c.cobrador_asignado_id || c.cobrador_id || null,
        tipo_visita: extra.tipo_visita || 'activo',
        etiqueta_visita:
          extra.etiqueta_visita ||
          etiquetaVisitaDesdePago(pagoPorPrestamo.get(p.id), extra.tipo_visita === 'liquidado') ||
          (ev === 'cobrado_admin' ? 'Cobrado por administrador' : null),
        estado_visita: ev,
        pago_hoy_id: extra.pago_hoy_id ?? pagoPorPrestamo.get(p.id)?.id ?? null,
      });
    };

    for (const c of clientes) {
      const p = prestamos.find((x) => x.cliente_id === c.id && x.estado === 'Activo');
      if (p && debeSugerirCobroEnFecha(hoy, p)) {
        const cuotasPrestamo = cuotas.filter((cc) => cc.prestamo_id === p.id);
        const cuotaPend = seleccionarCuotaAgenda(
          cuotasPrestamo,
          p,
          hoy,
          esCuotaDiaDesembolso,
          montoVisitaHoy
        );
        pushAgendaItem(c, p, cuotaPend);
      }
    }

    for (const pg of pagos_hoy) {
      if (prestamosEnAgenda.has(pg.prestamo_id)) continue;
      const c = clienteMap.get(pg.cliente_id);
      const pExtra = prestamoPorId.get(pg.prestamo_id);
      if (!c || !pExtra) continue;
      const esLiquidacion =
        pExtra.estado === 'Pagado' || Number(pExtra.saldo_pendiente || 0) <= 0.01;
      const ev = Number(pg.registrado_por_admin) === 1 ? 'cobrado_admin' : 'cobrado';
      pushAgendaItem(c, pExtra, null, {
        monto_programado: Number(pg.monto_pagado),
        monto_pagado: Number(pg.monto_pagado),
        estado_cuota: 'Pagada',
        tipo_visita: esLiquidacion ? 'liquidado' : 'cobrado',
        etiqueta_visita: etiquetaVisitaDesdePago(pg, esLiquidacion) || 'Cobro registrado',
        estado_visita: ev,
        pago_hoy_id: pg.id,
      });
    }

    agenda.sort((a, b) => {
      if (a.tipo_visita === 'liquidado' && b.tipo_visita !== 'liquidado') return -1;
      if (a.tipo_visita !== 'liquidado' && b.tipo_visita === 'liquidado') return 1;
      const o = (a.orden_visita ?? 999) - (b.orden_visita ?? 999);
      if (o !== 0) return o;
      return String(a.nombre_completo || '').localeCompare(String(b.nombre_completo || ''));
    });

    return {
      serverTime: new Date().toISOString(),
      secuencia,
      dia_cobro: hoyDia,
      vista_admin: true,
      alcance: soloRuta ? 'ruta' : 'todos',
      admin_id: adminId || null,
      parametros_financieros: await leerParametrosFinancieros(query),
      data: { rutas, ruta_clientes, clientes, prestamos, cuotas, fiadores, agenda, pagos_hoy, gestiones_hoy },
    };
}

async function buildRutaDiariaAdmin(req, res) {
  try {
    const adminId = req.query.admin_id || req.params.cobradorId || null;
    const alcance = req.query.alcance === 'ruta' ? 'ruta' : 'todos';
    const payload = await loadAgendaAdminHoy({ adminId, alcance });
    return res.json({ success: true, ...payload });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

module.exports = { buildRutaDiariaAdmin, loadAgendaAdminHoy };
