const { getConnection } = require('../config/db');
const { exigirUsuarioActivo, responderErrorUsuario } = require('../utils/assertUsuarioActivo');
const { aplicarMontoACuotas } = require('../utils/registrarPagoNube');
const { voidarCuotasRestantesAlCerrar } = require('../utils/cobroMontos');
const { rangoDiaLocal } = require('../utils/fechasSql');

/**
 * @deprecated Prefer POST /api/cobrador/sync/push (cobradorEngine en la app).
 * Recibe lote de pagos offline desde SQLite y los persiste en TiDB Cloud.
 */
async function syncMasivo(req, res) {
  const { pagos } = req.body;
  if (!Array.isArray(pagos) || pagos.length === 0) {
    return res.status(400).json({ success: false, message: 'Lista de pagos vacía.' });
  }

  try {
    const cobId = req.operadorId || pagos[0]?.cobrador_id;
    await exigirUsuarioActivo(cobId);
  } catch (e) {
    return responderErrorUsuario(res, e);
  }

  const conn = await getConnection();
  const omitidos = [];
  try {
    await conn.beginTransaction();
    let procesados = 0;

    for (const pago of pagos) {
      const [existente] = await conn.execute(
        'SELECT id FROM Pagos WHERE id = ? AND deleted_at IS NULL',
        [pago.id]
      );
      if (existente.length > 0) {
        omitidos.push({ id: pago.id, code: 'pago_ya_existe', message: 'Pago ya registrado en nube.' });
        continue;
      }

      const [prestamoOk] = await conn.execute(
        'SELECT id, saldo_pendiente FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1',
        [pago.prestamo_id]
      );
      if (!prestamoOk.length) {
        omitidos.push({ id: pago.id, code: 'prestamo_no_existe', message: 'Préstamo no encontrado.' });
        continue;
      }

      const { inicio, fin } = rangoDiaLocal(pago.fecha_pago || new Date());
      const [cobroHoy] = await conn.execute(
        `SELECT id FROM Pagos WHERE prestamo_id = ? AND deleted_at IS NULL
           AND fecha_pago >= ? AND fecha_pago < ? LIMIT 1`,
        [pago.prestamo_id, inicio, fin]
      );
      if (cobroHoy.length) {
        omitidos.push({
          id: pago.id,
          code: 'cobro_ya_registrado',
          message: 'Este crédito ya tiene un cobro registrado hoy.',
          pago_existente_id: cobroHoy[0].id,
        });
        continue;
      }

      const monto = Number(pago.monto_pagado);
      const prestamo = prestamoOk[0];

      await conn.execute(
        `INSERT INTO Pagos (id, prestamo_id, cobrador_id, monto_pagado, fecha_pago, latitud, longitud, is_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          pago.id,
          pago.prestamo_id,
          pago.cobrador_id,
          monto,
          pago.fecha_pago,
          pago.latitud,
          pago.longitud,
        ]
      );

      await aplicarMontoACuotas(conn, pago.prestamo_id, monto);
      const nuevoSaldo = Math.max(0, Number((Number(prestamo.saldo_pendiente) - monto).toFixed(2)));
      const estadoPrestamo = nuevoSaldo <= 0.01 ? 'Pagado' : 'Activo';
      if (estadoPrestamo === 'Pagado') {
        await voidarCuotasRestantesAlCerrar(conn, pago.prestamo_id);
      }
      await conn.execute(
        `UPDATE Prestamos SET saldo_pendiente = ?, estado = ?, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
        [nuevoSaldo, estadoPrestamo, pago.prestamo_id]
      );

      procesados += 1;
    }

    await conn.commit();
    const partial = omitidos.length > 0 && procesados > 0;
    return res.json({
      success: omitidos.length === 0,
      partial,
      procesados,
      omitidos: omitidos.length ? omitidos : undefined,
    });
  } catch (error) {
    await conn.rollback();
    console.error('Sync pagos error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    conn.release();
  }
}

module.exports = { syncMasivo };
