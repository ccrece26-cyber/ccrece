/**
 * Elimina tablas legado Feriados e Historial_Anticipos (cobro flexible no las usa).
 *
 *   CONFIRM_DROP_FERIADOS=yes node src/scripts/drop-feriados-anticipos.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

async function main() {
  if (process.env.CONFIRM_DROP_FERIADOS !== 'yes') {
    console.log('Dry-run. Para aplicar: CONFIRM_DROP_FERIADOS=yes node src/scripts/drop-feriados-anticipos.js');
    try {
      const f = await query('SELECT COUNT(*) AS n FROM Feriados').catch(() => [{ n: 'N/A' }]);
      const h = await query('SELECT COUNT(*) AS n FROM Historial_Anticipos').catch(() => [{ n: 'N/A' }]);
      console.log('Feriados rows:', f[0]?.n, '| Historial_Anticipos rows:', h[0]?.n);
    } catch (e) {
      console.log(e.message);
    }
    await pool.end();
    return;
  }

  await query('DROP TABLE IF EXISTS Historial_Anticipos');
  await query('DROP TABLE IF EXISTS Feriados');
  console.log('OK: tablas Historial_Anticipos y Feriados eliminadas');
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {
    /* */
  }
  process.exit(1);
});
