/**
 * Exporta toda la BD actual (backend/.env) a un archivo .sql
 * Uso: npm run export-respaldo
 *      npm run export-respaldo -- ruta/salida.sql
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { generarRespaldoSql } = require('../utils/respaldoSql');
const { pool } = require('../config/db');

async function main() {
  const outArg = process.argv[2];
  const backupsDir = path.join(__dirname, '../../backups');
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

  console.log('Exportando desde TiDB (backend/.env)...');
  const { sql, meta } = await generarRespaldoSql();
  const outPath = outArg
    ? path.resolve(process.cwd(), outArg)
    : path.join(backupsDir, meta.filename);

  fs.writeFileSync(outPath, sql, 'utf8');
  const sizeMb = (Buffer.byteLength(sql, 'utf8') / (1024 * 1024)).toFixed(2);

  console.log('✔ Respaldo generado');
  console.log(`  Archivo: ${outPath}`);
  console.log(`  Tamaño:  ${sizeMb} MB`);
  console.log(`  Tablas:  ${meta.tablas} (${meta.tablas_con_datos} con datos)`);
  console.log(`  Filas:   ${meta.filas}`);
  console.log(`  Tiempo:  ${meta.ms} ms`);
  console.log('\nSiguiente paso: configure backend/.env.nuevo y ejecute:');
  console.log(`  npm run restaurar-respaldo -- "${outPath}"`);
}

main()
  .catch((err) => {
    console.error('❌', err.message || err);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  });
