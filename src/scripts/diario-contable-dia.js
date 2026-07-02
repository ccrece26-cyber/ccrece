/**
 * Genera diario contable en consola / JSON para un día.
 * Uso: node src/scripts/diario-contable-dia.js 2026-07-01
 */
const path = require('path');
const envPath = process.argv.includes('--prod')
  ? path.join(__dirname, '../../.env.nuevo')
  : path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath });

const { buildReporteDiarioContable } = require('../utils/reporteDiarioContable');
const { pool } = require('../config/db');

const fecha = process.argv[2] || new Date().toISOString().slice(0, 10);

(async () => {
  const rep = await buildReporteDiarioContable(fecha);
  console.log(JSON.stringify(rep, null, 2));
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
