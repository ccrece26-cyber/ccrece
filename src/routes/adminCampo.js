const { query, getConnection } = require('../config/db');
const { loadAgendaAdminHoy } = require('../utils/rutaDiariaAdmin');
const { calcularLiquidacionAnticipada } = require('../utils/finanzasNube');
const { registrarPagoEnNube, registrarGestionNoPagoEnNube } = require('../utils/registrarPagoNube');
const { capMontoAlSaldo } = require('../utils/cobroMontos');
const { seleccionarCuotaAgenda, montoCobroDelDia } = require('../utils/cuotasCalendario');
const { montoVisitaHoy, esCuotaDiaDesembolso } = require('../utils/diasCobro');
const { hoyISO } = require('../utils/zonaHoraria');
const {
  ensureRutaForOperador,
  agregarClienteARuta,
  quitarClienteDeRutaOperador,
  optimizarOrdenRuta,
  listarIdsClientesEnRuta,
} = require('../utils/rutas');

async function resolveAdmin(adminId) {
  if (!adminId) throw new Error('admin_id requerido');
  const rows = await query(
    `SELECT u.id, u.nombre_completo FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id
     WHERE u.id = ? AND r.nombre = 'ADMIN' AND u.activo = 1 AND u.deleted_at IS NULL
     LIMIT 1`,
    [adminId]
  );
  if (!rows.length) throw new Error('Administrador no encontrado');
  return rows[0];
}

