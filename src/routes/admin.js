const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, getConnection } = require('../config/db');
const { nombreCompleto } = require('../utils/cliente');
const { PERMISOS_DEFAULT, LABELS } = require('../config/permisos');
const { nextClienteId, initSecuenciaCliente, esIdClienteOficial } = require('../utils/clienteId');
const { upsertFiadorEnNube, vincularFiadorAPrestamo } = require('../utils/fiadoresNube');
const {
  ensureRutaForCobrador,
  agregarClienteARuta,
  optimizarOrdenRuta,
  sincronizarRutasCobradores,
  vincularClientesCobradorARuta,
  ESTELI_CENTRO,
} = require('../utils/rutas');
const {
  leerParametrosFinancieros,
  normalizarTasaMensualInput,
  normalizarSugerenciasInput,
} = require('../utils/parametrosFinancieros');
const { buildAgendaCobrador, buildCumplimientoBatch, diaCobroDeFecha } = require('../utils/agendaCobrador');
const { diaCobroHoy } = require('../utils/diasCobro');
const { validarFilas, importarFilas } = require('../utils/cargaMasivaPrestamos');
const { normalizarCedula, validarCedula } = require('../utils/cedulaNic');
const { datosWhatsAppCliente } = require('../utils/whatsappCliente');
const { generarRespaldoSql } = require('../utils/respaldoSql');

const txt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
};

const camposCliente = (c) => ({
  primer_nombre: c.primer_nombre || null,
  segundo_nombre: c.segundo_nombre || null,
  primer_apellido: c.primer_apellido || null,
  segundo_apellido: c.segundo_apellido || null,
  nombre_completo: nombreCompleto(c),
  cedula: normalizarCedula(c.cedula) || null,
  telefono: c.telefono || null,
  direccion: c.direccion || null,
  actividad_economica: c.actividad_economica || null,
  latitud: c.latitud != null && c.latitud !== '' ? Number(c.latitud) : null,
  longitud: c.longitud != null && c.longitud !== '' ? Number(c.longitud) : null,
  cobrador_id: c.cobrador_id || null,
});

async function getRespaldoSql(req, res) {
  try {
    const { sql, meta } = await generarRespaldoSql();
    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
    res.setHeader('X-Backup-Tables', String(meta.tablas));
    res.setHeader('X-Backup-Rows', String(meta.filas));
    res.setHeader('X-Backup-Generated-At', meta.generado_at);
    if (meta.ms != null) res.setHeader('X-Backup-Ms', String(meta.ms));
    return res.send(sql);
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message || 'Error al generar respaldo' });
  }
}

