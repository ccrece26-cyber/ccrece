/**
 * Renombra el schema test → microfinanzas_nica (mueve todas las tablas).
 * Uso: npm run renombrar-schema
 */
const fs = require('fs');
const path = require('path');

const envNuevo = path.join(__dirname, '../../.env.nuevo');
require('dotenv').config({ path: envNuevo });

const { query, pool, getConnection } = require('../config/db');

const ORIGEN = 'test';
const DESTINO = 'microfinanzas_nica';

async function main() {
  const confirm = (process.env.CONFIRM_RENOMBRAR_SCHEMA || '').toLowerCase();
  if (confirm !== 'yes') {
    console.error(`⚠️  Moverá tablas de \`${ORIGEN}\` → \`${DESTINO}\``);
    console.error('   $env:CONFIRM_RENOMBRAR_SCHEMA="yes"');
    process.exit(1);
  }

  const rows = await query(`SHOW TABLES FROM \`${ORIGEN}\``);
  const key = Object.keys(rows[0] || {})[0] || `Tables_in_${ORIGEN}`;
  const tablas = rows.map((r) => r[key]).filter(Boolean);

  if (!tablas.length) {
    console.error(`❌ No hay tablas en \`${ORIGEN}\``);
    process.exit(1);
  }

  const conn = await getConnection();
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DESTINO}\``);
    console.log(`Moviendo ${tablas.length} tablas a \`${DESTINO}\`...`);

    for (const tabla of tablas) {
      await conn.query(`RENAME TABLE \`${ORIGEN}\`.\`${tabla}\` TO \`${DESTINO}\`.\`${tabla}\``);
      console.log(`  ✔ ${tabla}`);
    }

    const restantes = await query(`SHOW TABLES FROM \`${ORIGEN}\``);
    if (!restantes.length) {
      await conn.query(`DROP DATABASE \`${ORIGEN}\``);
      console.log(`\n✔ Schema \`${ORIGEN}\` eliminado (vacío).`);
    }

    console.log(`\n✔ Listo. Use DB_NAME=${DESTINO} en .env.nuevo y Vercel.`);
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
