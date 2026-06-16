/**
 * Limpia TiDB: borra cartera, rutas, usuarios (excepto admin) y parámetros.
 * Conserva Roles y el usuario admin (USER-ADMIN-1).
 *
 * Uso: CONFIRM_RESET=yes npm run reset-db
 */
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query, pool } = require('../config/db');

const ADMIN_ID = 'USER-ADMIN-1';
const ADMIN_ROL = 'ROL-ADMIN-UUID';

const ROLES = [
  ['ROL-ADMIN-UUID', 'ADMIN'],
  ['ROL-COB-UUID', 'COBRADOR'],
  ['ROL-CONT-UUID', 'CONTADOR'],
];

const PERMISOS_DEFAULT = {
  ADMIN: ['*'],
  COBRADOR: ['ruta', 'clientes.ver', 'clientes.crear', 'prestamos.crear', 'prestamos.renovar', 'cobros', 'no_pago', 'cierre_caja'],
  CONTADOR: ['reportes'],
};

/** Tablas operativas (orden: hijos primero por si FK está activa). */
const TABLAS_LIMPIAR = [
  'Solicitudes_Correccion_Cobro',
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
  'Rutas',
  'Cierre_Caja',
  'Clientes',
  'Licencias_Activados',
  'Licencias_Codigos',
  'Parametros_Globales',
];

async function tablaExiste(nombre) {
  const rows = await query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [nombre]
  );
  return rows.length > 0;
}

async function limpiarTabla(nombre) {
  if (!(await tablaExiste(nombre))) return 0;
  const res = await query(`DELETE FROM \`${nombre}\``);
  return res.affectedRows ?? 0;
}

async function asegurarRolesYAdmin() {
  for (const [id, nombre] of ROLES) {
    await query(
      `INSERT INTO Roles (id, nombre) VALUES (?, ?) ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)`,
      [id, nombre]
    );
  }

  const hash = await bcrypt.hash('admin124', 10);
  await query(
    `INSERT INTO Usuarios (id, rol_id, nombre_completo, email, password_hash, activo, is_synced)
     VALUES (?, ?, 'Administrador Principal', 'admin@nica.com', ?, 1, 1)
     ON DUPLICATE KEY UPDATE
       rol_id = VALUES(rol_id),
       password_hash = VALUES(password_hash),
       activo = 1,
       deleted_at = NULL`,
    [ADMIN_ID, ADMIN_ROL, hash]
  );

  await query(
    `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
     VALUES (?, 'PERMISOS_ROLES', ?, 'Permisos por rol', 1)
     ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
    [uuidv4(), JSON.stringify(PERMISOS_DEFAULT)]
  );

  await query(
    `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
     VALUES (?, 'TASA_INTERES_POR_MES', '0.10', '10% por cada 4 semanas', 1)
     ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
    [uuidv4()]
  );
}

async function resetDb() {
  if (process.env.CONFIRM_RESET !== 'yes') {
    console.error('\n⚠️  Operación destructiva. Ejecute:\n   CONFIRM_RESET=yes npm run reset-db\n');
    process.exit(1);
  }

  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    const resumen = {};
    for (const tabla of TABLAS_LIMPIAR) {
      const n = await limpiarTabla(tabla);
      if (n > 0) resumen[tabla] = n;
    }

    const usuariosBorrados = await query(`DELETE FROM Usuarios WHERE id != ?`, [ADMIN_ID]);
    resumen.Usuarios_borrados = usuariosBorrados.affectedRows ?? 0;

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    await asegurarRolesYAdmin();

    console.log('\n🧹 Base de datos limpiada (TiDB)\n');
    console.log('Conservado: 3 roles + admin@nica.com (admin124)\n');
    if (Object.keys(resumen).length) {
      console.log('Filas eliminadas:');
      for (const [k, v] of Object.entries(resumen)) {
        console.log(`  · ${k}: ${v}`);
      }
    }
    console.log('\nListo para carga masiva desde cero.\n');
  } finally {
    conn.release();
    await pool.end();
  }
}

resetDb().catch((err) => {
  console.error('❌ Error en reset-db:', err.message);
  process.exit(1);
});