async function getKpis(req, res) {
  try {
    const [colocacion, recuperacion, cartera, riesgo] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(monto_desembolsado),0) AS monto, COUNT(*) AS cant
         FROM Prestamos WHERE deleted_at IS NULL AND estado IN ('Activo','Pagado')`
      ),
      query(`SELECT COALESCE(SUM(monto_pagado),0) AS monto FROM Pagos WHERE deleted_at IS NULL`),
      query(
        `SELECT COALESCE(SUM(saldo_pendiente),0) AS monto, COUNT(*) AS cant
         FROM Prestamos WHERE deleted_at IS NULL AND estado = 'Activo'`
      ),
      query(
        `SELECT COUNT(DISTINCT p.id) AS cant FROM Prestamos p
         JOIN Cuotas_Calendario cc ON p.id = cc.prestamo_id
         WHERE p.estado = 'Activo' AND cc.estado = 'Programada'
           AND cc.fecha_programada < CURDATE() AND p.deleted_at IS NULL`
      ),
    ]);
    return res.json({
      success: true,
      data: {
        colocacion: colocacion[0]?.monto || 0,
        prestamos: colocacion[0]?.cant || 0,
        recuperacion: recuperacion[0]?.monto || 0,
        cartera: cartera[0]?.monto || 0,
        activos: cartera[0]?.cant || 0,
        enRiesgo: riesgo[0]?.cant || 0,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function listClientes(req, res) {
  try {
    const { cobrador_id } = req.query;
    let sql = `SELECT c.*, u.nombre_completo AS cobrador_nombre
               FROM Clientes c
               LEFT JOIN Usuarios u ON c.cobrador_id = u.id
               WHERE c.deleted_at IS NULL`;
    const params = [];
    if (cobrador_id) {
      sql += ' AND c.cobrador_id = ?';
      params.push(cobrador_id);
    }
    sql += ' ORDER BY c.id';
    const rows = await query(sql, params);
    const data = rows.map((r) => ({ ...r, cedula: normalizarCedula(r.cedula) || r.cedula }));
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function createCliente(req, res) {
  const conn = await getConnection();
  try {
    const c = camposCliente(req.body);
    if (!c.cedula || !c.nombre_completo) {
      return res.status(400).json({ success: false, message: 'Cédula y nombre requeridos.' });
    }
    const valCed = validarCedula(c.cedula);
    if (!valCed.ok) return res.status(400).json({ success: false, message: valCed.error });
    c.cedula = valCed.cedula;
    await conn.beginTransaction();
    const id = await nextClienteId(conn);
    await conn.execute(
      `INSERT INTO Clientes (
        id, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
        nombre_completo, cedula, telefono, direccion, actividad_economica,
        latitud, longitud, cobrador_id, is_synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id, c.primer_nombre, c.segundo_nombre, c.primer_apellido, c.segundo_apellido,
        c.nombre_completo, c.cedula, c.telefono, c.direccion, c.actividad_economica,
        c.latitud, c.longitud, c.cobrador_id,
      ]
    );
    if (c.cobrador_id) {
      const [cob] = await conn.execute(
        'SELECT id, nombre_completo FROM Usuarios WHERE id = ? AND activo = 1 LIMIT 1',
        [c.cobrador_id]
      );
      if (!cob.length) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: 'El cobrador asignado no existe. Elija un cobrador activo.',
        });
      }
      const rutaId = await ensureRutaForCobrador(c.cobrador_id, cob[0].nombre_completo, conn);
      await agregarClienteARuta(rutaId, id, conn);
    }

    await conn.commit();
    return res.json({ success: true, id, secuencia: id });
  } catch (e) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function updateCliente(req, res) {
  try {
    const { id } = req.params;
    const c = camposCliente(req.body);
    if (c.cedula) {
      const valCed = validarCedula(c.cedula);
      if (!valCed.ok) return res.status(400).json({ success: false, message: valCed.error });
      c.cedula = valCed.cedula;
    }
    await query(
      `UPDATE Clientes SET
        primer_nombre = ?, segundo_nombre = ?, primer_apellido = ?, segundo_apellido = ?,
        nombre_completo = ?, cedula = ?, telefono = ?, direccion = ?, actividad_economica = ?,
        latitud = COALESCE(?, latitud), longitud = COALESCE(?, longitud),
        cobrador_id = ?, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [
        c.primer_nombre, c.segundo_nombre, c.primer_apellido, c.segundo_apellido,
        c.nombre_completo, c.cedula, c.telefono, c.direccion, c.actividad_economica,
        c.latitud, c.longitud, c.cobrador_id, id,
      ]
    );

    if (c.cobrador_id) {
      const [cob] = await query('SELECT nombre_completo FROM Usuarios WHERE id = ?', [c.cobrador_id]);
      const rutaId = await ensureRutaForCobrador(c.cobrador_id, cob?.nombre_completo);
      await agregarClienteARuta(rutaId, id);
      await optimizarOrdenRuta(rutaId);
      return res.json({ success: true, ruta_id: rutaId });
    }

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function asignarClienteCobrador(req, res) {
  try {
    const { id } = req.params;
    const { cobrador_id } = req.body;

    await query(
      `UPDATE Clientes SET cobrador_id = ?, updated_at = NOW() WHERE id = ?`,
      [cobrador_id || null, id]
    );

    if (cobrador_id) {
      const [cob] = await query('SELECT nombre_completo FROM Usuarios WHERE id = ?', [cobrador_id]);
      const rutaId = await ensureRutaForCobrador(cobrador_id, cob?.nombre_completo);
      await agregarClienteARuta(rutaId, id);
      await optimizarOrdenRuta(rutaId);
      return res.json({ success: true, ruta_id: rutaId, mensaje: 'Cliente agregado a ruta optimizada' });
    }

    await query(
      `DELETE rc FROM Ruta_Clientes rc
       JOIN Rutas r ON rc.ruta_id = r.id
       WHERE rc.cliente_id = ? AND r.cobrador_id IS NOT NULL`,
      [id]
    );
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function getSecuenciaCliente(req, res) {
  try {
    await initSecuenciaCliente(query);
    const rows = await query(`SELECT valor FROM Parametros_Globales WHERE clave = 'SEC_CLIENTE'`);
    return res.json({ success: true, valor: rows[0]?.valor || '0' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function listPrestamosActivos(req, res) {
  try {
    const rows = await query(
      `SELECT p.*, c.nombre_completo, c.cedula, c.telefono,
              ur.nombre_completo AS cobrador_registro_nombre,
              ue.nombre_completo AS cobrador_entrega_nombre,
              uop.nombre_completo AS cobrador_opero_nombre
       FROM Prestamos p
       JOIN Clientes c ON p.cliente_id = c.id
       LEFT JOIN Usuarios ur ON p.cobrador_registro_id = ur.id
       LEFT JOIN Usuarios ue ON p.cobrador_entrega_id = ue.id
       LEFT JOIN Renovaciones_Log r ON r.prestamo_nuevo_id = p.id
       LEFT JOIN Usuarios uop ON r.cobrador_opero_id = uop.id
       WHERE p.estado = 'Activo' AND p.deleted_at IS NULL
       ORDER BY c.nombre_completo`
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function listRutas(req, res) {
  try {
    const rows = await query(
      `SELECT r.*, u.nombre_completo AS cobrador_nombre,
              (SELECT COUNT(*) FROM Ruta_Clientes rc WHERE rc.ruta_id = r.id) AS total_clientes
       FROM Rutas r LEFT JOIN Usuarios u ON r.cobrador_id = u.id
       WHERE r.activa = 1 AND r.deleted_at IS NULL`
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function listCobradores(req, res) {
  try {
    const todos = req.query.todos === '1';
    let sql = `SELECT u.id, u.nombre_completo, u.email, u.activo,
              (SELECT COUNT(*) FROM Clientes c WHERE c.cobrador_id = u.id AND c.deleted_at IS NULL) AS total_clientes
       FROM Usuarios u
       JOIN Roles r ON u.rol_id = r.id
       WHERE r.nombre = 'COBRADOR'`;
    if (!todos) sql += ' AND u.activo = 1';
    sql += ' ORDER BY u.activo DESC, u.nombre_completo ASC';
    const rows = await query(sql);
    return res.json({ success: true, data: rows });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function getPermisos(req, res) {
  try {
    const rows = await query(`SELECT valor FROM Parametros_Globales WHERE clave = 'PERMISOS_ROLES'`);
    const permisos = rows[0]?.valor ? JSON.parse(rows[0].valor) : PERMISOS_DEFAULT;
    return res.json({ success: true, data: permisos, labels: LABELS });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function setPermisos(req, res) {
  try {
    const permisos = req.body.permisos || req.body;
    if (!permisos.COBRADOR || !permisos.CONTADOR) {
      return res.status(400).json({ success: false, message: 'Permisos COBRADOR y CONTADOR requeridos.' });
    }
    permisos.ADMIN = ['*'];
    await query(
      `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
       VALUES (?, 'PERMISOS_ROLES', ?, 'Permisos por rol', 1)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      [uuidv4(), JSON.stringify(permisos)]
    );
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function getParametrosFinancieros(req, res) {
  try {
    const data = await leerParametrosFinancieros(query);
    const tasaDec = parseFloat(data.tasa_interes_por_mes);
    return res.json({
      success: true,
      data: {
        ...data,
        tasa_mensual_pct: Number((tasaDec * 100).toFixed(2)),
        descripcion_auto: 'Tasa mensual por defecto (Auto). 4 semanas = 1 mes. Global = mensual x meses.',
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function setParametrosFinancieros(req, res) {
  try {
    const tasaRaw = req.body.tasa_mensual_pct ?? req.body.tasa_interes_por_mes;
    const sugerenciasRaw = req.body.tasas_mensuales_sugeridas ?? req.body.tasas_sugeridas;

    if (tasaRaw != null) {
      const tasaDec = normalizarTasaMensualInput(tasaRaw);
      if (!tasaDec) {
        return res.status(400).json({ success: false, message: 'Tasa mensual invalida (0-100%).' });
      }
      await query(
        `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
         VALUES (?, 'TASA_INTERES_POR_MES', ?, 'Tasa mensual Auto (% por cada 4 semanas)', 1)
         ON DUPLICATE KEY UPDATE valor = VALUES(valor), descripcion = VALUES(descripcion)`,
        [uuidv4(), tasaDec]
      );
    }

    if (sugerenciasRaw != null) {
      const sugerencias = normalizarSugerenciasInput(sugerenciasRaw);
      if (!sugerencias) {
        return res.status(400).json({ success: false, message: 'Sugerencias invalidas. Ej: 8,10,12,15' });
      }
      await query(
        `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
         VALUES (?, 'TASAS_MENSUALES_SUGERIDAS', ?, 'Atajos tasa mensual %/mes', 1)
         ON DUPLICATE KEY UPDATE valor = VALUES(valor), descripcion = VALUES(descripcion)`,
        [uuidv4(), JSON.stringify(sugerencias)]
      );
    }

    const data = await leerParametrosFinancieros(query);
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function patchReciboFisicoPrestamo(req, res) {
  try {
    const { id } = req.params;
    const numero = String(req.body.numero_recibo_fisico ?? '').trim() || null;
    const [row] = await query(
      `SELECT id FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (!row) {
      return res.status(404).json({ success: false, message: 'Préstamo no encontrado' });
    }
    await query(
      `UPDATE Prestamos SET numero_recibo_fisico = ?, is_synced = 1, updated_at = NOW() WHERE id = ?`,
      [numero, id]
    );
    return res.json({ success: true, numero_recibo_fisico: numero });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function updatePrestamoFrecuencia(req, res) {
  try {
    const { id } = req.params;
    let dias = req.body.dias_de_cobro;
    if (typeof dias === 'string') {
      try {
        dias = JSON.parse(dias);
      } catch {
        return res.status(400).json({ success: false, message: 'dias_de_cobro invalido' });
      }
    }
    if (!Array.isArray(dias) || !dias.length) {
      return res.status(400).json({ success: false, message: 'Seleccione al menos un dia de cobro.' });
    }
    const freq = dias.length;
    const rows = await query(
      `SELECT id, cuota_semanal_base, estado FROM Prestamos WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Prestamo no encontrado' });
    const p = rows[0];
    if (p.estado !== 'Activo') {
      return res.status(400).json({ success: false, message: 'Solo prestamos activos' });
    }
    const cuotaVisita = Number((Number(p.cuota_semanal_base) / freq).toFixed(2));
    const diasJson = JSON.stringify(dias.map((d) => String(d).toUpperCase()));
    await query(
      `UPDATE Prestamos SET dias_de_cobro = ?, frecuencia_semana = ?, is_synced = 1, updated_at = NOW() WHERE id = ?`,
      [diasJson, freq, id]
    );
    await query(
      `UPDATE Cuotas_Calendario SET monto_programado = ?, is_synced = 0
       WHERE prestamo_id = ? AND estado IN ('Programada', 'Parcial') AND deleted_at IS NULL`,
      [cuotaVisita, id]
    );
    return res.json({
      success: true,
      data: { id, dias_de_cobro: dias, frecuencia_semana: freq, cuota_por_visita: cuotaVisita },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function listContadores(req, res) {
  try {
    const todos = req.query.todos === '1';
    let sql = `SELECT u.id, u.nombre_completo, u.email, u.activo FROM Usuarios u
       JOIN Roles r ON u.rol_id = r.id WHERE r.nombre = 'CONTADOR'`;
    if (!todos) sql += ' AND u.activo = 1';
    sql += ' ORDER BY u.activo DESC, u.nombre_completo ASC';
    const rows = await query(sql);
    return res.json({ success: true, data: rows });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function createContador(req, res) {
  try {
    const nombre_completo = String(req.body.nombre_completo || '').trim();
    const email = String(req.body.email || '').toLowerCase().trim();
    const password = String(req.body.password || '').trim();
    if (!nombre_completo || !email || !password) {
      return res.status(400).json({ success: false, message: 'Nombre, email y contraseña requeridos.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const id = `CONT-${Date.now().toString(36)}`;
    const [existing] = await query('SELECT id FROM Usuarios WHERE LOWER(TRIM(email)) = ?', [email]);
    if (existing?.id) {
      await query(
        `UPDATE Usuarios SET nombre_completo = ?, password_hash = ?, rol_id = 'ROL-CONT-UUID', activo = 1 WHERE id = ?`,
        [nombre_completo, hash, existing.id]
      );
      return res.json({ success: true, id: existing.id, email, actualizado: true });
    }
    await query(
      `INSERT INTO Usuarios (id, rol_id, nombre_completo, email, password_hash, activo, is_synced)
       VALUES (?, 'ROL-CONT-UUID', ?, ?, ?, 1, 1)`,
      [id, nombre_completo, email, hash]
    );
    return res.json({ success: true, id, email });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function createCobrador(req, res) {
  try {
    const nombre_completo = String(req.body.nombre_completo || '').trim();
    const email = String(req.body.email || '').toLowerCase().trim();
    const password = String(req.body.password || '').trim();

    if (!nombre_completo || !email || !password) {
      return res.status(400).json({ success: false, message: 'Nombre, email y contraseña requeridos.' });
    }
    if (password.length < 4) {
      return res.status(400).json({ success: false, message: 'La contraseña debe tener al menos 4 caracteres.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const id = `COB-${Date.now().toString(36)}`;

    const [existing] = await query('SELECT id FROM Usuarios WHERE LOWER(TRIM(email)) = ?', [email]);

    if (existing?.id) {
      await query(
        `UPDATE Usuarios SET nombre_completo = ?, password_hash = ?, rol_id = 'ROL-COB-UUID', activo = 1, updated_at = NOW()
         WHERE id = ?`,
        [nombre_completo, hash, existing.id]
      );
      await ensureRutaForCobrador(existing.id, nombre_completo);
      return res.json({ success: true, id: existing.id, email, actualizado: true, ruta_creada: true });
    }

    await query(
      `INSERT INTO Usuarios (id, rol_id, nombre_completo, email, password_hash, activo, is_synced)
       VALUES (?, 'ROL-COB-UUID', ?, ?, ?, 1, 1)`,
      [id, nombre_completo, email, hash]
    );
    await ensureRutaForCobrador(id, nombre_completo);
    return res.json({ success: true, id, email, ruta_creada: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function updateCobrador(req, res) {
  try {
    const { id } = req.params;
    const nombre_completo = String(req.body.nombre_completo || '').trim();
    const email = String(req.body.email || '').toLowerCase().trim();
    const password = String(req.body.password || '').trim();
    const activo = req.body.activo === undefined ? undefined : req.body.activo ? 1 : 0;

    if (!nombre_completo || !email) {
      return res.status(400).json({ success: false, message: 'Nombre y email requeridos.' });
    }

    const [user] = await query(
      `SELECT u.id FROM Usuarios u JOIN Roles r ON u.rol_id = r.id WHERE u.id = ? AND r.nombre = 'COBRADOR'`,
      [id]
    );
    if (!user) return res.status(404).json({ success: false, message: 'Cobrador no encontrado.' });

    const [emailTaken] = await query(
      'SELECT id FROM Usuarios WHERE LOWER(TRIM(email)) = ? AND id != ?',
      [email, id]
    );
    if (emailTaken?.id) {
      return res.status(400).json({ success: false, message: 'Ese email ya esta en uso.' });
    }

    const params = [nombre_completo, email];
    let sql = `UPDATE Usuarios SET nombre_completo = ?, email = ?, updated_at = NOW()`;
    if (password) {
      if (password.length < 4) {
        return res.status(400).json({ success: false, message: 'La contrasena debe tener al menos 4 caracteres.' });
      }
      const hash = await bcrypt.hash(password, 10);
      sql += ', password_hash = ?';
      params.push(hash);
    }
    if (activo !== undefined) {
      sql += ', activo = ?';
      params.push(activo);
    }
    sql += ' WHERE id = ?';
    params.push(id);
    await query(sql, params);
    await ensureRutaForCobrador(id, nombre_completo);
    return res.json({ success: true, id });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function updateContador(req, res) {
  try {
    const { id } = req.params;
    const nombre_completo = String(req.body.nombre_completo || '').trim();
    const email = String(req.body.email || '').toLowerCase().trim();
    const password = String(req.body.password || '').trim();
    const activo = req.body.activo === undefined ? undefined : req.body.activo ? 1 : 0;

    if (!nombre_completo || !email) {
      return res.status(400).json({ success: false, message: 'Nombre y email requeridos.' });
    }

    const [user] = await query(
      `SELECT u.id FROM Usuarios u JOIN Roles r ON u.rol_id = r.id WHERE u.id = ? AND r.nombre = 'CONTADOR'`,
      [id]
    );
    if (!user) return res.status(404).json({ success: false, message: 'Contador no encontrado.' });

    const [emailTaken] = await query(
      'SELECT id FROM Usuarios WHERE LOWER(TRIM(email)) = ? AND id != ?',
      [email, id]
    );
    if (emailTaken?.id) {
      return res.status(400).json({ success: false, message: 'Ese email ya esta en uso.' });
    }

    const params = [nombre_completo, email];
    let sql = `UPDATE Usuarios SET nombre_completo = ?, email = ?, updated_at = NOW()`;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      sql += ', password_hash = ?';
      params.push(hash);
    }
    if (activo !== undefined) {
      sql += ', activo = ?';
      params.push(activo);
    }
    sql += ' WHERE id = ?';
    params.push(id);
    await query(sql, params);
    return res.json({ success: true, id });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function asignarCobrador(req, res) {
  try {
    const { rutaId } = req.params;
    const { cobrador_id } = req.body;
    await query(
      `UPDATE Rutas SET cobrador_id = ?, is_synced = 1, updated_at = NOW() WHERE id = ?`,
      [cobrador_id, rutaId]
    );
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function agregarClienteRuta(req, res) {
  try {
    const { rutaId } = req.params;
    const { cliente_id, orden_visita = 0 } = req.body;
    await query(
      `INSERT INTO Ruta_Clientes (ruta_id, cliente_id, orden_visita)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE orden_visita = VALUES(orden_visita)`,
      [rutaId, cliente_id, orden_visita]
    );
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function crearRuta(req, res) {
  try {
    const { nombre, descripcion, cobrador_id, clientes_ids = [] } = req.body;
    const rutaId = uuidv4();
    await query(
      `INSERT INTO Rutas (id, nombre, descripcion, cobrador_id, activa, is_synced)
       VALUES (?, ?, ?, ?, 1, 1)`,
      [rutaId, nombre, descripcion || null, cobrador_id || null]
    );
    let orden = 1;
    for (const cid of clientes_ids) {
      await query(
        `INSERT INTO Ruta_Clientes (ruta_id, cliente_id, orden_visita) VALUES (?, ?, ?)`,
        [rutaId, cid, orden++]
      );
    }
    return res.json({ success: true, id: rutaId });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function crearPrestamo(req, res) {
  const conn = await getConnection();
  try {
    const p = req.body;
    const operadorId = p.operador?.id || p.cobrador_registro_id || null;
    const id = p.id || uuidv4();
    await conn.beginTransaction();

    let fiadorId = p.fiador_id || null;
    const f = p.fiador || null;
    if (f && txt(f.nombre || f.nombre_completo)) {
      fiadorId = await upsertFiadorEnNube(conn, p.cliente_id, f, id);
      if (!fiadorId) {
        throw new Error('No se pudo registrar el fiador en la tabla Fiadores.');
      }
    }

    const [activoExistente] = await conn.execute(
      `SELECT id FROM Prestamos
       WHERE cliente_id = ? AND estado = 'Activo' AND deleted_at IS NULL
       LIMIT 1`,
      [p.cliente_id]
    );
    if (activoExistente.length) {
      throw new Error('Este cliente ya tiene un credito activo. Liquide o renueve antes de crear otro.');
    }

    await conn.execute(
      `INSERT INTO Prestamos (
        id, cliente_id, fiador_id,
        monto_desembolsado, plazo_semanas, tasa_interes_aplicada,
        cuota_semanal_base, monto_total_pagar, saldo_pendiente, frecuencia_semana,
        dias_de_cobro, periodicidad, estado, fecha_desembolso,
        cobrador_registro_id, cobrador_entrega_id, is_synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SEMANAL', 'Activo', ?, ?, ?, 1)`,
      [
        id,
        p.cliente_id,
        fiadorId,
        p.monto_desembolsado,
        p.plazo_semanas,
        p.tasa_interes_aplicada,
        p.cuota_semanal_base,
        p.monto_total_pagar,
        p.saldo_pendiente,
        p.frecuencia_semana || 1,
        typeof p.dias_de_cobro === 'string' ? p.dias_de_cobro : JSON.stringify(p.dias_de_cobro || ['LUNES']),
        p.fecha_desembolso,
        operadorId,
        p.cobrador_entrega_id || null,
      ]
    );
    for (const cuota of p.cuotas || []) {
      await conn.execute(
        `INSERT INTO Cuotas_Calendario (id, prestamo_id, fecha_programada, monto_programado, estado, is_synced)
         VALUES (?, ?, ?, ?, 'Programada', 1)`,
        [cuota.id || uuidv4(), id, cuota.fecha_programada, cuota.monto_programado]
      );
    }
    const [cliRows] = await conn.execute(
      'SELECT nombre_completo, telefono FROM Clientes WHERE id = ? LIMIT 1',
      [p.cliente_id]
    );
    await conn.commit();
    return res.json({
      success: true,
      id,
      cliente_whatsapp: datosWhatsAppCliente(cliRows[0]),
    });
  } catch (e) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function syncRutasCobradores(req, res) {
  try {
    const result = await sincronizarRutasCobradores();
    const cobradores = await query(
      `SELECT u.id FROM Usuarios u JOIN Roles r ON u.rol_id = r.id WHERE r.nombre = 'COBRADOR' AND u.activo = 1`
    );
    for (const c of cobradores) {
      await vincularClientesCobradorARuta(c.id);
    }
    return res.json({ success: true, ...result });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function optimizarRuta(req, res) {
  try {
    const { rutaId } = req.params;
    await optimizarOrdenRuta(rutaId);
    const clientes = await query(
      `SELECT c.nombre_completo, c.latitud, c.longitud, rc.orden_visita
       FROM Ruta_Clientes rc JOIN Clientes c ON rc.cliente_id = c.id
       WHERE rc.ruta_id = ? ORDER BY rc.orden_visita`,
      [rutaId]
    );
    return res.json({ success: true, data: clientes, centro: ESTELI_CENTRO });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function seedDemoEsteli(req, res) {
  const conn = await getConnection();
  try {
    await initSecuenciaCliente(query);
    await sincronizarRutasCobradores();

    const DEMO = [
      { primer_nombre: 'Norma', primer_apellido: 'Rostran', cedula: '001-120876-0015A', telefono: '8788-1234',
        direccion: 'Barrio San Juan, Esteli', actividad_economica: 'Ventas', latitud: 13.0882, longitud: -86.3578, monto: 8000 },
      { primer_nombre: 'Carlos', primer_apellido: 'Meza', cedula: '001-150990-0020B', telefono: '8654-5678',
        direccion: 'Barrio El Rosario, Esteli', actividad_economica: 'Taller', latitud: 13.0948, longitud: -86.3485, monto: 6000 },
      { primer_nombre: 'Maria', primer_apellido: 'Garcia', cedula: '001-080885-0035C', telefono: '8123-9012',
        direccion: 'Barrio La Trinidad, Esteli', actividad_economica: 'Pulperia', latitud: 13.0855, longitud: -86.3448, monto: 5000 },
    ];

    const hoy = new Date().toISOString().split('T')[0];
    const plazo = 12;
    const creados = [];

    await conn.beginTransaction();
    for (const d of DEMO) {
      const [existe] = await conn.execute('SELECT id FROM Clientes WHERE cedula = ?', [d.cedula]);
      if (existe.length) {
        creados.push({ id: existe[0].id, nombre: `${d.primer_nombre} ${d.primer_apellido}`, existente: true });
        continue;
      }

      const id = await nextClienteId(conn);
      const nc = `${d.primer_nombre} ${d.primer_apellido}`;
      await conn.execute(
        `INSERT INTO Clientes (id, primer_nombre, primer_apellido, nombre_completo, cedula, telefono, direccion, actividad_economica, latitud, longitud, is_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [id, d.primer_nombre, d.primer_apellido, nc, d.cedula, d.telefono, d.direccion, d.actividad_economica, d.latitud, d.longitud]
      );

      const tasa = 0.3;
      const total = d.monto * (1 + tasa);
      const cuota = total / plazo;
      const prestamoId = uuidv4();
      await conn.execute(
        `INSERT INTO Prestamos (id, cliente_id, monto_desembolsado, plazo_semanas, tasa_interes_aplicada,
          cuota_semanal_base, monto_total_pagar, saldo_pendiente, frecuencia_semana, dias_de_cobro, periodicidad, estado, fecha_desembolso, is_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3, ?, 'SEMANAL', 'Activo', ?, 1)`,
        [prestamoId, id, d.monto, plazo, tasa, cuota, total, total, JSON.stringify(['LUNES', 'MIERCOLES', 'VIERNES']), hoy]
      );

      for (let s = 0; s < plazo; s++) {
        const fecha = new Date();
        fecha.setDate(fecha.getDate() - (plazo - s - 1) * 7);
        await conn.execute(
          `INSERT INTO Cuotas_Calendario (id, prestamo_id, fecha_programada, monto_programado, estado, is_synced)
           VALUES (?, ?, ?, ?, 'Programada', 1)`,
          [uuidv4(), prestamoId, fecha.toISOString().split('T')[0], cuota]
        );
      }
      creados.push({ id, nombre: nc, barrio: d.direccion });
    }
    await conn.commit();
    return res.json({ success: true, data: creados, mensaje: '3 clientes demo de Esteli con prestamos activos' });
  } catch (e) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function listPagosDelDia(req, res) {
  try {
    const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
    const cobrador_id = req.query.cobrador_id || null;
    let sql = `
      SELECT pg.id, pg.prestamo_id, pg.cobrador_id, pg.monto_pagado, pg.fecha_pago,
             pg.latitud, pg.longitud, pg.updated_at,
             c.id AS cliente_id, c.nombre_completo, c.cedula, c.telefono,
             u.nombre_completo AS cobrador_nombre, p.saldo_pendiente, p.estado AS estado_prestamo,
             p.fecha_desembolso, p.plazo_semanas, p.dias_de_cobro
      FROM Pagos pg
      INNER JOIN Prestamos p ON pg.prestamo_id = p.id
      INNER JOIN Clientes c ON p.cliente_id = c.id
      LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
      WHERE pg.deleted_at IS NULL AND DATE(pg.fecha_pago) = DATE(?)
    `;
    const params = [fecha];
    if (cobrador_id) {
      sql += ' AND pg.cobrador_id = ?';
      params.push(cobrador_id);
    }
    sql += ' ORDER BY pg.fecha_pago DESC, c.nombre_completo ASC';
    const rows = await query(sql, params);
    return res.json({ success: true, data: rows, fecha });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function updatePago(req, res) {
  const conn = await getConnection();
  try {
    const { id } = req.params;
    const montoNuevo = Number(req.body.monto_pagado);
    const fechaNueva = req.body.fecha_pago || null;
    if (!Number.isFinite(montoNuevo) || montoNuevo <= 0) {
      return res.status(400).json({ success: false, message: 'Monto invalido' });
    }

    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT pg.id, pg.prestamo_id, pg.monto_pagado, pg.fecha_pago
       FROM Pagos pg WHERE pg.id = ? AND pg.deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Abono no encontrado' });
    }
    const pago = rows[0];
    const montoAnterior = Number(pago.monto_pagado);
    const diff = montoNuevo - montoAnterior;

    await conn.execute(
      `UPDATE Pagos SET monto_pagado = ?, fecha_pago = COALESCE(?, fecha_pago),
        updated_at = NOW(), is_synced = 1,
        editado_por_admin_at = CASE WHEN ? <> ? THEN NOW() ELSE editado_por_admin_at END
       WHERE id = ?`,
      [montoNuevo, fechaNueva, montoNuevo, montoAnterior, id]
    );

    if (diff !== 0) {
      await conn.execute(
        `UPDATE Prestamos SET saldo_pendiente = GREATEST(0, saldo_pendiente - ?), updated_at = NOW() WHERE id = ?`,
        [diff, pago.prestamo_id]
      );
      const [prest] = await conn.execute('SELECT saldo_pendiente FROM Prestamos WHERE id = ?', [pago.prestamo_id]);
      if (prest[0] && Number(prest[0].saldo_pendiente) <= 0) {
        await conn.execute(`UPDATE Prestamos SET estado = 'Pagado', updated_at = NOW() WHERE id = ?`, [pago.prestamo_id]);
      } else {
        await conn.execute(`UPDATE Prestamos SET estado = 'Activo', updated_at = NOW() WHERE id = ?`, [pago.prestamo_id]);
      }
    }

    await conn.execute(
      `UPDATE Solicitudes_Correccion_Cobro SET estado = 'RESUELTA', updated_at = NOW()
       WHERE pago_id = ? AND estado = 'PENDIENTE' AND deleted_at IS NULL`,
      [id]
    );

    await conn.commit();
    const [actualizado] = await conn.execute(
      `SELECT pg.*, c.nombre_completo, c.cedula, p.saldo_pendiente
       FROM Pagos pg
       JOIN Prestamos p ON pg.prestamo_id = p.id
       JOIN Clientes c ON p.cliente_id = c.id
       WHERE pg.id = ?`,
      [id]
    );
    return res.json({ success: true, data: actualizado[0] });
  } catch (e) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function listSolicitudesCorreccion(req, res) {
  try {
    const estado = req.query.estado || 'PENDIENTE';
    const rows = await query(
      `SELECT s.id, s.pago_id, s.cobrador_id, s.prestamo_id, s.cliente_nombre,
              s.monto_registrado, s.motivo, s.estado, s.created_at,
              pg.monto_pagado, pg.fecha_pago,
              u.nombre_completo AS cobrador_nombre, c.cedula
       FROM Solicitudes_Correccion_Cobro s
       INNER JOIN Pagos pg ON s.pago_id = pg.id
       INNER JOIN Prestamos p ON pg.prestamo_id = p.id
       INNER JOIN Clientes c ON p.cliente_id = c.id
       LEFT JOIN Usuarios u ON s.cobrador_id = u.id
       WHERE s.estado = ? AND s.deleted_at IS NULL
       ORDER BY s.created_at DESC`,
      [estado]
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function renovacion(req, res) {
  const conn = await getConnection();
  try {
    const { prestamo_anterior_id, nuevo_prestamo, log, operador } = req.body;
    const operadorId = operador?.id || nuevo_prestamo?.cobrador_registro_id || null;
    const operadorNombre = operador?.nombre || null;
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE Prestamos SET estado = 'Cerrado por Renovación', saldo_pendiente = 0, updated_at = NOW() WHERE id = ?`,
      [prestamo_anterior_id]
    );
    const np = nuevo_prestamo;
    const entregaId = np.cobrador_entrega_id || operadorId || null;
    await conn.execute(
      `INSERT INTO Prestamos (
        id, cliente_id, monto_desembolsado, plazo_semanas, tasa_interes_aplicada,
        cuota_semanal_base, monto_total_pagar, saldo_pendiente, dias_de_cobro,
        renovacion_previa_id, estado, fecha_desembolso,
        cobrador_registro_id, cobrador_entrega_id, is_synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Activo', ?, ?, ?, 1)`,
      [
        np.id, np.cliente_id, np.monto_desembolsado, np.plazo_semanas, np.tasa_interes_aplicada,
        np.cuota_semanal_base, np.monto_total_pagar, np.saldo_pendiente,
        typeof np.dias_de_cobro === 'string' ? np.dias_de_cobro : JSON.stringify(np.dias_de_cobro || ['LUNES']),
        prestamo_anterior_id, np.fecha_desembolso,
        operadorId,
        entregaId,
      ]
    );
    await conn.execute(
      `INSERT INTO Renovaciones_Log (
        id, prestamo_anterior_id, prestamo_nuevo_id, saldo_pendiente_anterior, nuevo_desembolso,
        base_nominal, tasa_aplicada, monto_total_a_pagar, cuota_semanal, fecha_renovacion,
        cobrador_opero_id, cobrador_entrega_id, is_synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, 1)`,
      [
        log.id || uuidv4(), prestamo_anterior_id, np.id, log.saldo_pendiente_anterior,
        log.nuevo_desembolso, log.base_nominal, log.tasa_aplicada, log.monto_total_a_pagar, log.cuota_semanal,
        operadorId,
        log.cobrador_entrega_id || entregaId,
      ]
    );
    for (const c of np.cuotas || []) {
      await conn.execute(
        `INSERT INTO Cuotas_Calendario (id, prestamo_id, fecha_programada, monto_programado, estado, is_synced)
         VALUES (?, ?, ?, ?, 'Programada', 1)`,
        [c.id || uuidv4(), np.id, c.fecha_programada, c.monto_programado]
      );
    }
    const [cliRows] = await conn.execute(
      'SELECT nombre_completo, telefono FROM Clientes WHERE id = ? LIMIT 1',
      [np.cliente_id]
    );
    await conn.commit();
    return res.json({
      success: true,
      id: np.id,
      operador_nombre: operadorNombre,
      cliente_whatsapp: datosWhatsAppCliente(cliRows[0]),
    });
  } catch (e) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function getReporte(req, res) {
  const { tipo } = req.params;
  const desde = req.query.desde || '2020-01-01';
  const hasta = req.query.hasta || '2099-12-31';
  const ts = new Date().toISOString();

  try {
    switch (tipo) {
      case 'colocacion': {
        const datos = await query(
          `SELECT COUNT(DISTINCT id) AS prestamos_totales,
                  COALESCE(SUM(monto_desembolsado),0) AS monto_colocado,
                  COALESCE(SUM(monto_total_pagar - monto_desembolsado),0) AS interes_generado,
                  COUNT(DISTINCT cliente_id) AS clientes_atendidos
           FROM Prestamos
           WHERE deleted_at IS NULL AND fecha_desembolso BETWEEN ? AND ?`,
          [desde, hasta]
        );
        const filas = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula,
                  p.id AS prestamo_id, p.fecha_desembolso,
                  p.monto_desembolsado, p.monto_total_pagar, p.estado
           FROM Prestamos p
           JOIN Clientes c ON p.cliente_id = c.id
           WHERE p.deleted_at IS NULL AND p.fecha_desembolso BETWEEN ? AND ?
           ORDER BY p.fecha_desembolso DESC`,
          [desde, hasta]
        );
        return res.json({
          success: true,
          data: { tipo: 'COLOCACIÓN', periodo: { desde, hasta }, datos: datos[0], filas, timestamp: ts },
        });
      }
      case 'recuperacion': {
        const resumen = await query(
          `SELECT COUNT(DISTINCT id) AS pagos_recibidos,
                  COALESCE(SUM(monto_pagado),0) AS monto_recuperado
           FROM Pagos WHERE deleted_at IS NULL AND DATE(fecha_pago) BETWEEN ? AND ?`,
          [desde, hasta]
        );
        const detallePorCobrador = await query(
          `SELECT u.nombre_completo AS cobrador, COUNT(p.id) AS pagos, COALESCE(SUM(p.monto_pagado),0) AS monto
           FROM Pagos p JOIN Usuarios u ON p.cobrador_id = u.id
           WHERE p.deleted_at IS NULL AND DATE(p.fecha_pago) BETWEEN ? AND ?
           GROUP BY u.id, u.nombre_completo ORDER BY monto DESC`,
          [desde, hasta]
        );
        return res.json({
          success: true,
          data: { tipo: 'RECUPERACIÓN', periodo: { desde, hasta }, resumen: resumen[0], detallePorCobrador, timestamp: ts },
        });
      }
      case 'cartera': {
        const resumen = await query(
          `SELECT COUNT(*) AS prestamos_activos,
                  COALESCE(SUM(saldo_pendiente),0) AS saldo_total,
                  COALESCE(SUM(monto_desembolsado),0) AS capital_colocado,
                  COALESCE(AVG(saldo_pendiente),0) AS saldo_promedio
           FROM Prestamos WHERE deleted_at IS NULL AND estado = 'Activo'`
        );
        const porEstado = await query(
          `SELECT estado, COUNT(*) AS cantidad, COALESCE(SUM(saldo_pendiente),0) AS monto
           FROM Prestamos WHERE deleted_at IS NULL GROUP BY estado`
        );
        return res.json({
          success: true,
          data: { tipo: 'CARTERA ACTIVA', resumen: resumen[0], porEstado, timestamp: ts },
        });
      }
      case 'riesgo': {
        const saldos = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula,
                  p.id AS prestamo_id, p.saldo_pendiente,
                  p.cuota_semanal_base, p.estado,
                  COUNT(cc.id) AS cuotas_vencidas
           FROM Clientes c
           JOIN Prestamos p ON c.id = p.cliente_id
           LEFT JOIN Cuotas_Calendario cc ON p.id = cc.prestamo_id
             AND cc.estado = 'Programada' AND cc.fecha_programada < CURDATE()
           WHERE p.estado = 'Activo' AND p.deleted_at IS NULL
           GROUP BY c.id, c.nombre_completo, c.cedula, p.id, p.saldo_pendiente, p.cuota_semanal_base, p.estado`
        );
        const riesgoAlto = saldos.filter((s) => s.cuotas_vencidas > 2);
        const riesgoMedio = saldos.filter((s) => s.cuotas_vencidas >= 1 && s.cuotas_vencidas <= 2);
        const sinRiesgo = saldos.filter((s) => !s.cuotas_vencidas);
        const sum = (arr) => arr.reduce((a, r) => a + Number(r.saldo_pendiente || 0), 0);
        return res.json({
          success: true,
          data: {
            tipo: 'SALDOS EN RIESGO',
            resumen: {
              riesgoAlto: { cantidad: riesgoAlto.length, monto: sum(riesgoAlto) },
              riesgoMedio: { cantidad: riesgoMedio.length, monto: sum(riesgoMedio) },
              sinRiesgo: { cantidad: sinRiesgo.length },
            },
            detalles: { riesgoAlto, riesgoMedio },
            timestamp: ts,
          },
        });
      }
      case 'cobradores': {
        const filas = await query(
          `SELECT u.nombre_completo AS cobrador,
                  COUNT(DISTINCT p.id) AS pagos,
                  COALESCE(SUM(p.monto_pagado),0) AS monto_cobrado,
                  COUNT(DISTINCT g.id) AS gestiones_no_pago
           FROM Usuarios u
           JOIN Roles r ON u.rol_id = r.id
           LEFT JOIN Pagos p ON p.cobrador_id = u.id AND p.deleted_at IS NULL AND DATE(p.fecha_pago) BETWEEN ? AND ?
           LEFT JOIN Gestiones_No_Pago g ON g.cobrador_id = u.id AND DATE(g.fecha_gestion) BETWEEN ? AND ?
           WHERE r.nombre = 'COBRADOR' AND u.deleted_at IS NULL
           GROUP BY u.id, u.nombre_completo ORDER BY monto_cobrado DESC`,
          [desde, hasta, desde, hasta]
        );
        return res.json({
          success: true,
          data: { tipo: 'DESEMPEÑO COBRADORES', periodo: { desde, hasta }, filas, timestamp: ts },
        });
      }
      case 'liquidaciones': {
        const filas = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula,
                  p.id AS prestamo_id, p.fecha_desembolso, p.monto_desembolsado,
                  p.monto_total_pagar, p.updated_at AS fecha_liquidacion
           FROM Prestamos p JOIN Clientes c ON p.cliente_id = c.id
           WHERE p.estado = 'Pagado' AND p.deleted_at IS NULL
             AND DATE(p.updated_at) BETWEEN ? AND ?
           ORDER BY p.updated_at DESC`,
          [desde, hasta]
        );
        return res.json({
          success: true,
          data: { tipo: 'PRÉSTAMOS LIQUIDADOS', periodo: { desde, hasta }, filas, cantidad: filas.length, timestamp: ts },
        });
      }
      case 'gestiones': {
        const resumen = await query(
          `SELECT COUNT(*) AS total, COUNT(DISTINCT prestamo_id) AS prestamos_afectados
           FROM Gestiones_No_Pago
           WHERE deleted_at IS NULL AND DATE(fecha_gestion) BETWEEN ? AND ?`,
          [desde, hasta]
        );
        const porMotivo = await query(
          `SELECT motivo, COUNT(*) AS cantidad
           FROM Gestiones_No_Pago
           WHERE deleted_at IS NULL AND DATE(fecha_gestion) BETWEEN ? AND ?
           GROUP BY motivo ORDER BY cantidad DESC`,
          [desde, hasta]
        );
        return res.json({
          success: true,
          data: { tipo: 'GESTIONES NO PAGO', periodo: { desde, hasta }, resumen: resumen[0], porMotivo, timestamp: ts },
        });
      }
      case 'clientes-nuevos': {
        const filas = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula, c.telefono,
                  c.direccion, COALESCE(u.nombre_completo, 'Sin asignar') AS cobrador,
                  COALESCE(c.created_at, c.updated_at) AS created_at
           FROM Clientes c
           LEFT JOIN Usuarios u ON c.cobrador_id = u.id
           WHERE c.deleted_at IS NULL
             AND DATE(COALESCE(c.created_at, c.updated_at)) BETWEEN ? AND ?
           ORDER BY COALESCE(c.created_at, c.updated_at) DESC`,
          [desde, hasta]
        );
        return res.json({
          success: true,
          data: { tipo: 'CLIENTES NUEVOS', periodo: { desde, hasta }, filas, cantidad: filas.length, timestamp: ts },
        });
      }
      case 'arqueo': {
        const resumen = await query(
          `SELECT COUNT(*) AS cierres_registrados,
                  COALESCE(SUM(monto_efectivo), 0) AS monto_total_entregado,
                  COALESCE(SUM(transacciones), 0) AS transacciones_totales
           FROM Cierre_Caja
           WHERE deleted_at IS NULL AND fecha_cierre BETWEEN ? AND ?`,
          [desde, hasta]
        );
        const filas = await query(
          `SELECT c.id, u.nombre_completo AS cobrador, c.fecha_cierre,
                  c.monto_efectivo, c.transacciones, c.latitud, c.longitud
           FROM Cierre_Caja c
           JOIN Usuarios u ON c.cobrador_id = u.id
           WHERE c.deleted_at IS NULL AND c.fecha_cierre BETWEEN ? AND ?
           ORDER BY c.fecha_cierre DESC, u.nombre_completo`,
          [desde, hasta]
        );
        const row = resumen[0] || {};
        return res.json({
          success: true,
          data: {
            tipo: 'ARQUEO DE CAJA',
            periodo: { desde, hasta },
            caja: {
              cierres_registrados: Number(row.cierres_registrados || 0),
              monto_total_entregado: Number(row.monto_total_entregado || 0),
              transacciones_totales: Number(row.transacciones_totales || 0),
            },
            filas,
            timestamp: ts,
          },
        });
      }
      default:
        return res.status(404).json({ success: false, message: `Reporte desconocido: ${tipo}` });
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function resetPasswordUsuario(req, res) {
  try {
    const { id } = req.params;
    const custom = String(req.body.password || '').trim();
    const password = custom || crypto.randomBytes(4).toString('hex');
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    const rows = await query(
      `SELECT u.nombre_completo, u.email, r.nombre AS rol
       FROM Usuarios u
       JOIN Roles r ON u.rol_id = r.id
       WHERE u.id = ?`,
      [id]
    );
    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Usuario no encontrado.' });
    }
    const u = rows[0];
    if (u.rol === 'ADMIN') {
      return res.status(403).json({ success: false, message: 'No se puede restablecer la contraseña del administrador desde aquí.' });
    }

    const hash = await bcrypt.hash(password, 10);
    await query(`UPDATE Usuarios SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [hash, id]);
    return res.json({
      success: true,
      password,
      email: u.email,
      nombre: u.nombre_completo,
      rol: u.rol,
      message: 'Contraseña restablecida correctamente.',
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function getCumplimientoRuta(req, res) {
  try {
    const { fechaCalendarioISO } = require('../utils/diasCobro');
    const fecha = req.query.fecha || fechaCalendarioISO();
    const cobradorId = req.query.cobrador_id || null;
    const incluirVisitas = req.query.detalle === '1' || !!cobradorId;

    const cobradores = cobradorId
      ? await query(
          `SELECT u.id, u.nombre_completo FROM Usuarios u
           JOIN Roles r ON u.rol_id = r.id
           WHERE u.id = ? AND r.nombre = 'COBRADOR' AND u.activo = 1`,
          [cobradorId]
        )
      : await query(
          `SELECT u.id, u.nombre_completo FROM Usuarios u
           JOIN Roles r ON u.rol_id = r.id
           WHERE r.nombre = 'COBRADOR' AND u.activo = 1
           ORDER BY u.nombre_completo`
        );

    let filas;
    let dia_cobro;
    if (cobradorId && cobradores.length) {
      const uno = await buildAgendaCobrador(query, cobradorId, fecha);
      const cierres = await query(
        `SELECT monto_efectivo, transacciones FROM Cierre_Caja
         WHERE cobrador_id = ? AND DATE(fecha_cierre) = DATE(?) AND deleted_at IS NULL LIMIT 1`,
        [cobradorId, fecha]
      );
      dia_cobro = uno.dia_cobro;
      filas = [
        {
          cobrador_id: cobradores[0].id,
          cobrador: cobradores[0].nombre_completo,
          ...uno.resumen,
          cierre_caja: cierres[0]
            ? {
                monto_efectivo: Number(cierres[0].monto_efectivo),
                transacciones: Number(cierres[0].transacciones),
              }
            : null,
          visitas: uno.agenda,
        },
      ];
    } else {
      const batch = await buildCumplimientoBatch(query, cobradores, fecha, { incluirVisitas });
      dia_cobro = batch.dia_cobro;
      filas = batch.cobradores;
    }

    let totVisitas = 0;
    let totVisitadas = 0;
    let totMonto = 0;
    for (const f of filas) {
      totVisitas += f.total_visitas || 0;
      totVisitadas += f.visitadas || 0;
      totMonto += f.monto_cobrado || 0;
    }

    return res.json({
      success: true,
      data: {
        fecha,
        dia_cobro,
        resumen_global: {
          cobradores: filas.length,
          total_visitas: totVisitas,
          visitadas: totVisitadas,
          pendientes: totVisitas - totVisitadas,
          porcentaje: totVisitas ? Math.round((totVisitadas / totVisitas) * 100) : 0,
          monto_cobrado: totMonto,
        },
        cobradores: filas,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function validarCargaMasiva(req, res) {
  try {
    const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    if (!filas.length) {
      return res.status(400).json({ success: false, message: 'Envie un arreglo "filas" con al menos una fila.' });
    }
    if (filas.length > 500) {
      return res.status(400).json({ success: false, message: 'Maximo 500 filas por solicitud.' });
    }
    const data = await validarFilas(filas, query);
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function importarCargaMasiva(req, res) {
  try {
    const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    if (!filas.length) {
      return res.status(400).json({ success: false, message: 'Envie un arreglo "filas" con al menos una fila.' });
    }
    if (filas.length > 500) {
      return res.status(400).json({ success: false, message: 'Maximo 500 filas por solicitud.' });
    }
    const data = await importarFilas(filas, query, getConnection, {
      optimizar_rutas: req.body?.optimizar_rutas === true,
    });
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

module.exports = {
  getRespaldoSql,
  getKpis,
  getReporte,
  listClientes,
  createCliente,
  updateCliente,
  asignarClienteCobrador,
  getSecuenciaCliente,
  listPrestamosActivos,
  patchReciboFisicoPrestamo,
  updatePrestamoFrecuencia,
  listRutas,
  listCobradores,
  listContadores,
  createCobrador,
  updateCobrador,
  createContador,
  updateContador,
  resetPasswordUsuario,
  getPermisos,
  setPermisos,
  getParametrosFinancieros,
  setParametrosFinancieros,
  asignarCobrador,
  agregarClienteRuta,
  crearRuta,
  crearPrestamo,
  renovacion,
  listPagosDelDia,
  updatePago,
  listSolicitudesCorreccion,
  syncRutasCobradores,
  optimizarRuta,
  seedDemoEsteli,
  getCumplimientoRuta,
  validarCargaMasiva,
  importarCargaMasiva,
  esIdClienteOficial,
  camposCliente,
  nextClienteId,
};
