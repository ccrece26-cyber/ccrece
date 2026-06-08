const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { PERMISOS_DEFAULT } = require('../config/permisos');

async function verificarPassword(plain, hash) {
  if (!hash || !plain) return false;
  const p = String(plain).trim();
  if (hash.startsWith('$2')) {
    return bcrypt.compare(p, hash);
  }
  return p === hash;
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email y contraseña requeridos.' });
    }

    const emailNorm = email.toLowerCase().trim();
    const passNorm = String(password).trim();
    const rows = await query(
      `SELECT u.id, u.nombre_completo, u.email, u.password_hash, u.activo, r.nombre AS rol
       FROM Usuarios u
       INNER JOIN Roles r ON u.rol_id = r.id
       WHERE LOWER(TRIM(u.email)) = ? AND u.deleted_at IS NULL`,
      [emailNorm]
    );
    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }

    const usuario = rows[0];
    const valido = await verificarPassword(passNorm, usuario.password_hash);
    if (!valido) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }

    if (!Number(usuario.activo)) {
      return res.status(403).json({
        success: false,
        code: 'cuenta_inactiva',
        message:
          'Su cuenta fue desactivada por el administrador. Ya no tiene acceso a la aplicación. Puede desinstalar la app de su teléfono.',
      });
    }

    const permRows = await query(`SELECT valor FROM Parametros_Globales WHERE clave = 'PERMISOS_ROLES'`);
    const permisos = permRows[0]?.valor ? JSON.parse(permRows[0].valor) : PERMISOS_DEFAULT;

    return res.json({
      success: true,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre_completo,
        email: usuario.email,
        rol: usuario.rol,
      },
      permisos,
    });
  } catch (error) {
    console.error('Login error:', error.message);
    return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
}

async function cambiarPassword(req, res) {
  try {
    const { email, password_actual, password_nueva } = req.body;
    if (!email || !password_actual || !password_nueva) {
      return res.status(400).json({ success: false, message: 'Complete todos los campos.' });
    }
    const nueva = String(password_nueva).trim();
    if (nueva.length < 6) {
      return res.status(400).json({ success: false, message: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }

    const emailNorm = email.toLowerCase().trim();
    const rows = await query(
      `SELECT u.id, u.password_hash, r.nombre AS rol
       FROM Usuarios u
       INNER JOIN Roles r ON u.rol_id = r.id
       WHERE LOWER(TRIM(u.email)) = ? AND u.activo = 1`,
      [emailNorm]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    const usuario = rows[0];
    const rolesPermitidos = ['ADMIN', 'COBRADOR', 'CONTADOR'];
    if (!rolesPermitidos.includes(usuario.rol)) {
      return res.status(403).json({ success: false, message: 'Operación no permitida para este rol.' });
    }

    const valido = await verificarPassword(String(password_actual).trim(), usuario.password_hash);
    if (!valido) {
      return res.status(401).json({ success: false, message: 'Contraseña actual incorrecta.' });
    }

    const hash = await bcrypt.hash(nueva, 10);
    await query(`UPDATE Usuarios SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [hash, usuario.id]);
    return res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (error) {
    console.error('Cambiar password error:', error.message);
    return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
}

module.exports = { login, cambiarPassword };
