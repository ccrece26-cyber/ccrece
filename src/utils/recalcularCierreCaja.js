/**
 * Si ya existe cierre de caja ese día, lo realinea con la suma de Pagos.
 * No crea cierres nuevos — solo actualiza si hay uno.
 */
const { rangoDiaLocal, whereCierreCalendarioDia } = require('./fechasSql');
const { toFechaISO } = require('./zonaHoraria');

/**
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {string} cobradorId
 * @param {string|Date} fechaRef — fecha del cobro o día YYYY-MM-DD
 * @returns {Promise<{ id: string, fecha: string, monto_efectivo: number, transacciones: number }|null>}
 */
async function recalcularCierreCajaSiExiste(conn, cobradorId, fechaRef) {
  if (!cobradorId || !fechaRef) return null;
  const dia = toFechaISO(fechaRef);

  const [cierres] = await conn.execute(
    `SELECT id, monto_efectivo, transacciones
     FROM Cierre_Caja
     WHERE cobrador_id = ? AND deleted_at IS NULL
       AND ${whereCierreCalendarioDia('fecha_cierre')}
     ORDER BY updated_at DESC
     LIMIT 1`,
    [cobradorId, dia]
  );
  if (!cierres.length) return null;

  const { inicio, fin } = rangoDiaLocal(dia);
  const [tot] = await conn.execute(
    `SELECT COUNT(id) AS transacciones, COALESCE(SUM(monto_pagado), 0) AS monto_total
     FROM Pagos
     WHERE deleted_at IS NULL AND cobrador_id = ?
       AND fecha_pago >= ? AND fecha_pago < ?`,
    [cobradorId, inicio, fin]
  );

  const monto = Number(Number(tot[0]?.monto_total || 0).toFixed(2));
  const transacciones = Number(tot[0]?.transacciones || 0);
  const prevMonto = Number(cierres[0].monto_efectivo);
  const prevTx = Number(cierres[0].transacciones);

  if (Math.abs(prevMonto - monto) < 0.01 && prevTx === transacciones) {
    return {
      id: cierres[0].id,
      fecha: dia,
      monto_efectivo: monto,
      transacciones,
      sin_cambio: true,
    };
  }

  await conn.execute(
    `UPDATE Cierre_Caja
     SET monto_efectivo = ?, transacciones = ?, updated_at = NOW(), is_synced = 1
     WHERE id = ?`,
    [monto, transacciones, cierres[0].id]
  );

  return {
    id: cierres[0].id,
    fecha: dia,
    monto_efectivo: monto,
    transacciones,
    monto_anterior: prevMonto,
    transacciones_anteriores: prevTx,
    sin_cambio: false,
  };
}

/**
 * Recalcula cierres para uno o más días (p. ej. si cambió la fecha del cobro).
 */
async function recalcularCierresCajaSiExisten(conn, cobradorId, fechas) {
  const vistos = new Set();
  const out = [];
  for (const f of fechas || []) {
    if (f == null || f === '') continue;
    const dia = toFechaISO(f);
    if (vistos.has(`${cobradorId}|${dia}`)) continue;
    vistos.add(`${cobradorId}|${dia}`);
    const r = await recalcularCierreCajaSiExiste(conn, cobradorId, dia);
    if (r) out.push(r);
  }
  return out;
}

module.exports = { recalcularCierreCajaSiExiste, recalcularCierresCajaSiExisten };
