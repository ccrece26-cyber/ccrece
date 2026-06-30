/**
 * Resumen rápido de la BD apuntada por backend/.env.nuevo (o .env si no existe)
 */
const fs = require('fs');
const path = require('path');

const envNuevo = path.join(__dirname, '../../.env.nuevo');
const envFile = fs.existsSync(envNuevo) ? envNuevo : path.join(__dirname, '../../.env');
require('dotenv').config({ path: envFile });

const { query, pool } = require('../config/db');

async function count(table) {
  const rows = await query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0]?.n || 0);
}

async function main() {
  console.log(`Verificando: ${path.basename(envFile)}\n`);

  const tablas = [
    'Usuarios',
    'Clientes',
    'Prestamos',
    'Cuotas_Calendario',
    'Pagos',
    'Cierre_Caja',
    'Castigos_Perdida',
    'Historial_Prorrogas',
  ];

  for (const t of tablas) {
    try {
      const n = await count(t);
      console.log(`  ${t.padEnd(22)} ${n}`);
    } catch {
      console.log(`  ${t.padEnd(22)} (no existe)`);
    }
  }

  const activos = await query(
    `SELECT COUNT(*) AS n FROM Prestamos WHERE estado = 'Activo' AND deleted_at IS NULL`
  );
  const cartera = await query(
    `SELECT COALESCE(SUM(saldo_pendiente),0) AS s FROM Prestamos WHERE estado = 'Activo' AND deleted_at IS NULL`
  );
  console.log(`\n  Préstamos activos:     ${activos[0]?.n || 0}`);
  console.log(`  Cartera (saldo pend.): C$${Number(cartera[0]?.s || 0).toLocaleString('es-NI')}`);
}

main()
  .catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  });
