/**
 * Corrige dias_de_cobro DIAS_MES desde el Excel 31-7-26 (textos como "15 y 30 de cada mes").
 * node src/scripts/reparar-dias-mes-desde-excel.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const path = require('path');
const XLSX = require('xlsx');
const { query, pool } = require('../config/db');
const { resolverFrecuenciaCobro } = require('../utils/frecuenciaCobro');

const EXCEL = path.join(__dirname, '../../../31-7-26.xlsx');

async function main() {
  const rows = XLSX.utils.sheet_to_json(
    XLSX.readFile(EXCEL, { raw: true }).Sheets['carga'],
    { defval: null, raw: true }
  );

  let fixed = 0;
  const detalle = [];

  for (const r of rows) {
    const d = String(r.dias_cobro || '');
    const freq = resolverFrecuenciaCobro({ dias_cobro: d });
    if (freq.tipo !== 'DIAS_MES') continue;

    const ced = String(r.cedula || '').trim();
    if (!ced) continue;
    const diasJson = JSON.stringify(freq.diasMes);

    await query(
      `UPDATE Prestamos p
       JOIN Clientes c ON c.id = p.cliente_id
       SET p.dias_de_cobro = ?, p.periodicidad = 'DIAS_MES', p.is_synced = 1, p.updated_at = NOW()
       WHERE c.cedula = ? AND p.deleted_at IS NULL`,
      [diasJson, ced]
    );
    fixed += 1;
    detalle.push({
      cedula: ced,
      nombre: r.nombre_completo,
      excel: d,
      dias: freq.diasMes,
    });
  }

  const check = await query(`
    SELECT periodicidad, dias_de_cobro, COUNT(*) AS n
    FROM Prestamos WHERE deleted_at IS NULL AND periodicidad = 'DIAS_MES'
    GROUP BY periodicidad, dias_de_cobro
    ORDER BY n DESC
  `);

  console.log(JSON.stringify({ fixed, n_tipos: check.length, tipos: check, sample: detalle.slice(0, 8) }, null, 2));
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
