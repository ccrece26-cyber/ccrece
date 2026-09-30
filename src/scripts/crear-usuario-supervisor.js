/**
 * Asegura rol SUPERVISOR y crea usuario de prueba.
 *   node src/scripts/crear-usuario-supervisor.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { ROL_IDS, ROLES } = require('../utils/roles');
const { PERMISOS_DEFAULT } = require('../config/permisos');

const USER = {
  id: 'USER-SUP-1',
  nombre: 'Supervisora',
  email: 'supervisora',
  password: 'Supervisor123',
};

(async () => {
  await query(
    `INSERT INTO Roles (id, nombre) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)`,
    [ROL_IDS.SUPERVISOR, ROLES.SUPERVISOR]
  );
  console.log('Rol SUPERVISOR OK:', ROL_IDS.SUPERVISOR);

  const hash = await bcrypt.hash(USER.password, 10);
  const exists = await query(`SELECT id, email FROM Usuarios WHERE id = ? OR LOWER(email) = ?`, [
    USER.id,
    USER.email.toLowerCase(),
  ]);

  if (exists.length) {
    await query(
      `UPDATE Usuarios
       SET rol_id = ?, nombre_completo = ?, email = ?, password_hash = ?, activo = 1,
           deleted_at = NULL, updated_at = NOW()
       WHERE id = ? OR LOWER(email) = ?`,
      [ROL_IDS.SUPERVISOR, USER.nombre, USER.email, hash, USER.id, USER.email.toLowerCase()]
    );
    console.log('Usuario supervisor actualizado:', USER.email);
  } else {
    await query(
      `INSERT INTO Usuarios (id, rol_id, nombre_completo, email, password_hash, activo, is_synced)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
      [USER.id, ROL_IDS.SUPERVISOR, USER.nombre, USER.email, hash]
    );
    console.log('Usuario supervisor creado:', USER.email);
  }

  // Fusionar SUPERVISOR en PERMISOS_ROLES si ya existe en BD
  const rows = await query(`SELECT valor FROM Parametros_Globales WHERE clave = 'PERMISOS_ROLES'`);
  let permisos = rows[0]?.valor ? JSON.parse(rows[0].valor) : { ...PERMISOS_DEFAULT };
  permisos.ADMIN = ['*'];
  if (!permisos.SUPERVISOR) permisos.SUPERVISOR = PERMISOS_DEFAULT.SUPERVISOR;
  const { v4: uuidv4 } = require('uuid');
  await query(
    `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
     VALUES (?, 'PERMISOS_ROLES', ?, 'Permisos por rol', 1)
     ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
    [uuidv4(), JSON.stringify(permisos)]
  );
  console.log('PERMISOS_ROLES actualizado con SUPERVISOR');

  const check = await query(
    `SELECT u.id, u.nombre_completo, u.email, r.nombre AS rol, u.activo
     FROM Usuarios u JOIN Roles r ON u.rol_id = r.id
     WHERE u.id = ?`,
    [USER.id]
  );
  console.log('Resultado:', check[0]);
  console.log('\nLogin: email =', USER.email, '| password =', USER.password);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
