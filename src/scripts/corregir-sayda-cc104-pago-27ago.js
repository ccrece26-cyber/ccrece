/**
 * CC-104 Sayda — el cobro C$400 del 27-ago quedó en el préstamo viejo (Pagado).
 * Mover al activo y recalcular saldos.
 *
 *   CONFIRM_CC104_27AGO=yes node src/scripts/corregir-sayda-cc104-pago-27ago.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { getConnection, pool, query } = require('../config/db');
const { recalcularSaldoPrestamoDesdePagos } = require('../utils/registrarPagoNube');
const { bumpCarteraVersion } = require('../utils/carteraVersion');
const { rangoDiaLocal } = require('../utils/fechasSql');

const CODIGO = 'CC-104';
const PRESTAMO_VIEJO = '0d988896-2ae7-45e1-a408-18bc6e40bf56';
const PRESTAMO_ACTIVO = '3aa21db1-223d-4122-bb65-d7077ae01952';
const COB = 'COB-mq879bqw';
const DIA = '2026-08-27';
const PAGO_ESPERADO = 400;
const SALDO_FINAL = 7150;

async function buscarPagoMalAsignado() {
  const { inicio, fin } = rangoDiaLocal(DIA);
  const rows = await query(
    `SELECT pg.id, pg.prestamo_id, pg.monto_pagado, pg.fecha_pago, pg.cobrador_id, p.estado
     FROM Pagos pg
     JOIN Prestamos p ON p.id = pg.prestamo_id
     WHERE p.cliente_id = ? AND pg.deleted_at IS NULL
       AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
     ORDER BY pg.fecha_pago ASC`,
    [CODIGO, inicio, fin]
  );
  return rows;
}

(async () => {
  const pagosDia = await buscarPagoMalAsignado();
  const mal = pagosDia.find(
    (p) => p.prestamo_id === PRESTAMO_VIEJO && Math.abs(Number(p.monto_pagado) - PAGO_ESPERADO) < 0.02
  );
  const yaOk = pagosDia.find(
    (p) => p.prestamo_id === PRESTAMO_ACTIVO && Math.abs(Number(p.monto_pagado) - PAGO_ESPERADO) < 0.02
  );

  if (yaOk && !mal) {
    const activo = await query(`SELECT saldo_pendiente, estado FROM Prestamos WHERE id = ?`, [PRESTAMO_ACTIVO]);
    console.log(
      JSON.stringify(
        {
          ok: true,
          ya_corregido: true,
          pago_activo_id: yaOk.id,
          saldo_activo: Number(activo[0]?.saldo_pendiente),
        },
        null,
        2
      )
    );
    await pool.end();
    return;
  }

  if (!mal) {
    console.log('Dry-run / sin pago mal asignado:', { pagosDia, mal, yaOk });
    await pool.end();
    return;
  }

  if (process.env.CONFIRM_CC104_27AGO !== 'yes') {
    console.log('Dry-run. Ejecute con CONFIRM_CC104_27AGO=yes para aplicar.');
    console.log(JSON.stringify({ pago_a_mover: mal, pagos_dia: pagosDia }, null, 2));
    await pool.end();
    return;
  }

  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`UPDATE Pagos SET prestamo_id = ?, is_synced = 1 WHERE id = ?`, [
      PRESTAMO_ACTIVO,
      mal.id,
    ]);
    await recalcularSaldoPrestamoDesdePagos(conn, PRESTAMO_VIEJO);
    await recalcularSaldoPrestamoDesdePagos(conn, PRESTAMO_ACTIVO);
    // Crédito cerrado por renovación: no debe reactivarse al mover un cobro mal asignado.
    await conn.execute(
      `UPDATE Prestamos SET saldo_pendiente = 0, estado = 'Pagado', updated_at = NOW(), is_synced = 1 WHERE id = ?`,
      [PRESTAMO_VIEJO]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const version = await bumpCarteraVersion(null, [COB]);
  const [viejo, activo] = await Promise.all([
    query(`SELECT saldo_pendiente, estado FROM Prestamos WHERE id = ?`, [PRESTAMO_VIEJO]),
    query(`SELECT saldo_pendiente, estado FROM Prestamos WHERE id = ?`, [PRESTAMO_ACTIVO]),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        codigo: CODIGO,
        pago_id: mal.id,
        monto: PAGO_ESPERADO,
        prestamo_viejo: { id: PRESTAMO_VIEJO, ...viejo[0], saldo_pendiente: Number(viejo[0]?.saldo_pendiente) },
        prestamo_activo: {
          id: PRESTAMO_ACTIVO,
          ...activo[0],
          saldo_pendiente: Number(activo[0]?.saldo_pendiente),
        },
        saldo_esperado_form: SALDO_FINAL,
        version,
      },
      null,
      2
    )
  );
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