async function getAgendaCampo(req, res) {
  try {
    const adminId = req.query.admin_id || null;
    const alcance = req.query.alcance === 'ruta' ? 'ruta' : 'todos';
    if (alcance === 'ruta' && !adminId) {
      return res.status(400).json({ success: false, message: 'admin_id requerido para alcance=ruta' });
    }
    const payload = await loadAgendaAdminHoy({ adminId, alcance });
    return res.json({ success: true, ...payload });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function getMiRutaCampo(req, res) {
  try {
    const adminId = req.query.admin_id;
    const admin = await resolveAdmin(adminId);
    const rutaId = await ensureRutaForOperador(
      admin.id,
      admin.nombre_completo,
      'Ruta campo administrador — Esteli'
    );
    const clientes = await query(
      `SELECT c.id, c.cedula, c.nombre_completo, c.telefono, c.direccion,
              rc.orden_visita, u.nombre_completo AS cobrador_asignado
       FROM Ruta_Clientes rc
       JOIN Clientes c ON rc.cliente_id = c.id AND c.deleted_at IS NULL
       LEFT JOIN Usuarios u ON c.cobrador_id = u.id
       WHERE rc.ruta_id = ?
       ORDER BY rc.orden_visita ASC, c.nombre_completo ASC`,
      [rutaId]
    );
    return res.json({
      success: true,
      data: {
        ruta_id: rutaId,
        admin_id: admin.id,
        cliente_ids: clientes.map((c) => c.id),
        clientes,
      },
    });
  } catch (e) {
    const code = e.message.includes('requerido') || e.message.includes('no encontrado') ? 400 : 500;
    return res.status(code).json({ success: false, message: e.message });
  }
}

async function postClienteMiRutaCampo(req, res) {
  try {
    const { admin_id: adminId, cliente_id: clienteId } = req.body || {};
    const admin = await resolveAdmin(adminId);
    if (!clienteId) return res.status(400).json({ success: false, message: 'cliente_id requerido' });

    const [cl] = await query(`SELECT id FROM Clientes WHERE id = ? AND deleted_at IS NULL`, [clienteId]);
    if (!cl) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    const rutaId = await ensureRutaForOperador(
      admin.id,
      admin.nombre_completo,
      'Ruta campo administrador — Esteli'
    );
    await agregarClienteARuta(rutaId, clienteId);
    await optimizarOrdenRuta(rutaId);
    const cliente_ids = await listarIdsClientesEnRuta(admin.id);
    return res.json({
      success: true,
      ruta_id: rutaId,
      cliente_ids,
      mensaje: 'Cliente agregado a su ruta campo (sin cambiar cobrador asignado)',
    });
  } catch (e) {
    const code = e.message.includes('requerido') || e.message.includes('no encontrado') ? 400 : 500;
    return res.status(code).json({ success: false, message: e.message });
  }
}

async function deleteClienteMiRutaCampo(req, res) {
  try {
    const adminId = req.query.admin_id;
    const { clienteId } = req.params;
    await resolveAdmin(adminId);
    if (!clienteId) return res.status(400).json({ success: false, message: 'cliente_id requerido' });

    const ok = await quitarClienteDeRutaOperador(adminId, clienteId);
    const cliente_ids = await listarIdsClientesEnRuta(adminId);
    return res.json({
      success: true,
      removido: ok,
      cliente_ids,
      mensaje: ok ? 'Cliente quitado de su ruta campo' : 'El cliente no estaba en su ruta',
    });
  } catch (e) {
    const code = e.message.includes('requerido') || e.message.includes('no encontrado') ? 400 : 500;
    return res.status(code).json({ success: false, message: e.message });
  }
}

async function putOptimizarMiRutaCampo(req, res) {
  try {
    const { admin_id: adminId } = req.body || {};
    const admin = await resolveAdmin(adminId);
    const rutaId = await ensureRutaForOperador(
      admin.id,
      admin.nombre_completo,
      'Ruta campo administrador — Esteli'
    );
    await optimizarOrdenRuta(rutaId);
    return res.json({ success: true, ruta_id: rutaId, mensaje: 'Orden de visita optimizado' });
  } catch (e) {
    const code = e.message.includes('requerido') || e.message.includes('no encontrado') ? 400 : 500;
    return res.status(code).json({ success: false, message: e.message });
  }
}

async function getResumenCobroCampo(req, res) {
  try {
    const { prestamoId } = req.params;
    const conn = await getConnection();
    try {
      const [prestRows] = await conn.execute(
        `SELECT * FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [prestamoId]
      );
      if (!prestRows.length) {
        return res.status(404).json({ success: false, message: 'Prestamo no encontrado' });
      }
      const prestamo = prestRows[0];
      const hoy = hoyISO();
      const [cuotasPend] = await conn.execute(
        `SELECT id, monto_programado, monto_pagado, fecha_programada, estado
         FROM Cuotas_Calendario
         WHERE prestamo_id = ? AND estado IN ('Programada', 'Parcial') AND deleted_at IS NULL
         ORDER BY fecha_programada ASC`,
        [prestamoId]
      );
      const cuotaSel = seleccionarCuotaAgenda(
        cuotasPend,
        prestamo,
        hoy,
        esCuotaDiaDesembolso,
        montoVisitaHoy
      );
      const cuotaDiaRaw = montoCobroDelDia(cuotaSel, prestamo, montoVisitaHoy);
      const cuotaDia = capMontoAlSaldo(cuotaDiaRaw, prestamo.saldo_pendiente);
      const [pend] = await conn.execute(
        `SELECT COUNT(*) AS n FROM Cuotas_Calendario
         WHERE prestamo_id = ? AND estado IN ('Programada', 'Parcial') AND deleted_at IS NULL`,
        [prestamoId]
      );
      const [ultimaCuota] = await conn.execute(
        `SELECT MAX(fecha_programada) AS ultima_fecha_cuota
         FROM Cuotas_Calendario
         WHERE prestamo_id = ? AND deleted_at IS NULL`,
        [prestamoId]
      );
      const [pagadoRows] = await conn.execute(
        `SELECT COALESCE(SUM(monto_pagado), 0) AS total FROM Pagos
         WHERE prestamo_id = ? AND deleted_at IS NULL`,
        [prestamoId]
      );
      const pagadoAcumulado = Number(pagadoRows[0]?.total || 0);
      return res.json({
        success: true,
        data: {
          prestamo,
          cuotaDia,
          cuotasPendientes: pend[0]?.n || 0,
          ultima_fecha_cuota: ultimaCuota[0]?.ultima_fecha_cuota || null,
          liquidacion: calcularLiquidacionAnticipada(prestamo, new Date(), { pagadoAcumulado }),
        },
      });
    } finally {
      conn.release();
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function postPagoCampo(req, res) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const result = await registrarPagoEnNube(conn, req.body);
    await conn.commit();
    return res.json({ success: true, ...result });
  } catch (e) {
    await conn.rollback();
    return res.status(400).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function postGestionNoPagoCampo(req, res) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const result = await registrarGestionNoPagoEnNube(conn, req.body);
    await conn.commit();
    return res.json({ success: true, ...result });
  } catch (e) {
    await conn.rollback();
    return res.status(400).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

/**
 * Busca créditos activos para cobrar fuera del día de cobro (modo campo admin).
 * alcance=ruta: solo clientes en la ruta campo del admin.
 * alcance=todos (default): toda la cartera.
 */
async function getBuscarClientesCampo(req, res) {
  try {
    const adminId = req.query.admin_id || null;
    const alcance = req.query.alcance === 'ruta' ? 'ruta' : 'todos';
    const texto = String(req.query.q || '').trim().toLowerCase();
    const hoy = hoyISO();
    const { inicio: diaIni, fin: diaFin } = require('../utils/fechasSql').rangoDiaLocal(hoy);
    const { debeIncluirEnAgenda } = require('../utils/diasCobro');

    if (alcance === 'ruta' && !adminId) {
      return res.status(400).json({ success: false, message: 'admin_id requerido para alcance=ruta' });
    }

    let rows;
    if (alcance === 'ruta') {
      rows = await query(
        `SELECT c.id AS cliente_id, c.nombre_completo, c.telefono, c.direccion, c.cedula,
                c.latitud, c.longitud, COALESCE(rc.orden_visita, 999) AS orden_visita,
                u.nombre_completo AS cobrador_asignado,
                p.id AS prestamo_id, p.saldo_pendiente, p.cuota_semanal_base, p.dias_de_cobro,
                p.monto_total_pagar, p.estado AS estado_prestamo, p.fecha_desembolso,
                p.plazo_semanas, p.periodicidad
         FROM Clientes c
         INNER JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
         INNER JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
         INNER JOIN Rutas r ON rc.ruta_id = r.id AND r.cobrador_id = ? AND r.activa = 1 AND r.deleted_at IS NULL
         LEFT JOIN Usuarios u ON c.cobrador_id = u.id AND u.deleted_at IS NULL
         WHERE c.deleted_at IS NULL
         ORDER BY c.nombre_completo ASC
         LIMIT 200`,
        [adminId]
      );
    } else {
      rows = await query(
        `SELECT c.id AS cliente_id, c.nombre_completo, c.telefono, c.direccion, c.cedula,
                c.latitud, c.longitud, 999 AS orden_visita,
                u.nombre_completo AS cobrador_asignado,
                p.id AS prestamo_id, p.saldo_pendiente, p.cuota_semanal_base, p.dias_de_cobro,
                p.monto_total_pagar, p.estado AS estado_prestamo, p.fecha_desembolso,
                p.plazo_semanas, p.periodicidad
         FROM Clientes c
         INNER JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
         LEFT JOIN Usuarios u ON c.cobrador_id = u.id AND u.deleted_at IS NULL
         WHERE c.deleted_at IS NULL
         ORDER BY c.nombre_completo ASC
         LIMIT 400`
      );
    }

    const cobradosHoy = await query(
      `SELECT DISTINCT prestamo_id FROM Pagos
       WHERE deleted_at IS NULL AND fecha_pago >= ? AND fecha_pago < ?`,
      [diaIni, diaFin]
    );
    const yaCobrados = new Set(cobradosHoy.map((r) => r.prestamo_id));

    const fuera = [];
    for (const row of rows || []) {
      if (yaCobrados.has(row.prestamo_id)) continue;
      const tocaHoy = debeIncluirEnAgenda(hoy, {
        fecha_desembolso: row.fecha_desembolso,
        dias_de_cobro: row.dias_de_cobro,
        periodicidad: row.periodicidad,
      });
      if (tocaHoy) continue;
      if (texto) {
        const hay = [row.nombre_completo, row.cedula, row.cliente_id, row.direccion, row.telefono]
          .map((x) => String(x || '').toLowerCase())
          .some((s) => s.includes(texto));
        if (!hay) continue;
      }
      const montoRaw = montoVisitaHoy(row.cuota_semanal_base, row.dias_de_cobro, {
        periodicidad: row.periodicidad,
      });
      fuera.push({
        cliente_id: row.cliente_id,
        codigo_cliente: row.cliente_id,
        nombre_completo: row.nombre_completo,
        telefono: row.telefono,
        direccion: row.direccion,
        cedula: row.cedula,
        latitud: row.latitud != null ? Number(row.latitud) : null,
        longitud: row.longitud != null ? Number(row.longitud) : null,
        orden_visita: row.orden_visita,
        cobrador_asignado: row.cobrador_asignado || null,
        prestamo_id: row.prestamo_id,
        estado_prestamo: row.estado_prestamo,
        saldo_pendiente: Number(row.saldo_pendiente),
        cuota_semanal_base: row.cuota_semanal_base,
        dias_de_cobro: row.dias_de_cobro,
        monto_total_pagar: row.monto_total_pagar,
        fecha_desembolso: row.fecha_desembolso,
        plazo_semanas: row.plazo_semanas,
        cuota_id: `visita-${row.prestamo_id}`,
        monto_programado: capMontoAlSaldo(montoRaw, row.saldo_pendiente),
        monto_sugerido: capMontoAlSaldo(montoRaw, row.saldo_pendiente),
        monto_pagado: 0,
        fecha_programada: hoy,
        estado_cuota: 'Programada',
        tipo_visita: 'activo',
        estado_visita: 'pendiente',
        etiqueta_visita: 'Fuera de día',
        fuera_de_dia: true,
      });
      if (fuera.length >= 50) break;
    }

    return res.json({ success: true, data: { clientes: fuera, total: fuera.length } });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

module.exports = {
  getAgendaCampo,
  getMiRutaCampo,
  postClienteMiRutaCampo,
  deleteClienteMiRutaCampo,
  putOptimizarMiRutaCampo,
  getResumenCobroCampo,
  postPagoCampo,
  postGestionNoPagoCampo,
  getBuscarClientesCampo,
};
