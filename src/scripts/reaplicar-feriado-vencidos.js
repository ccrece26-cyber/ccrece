/**
 * OBSOLETO — no usar para mover fechas de vencidos.
 *
 * El feriado solo mueve cuotas con fecha_programada = día feriado.
 * Los vencidos del día de cobro entran en la ruta del día hábil siguiente
 * sin cambiar fechas (ver debeIncluirEnAgenda + tieneCuotaVencida).
 *
 * Para revertir el backfill del 2026-07-22:
 *   CONFIRM=yes node src/scripts/revertir-movidas-vencidos-feriado.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { getConnection, pool } = require('../config/db');
const { moverCuotasDeFeriado, fechaISO } = require('../utils/feriados');

const FECHA = process.argv[2] || '2026-07-20';

(async () => {
  console.warn(
    'AVISO: moverCuotasDeFeriado ya no mueve vencidos. Solo reaplica cuotas exactas del día feriado.'
  );
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const mov = await moverCuotasDeFeriado(conn, FECHA);
    await conn.commit();
    console.log(
      JSON.stringify(
        {
          feriado: fechaISO(FECHA),
          destino: mov.destino,
          movidas: mov.movidas,
          movidas_exactas: mov.movidas_exactas,
          movidas_vencidos: mov.movidas_vencidos,
        },
        null,
        2
      )
    );
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
