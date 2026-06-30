const { query, getConnection } = require('../config/db');
const { loadAgendaAdminHoy } = require('../utils/rutaDiariaAdmin');
const { calcularLiquidacionAnticipada } = require('../utils/finanzasNube');
const { registrarPagoEnNube, registrarGestionNoPagoEnNube } = require('../utils/registrarPagoNube');
const { capMontoAlSaldo } = require('../utils/cobroMontos');
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
      const [cuotaPend] = await conn.execute(
        `SELECT id, monto_programado, monto_pagado, fecha_programada, estado
         FROM Cuotas_Calendario
         WHERE prestamo_id = ? AND estado IN ('Programada', 'Parcial') AND deleted_at IS NULL
         ORDER BY fecha_programada ASC LIMIT 1`,
        [prestamoId]
      );
      const cuota = cuotaPend[0];
      const cuotaDiaRaw = cuota
        ? Math.max(0, Number((Number(cuota.monto_programado) - Number(cuota.monto_pagado || 0)).toFixed(2)))
        : 0;
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

module.exports = {
  getAgendaCampo,
  getMiRutaCampo,
  postClienteMiRutaCampo,
  deleteClienteMiRutaCampo,
  putOptimizarMiRutaCampo,
  getResumenCobroCampo,
  postPagoCampo,
  postGestionNoPagoCampo,
};
