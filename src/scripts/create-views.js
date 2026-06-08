require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, query } = require('../config/db');

const SQL_PATH = path.join(__dirname, 'vistas-reporte.sql');

function stripLeadingComments(sql) {
  return sql
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('--');
    })
    .join('\n')
    .trim();
}

function splitStatements(sql) {
  return sql
    .split(/;\s*\n/)
    .map((s) => stripLeadingComments(s))
    .filter((s) => s.length > 0);
}

async function createViews() {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const statements = splitStatements(sql);
  console.log(`Aplicando ${statements.length} vistas en TiDB...\n`);

  for (const statement of statements) {
    const nombre = (statement.match(/VIEW\s+(\w+)/i) || [])[1] || statement.slice(0, 40);
    try {
      await query(statement);
      console.log(`✔ ${nombre}`);
    } catch (e) {
      console.error(`✗ ${nombre}: ${e.message}`);
      throw e;
    }
  }

  console.log('\n🚀 Vistas de reporte listas.');
  console.log('   Exportar a Excel: SELECT * FROM v_giros_financieros ORDER BY fecha_hora;');
  console.log('   Cartera activa:   SELECT * FROM v_cartera_activa;');
  await pool.end();
}

createViews().catch((err) => {
  console.error('❌ Error creando vistas:', err.message);
  process.exit(1);
});
