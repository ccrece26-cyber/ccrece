const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query, pool } = require('../config/db');

const PERMISOS_DEFAULT = {
  ADMIN: ['*'],
  COBRADOR: ['ruta', 'clientes.ver', 'clientes.crear', 'prestamos.crear', 'prestamos.renovar', 'cobros', 'no_pago', 'cierre_caja'],
  CONTADOR: ['reportes'],
};

const ROLES = [
  ['ROL-ADMIN-UUID', 'ADMIN'],
  ['ROL-COB-UUID', 'COBRADOR'],
  ['ROL-CONT-UUID', 'CONTADOR'],
];

async function seed() {
  for (const [id, nombre] of ROLES) {
    await query(
      `INSERT INTO Roles (id, nombre) VALUES (?, ?) ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)`,
      [id, nombre]
    );
  }

  const hash = await bcrypt.hash('admin124', 10);
  await query(
    `INSERT INTO Usuarios (id, rol_id, nombre_completo, email, password_hash, activo, is_synced)
     VALUES ('USER-ADMIN-1', 'ROL-ADMIN-UUID', 'Administrador Principal', 'admin@nica.com', ?, 1, 1)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), activo = 1`,
    [hash]
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

  console.log('\n🌱 Seed: 3 roles + admin@nica.com / admin124\n');
  await pool.end();
}

seed().catch((err) => {
  console.error('❌ Error en seed:', err.message);
  process.exit(1);
});
