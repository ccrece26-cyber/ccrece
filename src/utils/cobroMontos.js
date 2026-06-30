/** Nunca cobrar más que el saldo pendiente del préstamo. */
function capMontoAlSaldo(monto, saldoPendiente) {
  const m = Number(monto) || 0;
  const s = Math.max(0, Number(saldoPendiente) || 0);
  if (m <= 0 || s <= 0) return 0;
  return Number(Math.min(m, s).toFixed(2));
}

/**
 * Al cerrar el crédito (saldo 0), anula visitas futuras del calendario
 * (p. ej. semanas de prórroga no utilizadas) sin exigir más pago.
 */
async function voidarCuotasRestantesAlCerrar(conn, prestamoId) {
  await conn.execute(
    `UPDATE Cuotas_Calendario SET
      estado = 'Pagada',
      monto_programado = COALESCE(monto_pagado, 0),
      updated_at = NOW(),
      is_synced = 1
     WHERE prestamo_id = ? AND estado IN ('Programada', 'Parcial') AND deleted_at IS NULL`,
    [prestamoId]
  );
}

module.exports = { capMontoAlSaldo, voidarCuotasRestantesAlCerrar };
