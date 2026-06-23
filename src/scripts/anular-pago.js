/**
 * Anula un pago (soft delete) y revierte saldo/cuotas.
 * Uso: node src/scripts/anular-pago.js <pago_id>
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getConnection } = require('../config/db');
const { revertirMontoDeCuotas } = require('../utils/registrarPagoNube');

const pagoId = process.argv[2];
if (!pagoId) {
  console.error('Uso: node src/scripts/anular-pago.js <pago_id>');
  process.exit(1);
}

(async () => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT pg.id, pg.prestamo_id, pg.monto_pagado, pg.cobrador_id, c.nombre_completo
       FROM Pagos pg
       JOIN Prestamos p ON pg.prestamo_id = p.id
       JOIN Clientes c ON p.cliente_id = c.id
       WHERE pg.id = ? AND pg.deleted_at IS NULL LIMIT 1`,
      [pagoId]
    );
    if (!rows.length) {
      throw new Error('Pago no encontrado o ya anulado');
    }
    const pago = rows[0];
    const monto = Number(pago.monto_pagado);

    await revertirMontoDeCuotas(conn, pago.prestamo_id, monto);
    await conn.execute(
      `UPDATE Prestamos SET saldo_pendiente = saldo_pendiente + ?, estado = 'Activo', updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [monto, pago.prestamo_id]
    );
    await conn.execute(
      `UPDATE Pagos SET deleted_at = NOW(), updated_at = NOW(), is_synced = 1 WHERE id = ?`,
      [pagoId]
    );
    await conn.commit();
    console.log('Anulado:', pago.nombre_completo, 'C$', monto.toFixed(2), 'pago', pagoId);
  } catch (e) {
    await conn.rollback();
    console.error(e.message);
    process.exit(1);
  } finally {
    conn.release();
  }
  process.exit(0);
})();
