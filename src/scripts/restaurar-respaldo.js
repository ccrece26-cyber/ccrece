/**
 * Restaura un .sql generado por export-respaldo en la BD de backend/.env.nuevo
 * Uso: npm run restaurar-respaldo -- backups/CrediCrece_respaldo_2026-06-23.sql
 */
const fs = require('fs');
const path = require('path');

const envNuevo = path.join(__dirname, '../../.env.nuevo');
if (!fs.existsSync(envNuevo)) {
  console.error('❌ Falta backend/.env.nuevo con credenciales de la BD nueva.');
  console.error('   Copie desde .env.nuevo.example y complete los valores.');
  process.exit(1);
}

require('dotenv').config({ path: envNuevo });

const { pool } = require('../config/db');

function fixJsonInStatement(stmt) {
  if (!stmt.includes('INSERT INTO `Prestamos`')) return stmt;
  return stmt.replace(
    /, (\d+), '((?:[A-ZÁÉÍÓÚÑ]+(?:,[A-ZÁÉÍÓÚÑ]+)*))', 'SEMANAL'/g,
    (_, freq, dias) => {
      const json = JSON.stringify(dias.split(',').map((d) => d.trim()));
      return `, ${freq}, '${json.replace(/'/g, "''")}', 'SEMANAL'`;
    }
  );
}

function parseSqlStatements(sql) {
  return sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0)
    .map(fixJsonInStatement);
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('❌ Indique el archivo .sql: npm run restaurar-respaldo -- backups/archivo.sql');
    process.exit(1);
  }

  const sqlPath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(sqlPath)) {
    console.error(`❌ No existe: ${sqlPath}`);
    process.exit(1);
  }

  const confirm = (process.env.CONFIRM_RESTAURAR || '').toLowerCase();
  if (confirm !== 'yes') {
    console.error('⚠️  Esto REEMPLAZA tablas en la BD de .env.nuevo');
    console.error('   Para continuar: $env:CONFIRM_RESTAURAR="yes"  (PowerShell)');
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  const statements = parseSqlStatements(sql);
  console.log(`Restaurando en TiDB (.env.nuevo): ${statements.length} sentencias...`);

  const conn = await pool.getConnection();
  let ok = 0;
  let fail = 0;
  try {
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        await conn.query(stmt);
        ok++;
        if (ok % 50 === 0 || i === statements.length - 1) {
          process.stdout.write(`\r  Progreso: ${i + 1}/${statements.length}`);
        }
      } catch (err) {
        fail++;
        const preview = stmt.slice(0, 80).replace(/\n/g, ' ');
        console.error(`\n❌ Sentencia ${i + 1}: ${err.message}`);
        console.error(`   ${preview}...`);
        throw err;
      }
    }
    console.log(`\n✔ Restauración completada (${ok} sentencias).`);
    console.log('  Verifique: npm run verificar-migracion');
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Restauración fallida:', err.message || err);
  process.exit(1);
});
