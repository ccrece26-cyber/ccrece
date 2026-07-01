/**
 * Limpia cartera (préstamos, clientes, pagos, cuotas, rutas-clientes) pero conserva
 * usuarios cobradores, admin, roles y rutas vacías.
 *
 * Uso: CONFIRM_LIMPIAR_CARTERA=yes node src/scripts/limpiar-cartera-pre-carga.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

const TABLAS = [
  'Solicitudes_Correccion_Cobro',
  'Castigos_Perdida',
  'Pagos',
  'Gestiones_No_Pago',
  'Historial_Prorrogas',
  'Renovaciones_Log',
  'Cuotas_Calendario',
  'Prestamo_Garantias',
  'Prestamos',
  'Garantias',
  'Fiadores',
  'Ruta_Clientes',
  'Cierre_Caja',
  'Clientes',
];

async function tablaExiste(nombre) {
  const rows = await query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [nombre]
  );
  return rows.length > 0;
}

async function main() {
  if (process.env.CONFIRM_LIMPIAR_CARTERA !== 'yes') {
    console.error('\n⚠️  Ejecute: CONFIRM_LIMPIAR_CARTERA=yes node src/scripts/limpiar-cartera-pre-carga.js\n');
    process.exit(1);
  }

  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const resumen = {};
    for (const tabla of TABLAS) {
      if (!(await tablaExiste(tabla))) continue;
      const res = await query(`DELETE FROM \`${tabla}\``);
      resumen[tabla] = res.affectedRows ?? 0;
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    const cobradores = await query(
      `SELECT u.email, u.nombre_completo FROM Usuarios u
       JOIN Roles r ON u.rol_id = r.id WHERE r.nombre = 'COBRADOR' AND u.activo = 1`
    );

    console.log('\n✅ Cartera limpiada (cobradores y admin conservados)\n');
    for (const [k, v] of Object.entries(resumen)) {
      if (v > 0) console.log(`  · ${k}: ${v}`);
    }
    console.log(`\nCobradores disponibles (${cobradores.length}):`);
    for (const c of cobradores) console.log(`  · ${c.nombre_completo} <${c.email}>`);
    console.log('\nListo para carga masiva.\n');
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
