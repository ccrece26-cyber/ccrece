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
  sincronizarRutaClienteAsignado,
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
const { runAuditoriaIntegridad } = require('../utils/auditoriaIntegridad');
const {
  validarFilas: validarFilasGarantias,
  importarFilas: importarFilasGarantias,
} = require('../utils/cargaMasivaGarantias');
const { normalizarCedula, validarCedula } = require('../utils/cedulaNic');
const { datosWhatsAppCliente } = require('../utils/whatsappCliente');
const { aplicarProrrogaEnNube } = require('../utils/prorrogasNube');
const { aplicarCastigoPerdidaEnNube } = require('../utils/castigoPerdidaNube');
const { armarReportePerdidas } = require('../utils/reportePerdidas');
const { armarReporteVencidos } = require('../utils/reporteVencidos');
const { aplicarMontoACuotas, revertirMontoDeCuotas, recalcularSaldoPrestamoDesdeCuotas } = require('../utils/registrarPagoNube');
const { rangoDiaLocal, rangoPeriodoLocal, desdeCorreccionesUnix } = require('../utils/fechasSql');
const { hoyISO } = require('../utils/zonaHoraria');
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
  latitud_cobro: c.latitud_cobro != null && c.latitud_cobro !== '' ? Number(c.latitud_cobro) : null,
  longitud_cobro: c.longitud_cobro != null && c.longitud_cobro !== '' ? Number(c.longitud_cobro) : null,
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
        latitud, longitud, latitud_cobro, longitud_cobro, cobrador_id, is_synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id, c.primer_nombre, c.segundo_nombre, c.primer_apellido, c.segundo_apellido,
        c.nombre_completo, c.cedula, c.telefono, c.direccion, c.actividad_economica,
        c.latitud, c.longitud, c.latitud_cobro, c.longitud_cobro, c.cobrador_id,
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
      await sincronizarRutaClienteAsignado(id, c.cobrador_id, cob[0].nombre_completo, conn);
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
        latitud_cobro = COALESCE(?, latitud_cobro), longitud_cobro = COALESCE(?, longitud_cobro),
        cobrador_id = ?, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [
        c.primer_nombre, c.segundo_nombre, c.primer_apellido, c.segundo_apellido,
        c.nombre_completo, c.cedula, c.telefono, c.direccion, c.actividad_economica,
        c.latitud, c.longitud, c.latitud_cobro, c.longitud_cobro, c.cobrador_id, id,
      ]
    );

    if (c.cobrador_id) {
      const [cob] = await query('SELECT nombre_completo FROM Usuarios WHERE id = ?', [c.cobrador_id]);
      const rutaId = await sincronizarRutaClienteAsignado(id, c.cobrador_id, cob?.nombre_completo);
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
      const rutaId = await sincronizarRutaClienteAsignado(id, cobrador_id, cob?.nombre_completo);
      await optimizarOrdenRuta(rutaId);
      return res.json({ success: true, ruta_id: rutaId, mensaje: 'Cliente agregado a ruta optimizada' });
    }

    await sincronizarRutaClienteAsignado(id, null);
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
    const fecha = req.query.fecha || hoyISO();
    const { inicio, fin } = rangoDiaLocal(fecha);
    const cobrador_id = req.query.cobrador_id || null;
    let sql = `
      SELECT pg.id, pg.prestamo_id, pg.cobrador_id, pg.monto_pagado, pg.fecha_pago,
             pg.latitud, pg.longitud, pg.updated_at, pg.editado_por_admin_at,
             pg.registrado_por_admin, pg.operador_id,
             c.id AS cliente_id, c.nombre_completo, c.cedula, c.telefono, c.cobrador_id AS cliente_cobrador_id,
             COALESCE(u.nombre_completo, uc.nombre_completo) AS cobrador_nombre,
             p.saldo_pendiente, p.estado AS estado_prestamo,
             p.fecha_desembolso, p.plazo_semanas, p.dias_de_cobro
      FROM Pagos pg
      INNER JOIN Prestamos p ON pg.prestamo_id = p.id
      INNER JOIN Clientes c ON p.cliente_id = c.id
      LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
      LEFT JOIN Usuarios uc ON c.cobrador_id = uc.id
      WHERE pg.deleted_at IS NULL AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
    `;
    const params = [inicio, fin];
    if (cobrador_id) {
      sql += ' AND (pg.cobrador_id = ? OR pg.operador_id = ? OR c.cobrador_id = ?)';
      params.push(cobrador_id, cobrador_id, cobrador_id);
    }
    sql += ' ORDER BY pg.fecha_pago DESC, c.nombre_completo ASC';
    const rows = await query(sql, params);
    return res.json({ success: true, data: rows, fecha, inicio, fin });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

/** Cobros nuevos de cobradores desde timestamp (aviso local admin si no hay push token). */
async function avisosCobrosCobrador(req, res) {
  try {
    const desde = req.query.desde || new Date(Date.now() - 3600000).toISOString();
    const desdeTs = desdeCorreccionesUnix(desde);
    const cobros = await query(
      `SELECT pg.id, pg.prestamo_id, pg.monto_pagado, pg.fecha_pago, pg.cobrador_id,
              c.nombre_completo AS cliente_nombre,
              COALESCE(u.nombre_completo, uc.nombre_completo) AS cobrador_nombre
       FROM Pagos pg
       INNER JOIN Prestamos p ON pg.prestamo_id = p.id
       INNER JOIN Clientes c ON p.cliente_id = c.id
       LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
       LEFT JOIN Usuarios uc ON c.cobrador_id = uc.id
       WHERE pg.deleted_at IS NULL
         AND COALESCE(pg.registrado_por_admin, 0) = 0
         AND UNIX_TIMESTAMP(pg.fecha_pago) > ?
       ORDER BY pg.fecha_pago DESC
       LIMIT 30`,
      [desdeTs]
    );
    return res.json({
      success: true,
      desde,
      nuevos: cobros.length,
      cobros,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

/** Abonos con detalle de cuotas por cliente (día, mes o rango). */
async function listPagosDetalle(req, res) {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const desde = req.query.desde || req.query.fecha || hoy;
    const hasta = req.query.hasta || req.query.fecha || desde;
    const cobrador_id = req.query.cobrador_id || null;

    let sqlPagos = `
      SELECT pg.id, pg.prestamo_id, pg.cobrador_id, pg.monto_pagado, pg.fecha_pago,
             c.id AS cliente_id, c.nombre_completo, c.cedula, c.telefono,
             u.nombre_completo AS cobrador_nombre,
             p.saldo_pendiente, p.cuota_semanal_base, p.estado AS estado_prestamo
      FROM Pagos pg
      INNER JOIN Prestamos p ON pg.prestamo_id = p.id AND p.deleted_at IS NULL
      INNER JOIN Clientes c ON p.cliente_id = c.id AND c.deleted_at IS NULL
      LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
      WHERE pg.deleted_at IS NULL AND DATE(pg.fecha_pago) BETWEEN DATE(?) AND DATE(?)
    `;
    const paramsPagos = [desde, hasta];
    if (cobrador_id) {
      sqlPagos += ' AND pg.cobrador_id = ?';
      paramsPagos.push(cobrador_id);
    }
    sqlPagos += ' ORDER BY c.nombre_completo ASC, pg.fecha_pago ASC';
    const pagos = await query(sqlPagos, paramsPagos);

    if (!pagos.length) {
      return res.json({ success: true, desde, hasta, pagos: [], cuotas: [], clientes: [] });
    }

    const prestamoIds = [...new Set(pagos.map((p) => p.prestamo_id))];
    const ph = prestamoIds.map(() => '?').join(',');

    const cuotas = await query(
      `SELECT cc.id AS cuota_id, cc.prestamo_id, cc.fecha_programada,
              cc.monto_programado, cc.monto_pagado, cc.estado AS estado_cuota,
              cc.updated_at AS cuota_actualizada,
              c.id AS cliente_id, c.nombre_completo, c.cedula, c.telefono,
              p.saldo_pendiente, p.cuota_semanal_base,
              uc.nombre_completo AS cobrador_nombre,
              (SELECT COUNT(*) FROM Cuotas_Calendario q
               WHERE q.prestamo_id = cc.prestamo_id AND q.deleted_at IS NULL
                 AND q.fecha_programada < cc.fecha_programada) + 1 AS numero_cuota
       FROM Cuotas_Calendario cc
       INNER JOIN Prestamos p ON cc.prestamo_id = p.id AND p.deleted_at IS NULL
       INNER JOIN Clientes c ON p.cliente_id = c.id AND c.deleted_at IS NULL
       LEFT JOIN Usuarios uc ON c.cobrador_id = uc.id
       WHERE cc.deleted_at IS NULL
         AND cc.prestamo_id IN (${ph})
         AND cc.estado IN ('Pagada', 'Parcial')
         AND COALESCE(cc.monto_pagado, 0) > 0.009
       ORDER BY c.nombre_completo ASC, cc.fecha_programada ASC`,
      prestamoIds
    );

    const abonosPorCliente = new Map();
    for (const pg of pagos) {
      const key = pg.cliente_id;
      abonosPorCliente.set(key, (abonosPorCliente.get(key) || 0) + Number(pg.monto_pagado || 0));
    }

    const cuotasMarcadas = cuotas.map((cc) => {
      const upd = cc.cuota_actualizada ? new Date(cc.cuota_actualizada) : null;
      const updIso = upd && !Number.isNaN(upd.getTime()) ? upd.toISOString().slice(0, 10) : null;
      const abonoEnPeriodo = updIso && updIso >= desde && updIso <= hasta;
      return {
        ...cc,
        abono_en_fecha: abonoEnPeriodo ? 'SI' : 'NO',
        abono_en_periodo: abonoEnPeriodo ? 'SI' : 'NO',
      };
    });

    const porCliente = new Map();
    for (const pg of pagos) {
      const key = pg.cliente_id;
      if (!porCliente.has(key)) {
        porCliente.set(key, {
          cliente_id: pg.cliente_id,
          nombre_completo: pg.nombre_completo,
          cedula: pg.cedula,
          telefono: pg.telefono,
          cobrador_nombre: pg.cobrador_nombre,
          prestamo_id: pg.prestamo_id,
          saldo_pendiente: pg.saldo_pendiente,
          abono_periodo: abonosPorCliente.get(key) || 0,
          abono_dia: abonosPorCliente.get(key) || 0,
          cuotas: [],
        });
      }
    }
    for (const cc of cuotasMarcadas) {
      const cli = porCliente.get(cc.cliente_id);
      if (cli) cli.cuotas.push(cc);
    }

    const clientes = [...porCliente.values()].map((c) => ({
      ...c,
      total_cuotas_pagadas: c.cuotas.length,
      cuotas_abonadas_periodo: c.cuotas.filter((q) => q.abono_en_periodo === 'SI').length,
      cuotas_abonadas_hoy: c.cuotas.filter((q) => q.abono_en_periodo === 'SI').length,
    }));

    return res.json({
      success: true,
      desde,
      hasta,
      fecha: desde === hasta ? desde : null,
      pagos: pagos.map((p) => ({ ...p, codigo_cliente: p.cliente_id })),
      cuotas: cuotasMarcadas.map((c) => ({ ...c, codigo_cliente: c.cliente_id })),
      clientes: clientes.map((c) => ({ ...c, codigo_cliente: c.cliente_id })),
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

/** Estado de cuenta: préstamo, cuotas y abonos de un cliente. */
async function getEstadoCuentaCliente(req, res) {
  try {
    const { id } = req.params;
    const clientes = await query(
      `SELECT c.*, uc.nombre_completo AS cobrador_nombre
       FROM Clientes c
       LEFT JOIN Usuarios uc ON c.cobrador_id = uc.id
       WHERE c.id = ? AND c.deleted_at IS NULL
       LIMIT 1`,
      [id]
    );
    if (!clientes.length) {
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }
    const cliente = clientes[0];

    const prestamos = await query(
      `SELECT p.*, ur.nombre_completo AS registrado_por, ue.nombre_completo AS entregado_por
       FROM Prestamos p
       LEFT JOIN Usuarios ur ON p.cobrador_registro_id = ur.id
       LEFT JOIN Usuarios ue ON p.cobrador_entrega_id = ue.id
       WHERE p.cliente_id = ? AND p.deleted_at IS NULL
       ORDER BY p.fecha_desembolso DESC`,
      [id]
    );

    const prestamoActivo = prestamos.find((p) => p.estado === 'Activo') || prestamos[0] || null;
    let cuotas = [];
    let pagos = [];

    if (prestamoActivo) {
      cuotas = await query(
        `SELECT cc.id AS cuota_id, cc.fecha_programada, cc.monto_programado, cc.monto_pagado,
                cc.estado AS estado_cuota, cc.updated_at,
                (SELECT COUNT(*) FROM Cuotas_Calendario q
                 WHERE q.prestamo_id = cc.prestamo_id AND q.deleted_at IS NULL
                   AND q.fecha_programada < cc.fecha_programada) + 1 AS numero_cuota
         FROM Cuotas_Calendario cc
         WHERE cc.prestamo_id = ? AND cc.deleted_at IS NULL
         ORDER BY cc.fecha_programada ASC`,
        [prestamoActivo.id]
      );

      pagos = await query(
        `SELECT pg.id, pg.monto_pagado, pg.fecha_pago, pg.registrado_por_admin,
                u.nombre_completo AS cobrador_nombre
         FROM Pagos pg
         LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
         WHERE pg.prestamo_id = ? AND pg.deleted_at IS NULL
         ORDER BY pg.fecha_pago ASC`,
        [prestamoActivo.id]
      );
    }

    const totalAbonado = pagos.reduce((s, p) => s + Number(p.monto_pagado || 0), 0);
    const cuotasPagadas = cuotas.filter((c) => c.estado_cuota === 'Pagada').length;
    const cuotasPendientes = cuotas.filter((c) => ['Programada', 'Parcial'].includes(c.estado_cuota)).length;

    return res.json({
      success: true,
      cliente: { ...cliente, codigo_cliente: cliente.id },
      prestamo_activo: prestamoActivo,
      prestamos,
      cuotas,
      pagos,
      resumen: {
        saldo_pendiente: prestamoActivo ? Number(prestamoActivo.saldo_pendiente) : 0,
        total_abonado: totalAbonado,
        cuotas_pagadas: cuotasPagadas,
        cuotas_pendientes: cuotasPendientes,
        estado_prestamo: prestamoActivo?.estado || 'Sin préstamo',
      },
    });
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
        updated_at = NOW(), is_synced = 1, editado_por_admin_at = NOW()
       WHERE id = ?`,
      [montoNuevo, fechaNueva, id]
    );

    if (diff !== 0) {
      if (diff > 0) {
        await aplicarMontoACuotas(conn, pago.prestamo_id, diff);
      } else {
        await revertirMontoDeCuotas(conn, pago.prestamo_id, Math.abs(diff));
      }
      await conn.execute(
        `UPDATE Prestamos SET saldo_pendiente = GREATEST(0, saldo_pendiente - ?), updated_at = NOW(), is_synced = 1 WHERE id = ?`,
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

/** Anula un abono (soft delete): revierte cuotas y saldo como si no hubiera cobro. */
async function deletePago(req, res) {
  const conn = await getConnection();
  try {
    const { id } = req.params;

    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT pg.id, pg.prestamo_id, pg.monto_pagado, pg.cobrador_id
       FROM Pagos pg WHERE pg.id = ? AND pg.deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Abono no encontrado o ya anulado' });
    }

    const pago = rows[0];
    const monto = Number(pago.monto_pagado);
    if (!Number.isFinite(monto) || monto <= 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Monto invalido' });
    }

    await revertirMontoDeCuotas(conn, pago.prestamo_id, monto);
    const saldoNuevo = await recalcularSaldoPrestamoDesdeCuotas(conn, pago.prestamo_id);

    await conn.execute(
      `UPDATE Prestamos SET updated_at = NOW(), is_synced = 1 WHERE id = ?`,
      [pago.prestamo_id]
    );

    await conn.execute(
      `UPDATE Pagos SET deleted_at = NOW(), updated_at = NOW(), is_synced = 1, editado_por_admin_at = NOW()
       WHERE id = ?`,
      [id]
    );

    await conn.execute(
      `UPDATE Solicitudes_Correccion_Cobro SET estado = 'RESUELTA', updated_at = NOW()
       WHERE pago_id = ? AND estado = 'PENDIENTE' AND deleted_at IS NULL`,
      [id]
    );

    await conn.commit();

    const [prest] = await conn.execute(
      `SELECT saldo_pendiente, estado FROM Prestamos WHERE id = ?`,
      [pago.prestamo_id]
    );

    return res.json({
      success: true,
      message: 'Abono anulado. El credito quedo como si no se hubiera cobrado.',
      data: {
        pago_id: id,
        prestamo_id: pago.prestamo_id,
        cobrador_id: pago.cobrador_id,
        monto_anulado: monto,
        saldo_pendiente: prest[0]?.saldo_pendiente ?? saldoNuevo,
        estado_prestamo: prest[0]?.estado,
      },
    });
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
        const { inicio, fin } = rangoPeriodoLocal(desde, hasta);
        const resumen = await query(
          `SELECT COUNT(DISTINCT id) AS pagos_recibidos,
                  COALESCE(SUM(monto_pagado),0) AS monto_recuperado
           FROM Pagos WHERE deleted_at IS NULL AND fecha_pago >= ? AND fecha_pago < ?`,
          [inicio, fin]
        );
        const detallePorCobrador = await query(
          `SELECT u.nombre_completo AS cobrador, COUNT(p.id) AS pagos, COALESCE(SUM(p.monto_pagado),0) AS monto
           FROM Pagos p JOIN Usuarios u ON p.cobrador_id = u.id
           WHERE p.deleted_at IS NULL AND p.fecha_pago >= ? AND p.fecha_pago < ?
           GROUP BY u.id, u.nombre_completo ORDER BY monto DESC`,
          [inicio, fin]
        );
        const filas = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula,
                  u.nombre_completo AS cobrador,
                  p.prestamo_id, p.fecha_pago, p.monto_pagado
           FROM Pagos p
           JOIN Prestamos pr ON pr.id = p.prestamo_id AND pr.deleted_at IS NULL
           JOIN Clientes c ON c.id = pr.cliente_id AND c.deleted_at IS NULL
           LEFT JOIN Usuarios u ON p.cobrador_id = u.id
           WHERE p.deleted_at IS NULL AND p.fecha_pago >= ? AND p.fecha_pago < ?
           ORDER BY p.fecha_pago DESC`,
          [inicio, fin]
        );
        return res.json({
          success: true,
          data: { tipo: 'RECUPERACIÓN', periodo: { desde, hasta }, resumen: resumen[0], detallePorCobrador, filas, timestamp: ts },
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
        const filas = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula,
                  p.id AS prestamo_id, p.saldo_pendiente, p.cuota_semanal_base, p.estado
           FROM Prestamos p
           JOIN Clientes c ON p.cliente_id = c.id AND c.deleted_at IS NULL
           WHERE p.deleted_at IS NULL AND p.estado = 'Activo'
           ORDER BY c.nombre_completo`
        );
        return res.json({
          success: true,
          data: { tipo: 'CARTERA ACTIVA', resumen: resumen[0], porEstado, filas, timestamp: ts },
        });
      }
      case 'riesgo': {
        const hoy = hoyISO();
        const saldos = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula,
                  p.id AS prestamo_id, p.saldo_pendiente,
                  p.cuota_semanal_base, p.estado,
                  COUNT(cc.id) AS cuotas_vencidas
           FROM Clientes c
           JOIN Prestamos p ON c.id = p.cliente_id
           LEFT JOIN Cuotas_Calendario cc ON p.id = cc.prestamo_id
             AND cc.estado = 'Programada' AND DATE(cc.fecha_programada) < DATE(?)
           WHERE p.estado = 'Activo' AND p.deleted_at IS NULL
           GROUP BY c.id, c.nombre_completo, c.cedula, p.id, p.saldo_pendiente, p.cuota_semanal_base, p.estado`,
          [hoy]
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
        const { inicio, fin } = rangoPeriodoLocal(desde, hasta);
        const filas = await query(
          `SELECT u.nombre_completo AS cobrador,
                  COUNT(DISTINCT p.id) AS pagos,
                  COALESCE(SUM(p.monto_pagado),0) AS monto_cobrado,
                  COUNT(DISTINCT g.id) AS gestiones_no_pago
           FROM Usuarios u
           JOIN Roles r ON u.rol_id = r.id
           LEFT JOIN Pagos p ON p.cobrador_id = u.id AND p.deleted_at IS NULL AND p.fecha_pago >= ? AND p.fecha_pago < ?
           LEFT JOIN Gestiones_No_Pago g ON g.cobrador_id = u.id AND g.fecha_gestion >= ? AND g.fecha_gestion < ?
           WHERE r.nombre = 'COBRADOR' AND u.deleted_at IS NULL
           GROUP BY u.id, u.nombre_completo ORDER BY monto_cobrado DESC`,
          [inicio, fin, inicio, fin]
        );
        return res.json({
          success: true,
          data: { tipo: 'DESEMPEÑO COBRADORES', periodo: { desde, hasta }, filas, timestamp: ts },
        });
      }
      case 'liquidaciones': {
        const { inicio, fin } = rangoPeriodoLocal(desde, hasta);
        const filas = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula,
                  p.id AS prestamo_id, p.fecha_desembolso, p.monto_desembolsado,
                  p.monto_total_pagar, p.updated_at AS fecha_liquidacion
           FROM Prestamos p JOIN Clientes c ON p.cliente_id = c.id
           WHERE p.estado = 'Pagado' AND p.deleted_at IS NULL
             AND p.updated_at >= ? AND p.updated_at < ?
           ORDER BY p.updated_at DESC`,
          [inicio, fin]
        );
        return res.json({
          success: true,
          data: { tipo: 'PRÉSTAMOS LIQUIDADOS', periodo: { desde, hasta }, filas, cantidad: filas.length, timestamp: ts },
        });
      }
      case 'gestiones': {
        const { inicio, fin } = rangoPeriodoLocal(desde, hasta);
        const resumen = await query(
          `SELECT COUNT(*) AS total, COUNT(DISTINCT prestamo_id) AS prestamos_afectados
           FROM Gestiones_No_Pago
           WHERE deleted_at IS NULL AND fecha_gestion >= ? AND fecha_gestion < ?`,
          [inicio, fin]
        );
        const porMotivo = await query(
          `SELECT motivo, COUNT(*) AS cantidad
           FROM Gestiones_No_Pago
           WHERE deleted_at IS NULL AND fecha_gestion >= ? AND fecha_gestion < ?
           GROUP BY motivo ORDER BY cantidad DESC`,
          [inicio, fin]
        );
        const filas = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula,
                  u.nombre_completo AS cobrador,
                  g.prestamo_id, g.motivo, g.fecha_gestion
           FROM Gestiones_No_Pago g
           JOIN Prestamos p ON p.id = g.prestamo_id AND p.deleted_at IS NULL
           JOIN Clientes c ON c.id = p.cliente_id AND c.deleted_at IS NULL
           LEFT JOIN Usuarios u ON g.cobrador_id = u.id
           WHERE g.deleted_at IS NULL AND g.fecha_gestion >= ? AND g.fecha_gestion < ?
           ORDER BY g.fecha_gestion DESC`,
          [inicio, fin]
        );
        return res.json({
          success: true,
          data: { tipo: 'GESTIONES NO PAGO', periodo: { desde, hasta }, resumen: resumen[0], porMotivo, filas, timestamp: ts },
        });
      }
      case 'clientes-nuevos': {
        const { inicio, fin } = rangoPeriodoLocal(desde, hasta);
        const filas = await query(
          `SELECT c.id AS codigo_cliente, c.nombre_completo, c.cedula, c.telefono,
                  c.direccion, COALESCE(u.nombre_completo, 'Sin asignar') AS cobrador,
                  COALESCE(c.created_at, c.updated_at) AS created_at
           FROM Clientes c
           LEFT JOIN Usuarios u ON c.cobrador_id = u.id
           WHERE c.deleted_at IS NULL
             AND COALESCE(c.created_at, c.updated_at) >= ? AND COALESCE(c.created_at, c.updated_at) < ?
           ORDER BY COALESCE(c.created_at, c.updated_at) DESC`,
          [inicio, fin]
        );
        return res.json({
          success: true,
          data: { tipo: 'CLIENTES NUEVOS', periodo: { desde, hasta }, filas, cantidad: filas.length, timestamp: ts },
        });
      }
      case 'vencidos': {
        const data = await armarReporteVencidos();
        return res.json({ success: true, data });
      }
      case 'perdidas': {
        const data = await armarReportePerdidas(desde, hasta);
        return res.json({ success: true, data });
      }
      case 'diario-cobros': {
        const { buildReporteDiarioContable } = require('../utils/reporteDiarioContable');
        if (desde === hasta) {
          const data = await buildReporteDiarioContable(desde);
          return res.json({ success: true, data });
        }
        const reportes = [];
        const d0 = new Date(`${desde}T12:00:00`);
        const d1 = new Date(`${hasta}T12:00:00`);
        for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
          const iso = d.toISOString().slice(0, 10);
          reportes.push(await buildReporteDiarioContable(iso));
        }
        return res.json({
          success: true,
          data: {
            tipo: 'DIARIO DE COBROS (RANGO)',
            periodo: { desde, hasta },
            reportes,
            timestamp: ts,
          },
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
        `SELECT id, monto_efectivo, transacciones FROM Cierre_Caja
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
                id: cierres[0].id,
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

/** Admin: reabrir cierre de caja de un cobrador en una fecha (soft delete). */
async function reabrirCierreCajaDia(req, res) {
  try {
    const { fechaCalendarioISO } = require('../utils/diasCobro');
    const { whereCierreCalendarioDia } = require('../utils/fechasSql');
    const cobradorId = req.body?.cobrador_id;
    const fecha = req.body?.fecha || fechaCalendarioISO();
    if (!cobradorId) {
      return res.status(400).json({ success: false, message: 'cobrador_id requerido' });
    }
    await query(
      `UPDATE Cierre_Caja SET deleted_at = NOW(), updated_at = NOW()
       WHERE cobrador_id = ? AND deleted_at IS NULL AND ${whereCierreCalendarioDia('fecha_cierre')}`,
      [cobradorId, fecha]
    );
    return res.json({
      success: true,
      message: 'Dia reabierto. El cobrador puede volver a cerrar caja cuando termine.',
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

async function validarCargaMasivaGarantias(req, res) {
  try {
    const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    if (!filas.length) {
      return res.status(400).json({ success: false, message: 'Envie un arreglo "filas" con al menos una fila.' });
    }
    if (filas.length > 500) {
      return res.status(400).json({ success: false, message: 'Maximo 500 filas por solicitud.' });
    }
    const data = await validarFilasGarantias(filas, query);
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function getAuditoriaIntegridad(req, res) {
  try {
    const data = await runAuditoriaIntegridad();
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function importarCargaMasivaGarantias(req, res) {
  try {
    const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    if (!filas.length) {
      return res.status(400).json({ success: false, message: 'Envie un arreglo "filas" con al menos una fila.' });
    }
    if (filas.length > 500) {
      return res.status(400).json({ success: false, message: 'Maximo 500 filas por solicitud.' });
    }
    const data = await importarFilasGarantias(filas, query, getConnection);
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function listGarantiasPrestamo(req, res) {
  try {
    const rows = await query(
      `SELECT g.* FROM Garantias g
       INNER JOIN Prestamo_Garantias pg ON g.id = pg.garantia_id
       WHERE pg.prestamo_id = ? AND g.deleted_at IS NULL`,
      [req.params.id]
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

async function agregarGarantiasPrestamo(req, res) {
  const conn = await getConnection();
  try {
    const prestamoId = req.params.id;
    const items = Array.isArray(req.body?.garantias_nuevas) ? req.body.garantias_nuevas : [];
    const reutilizar = Array.isArray(req.body?.garantias_reutilizar_ids)
      ? req.body.garantias_reutilizar_ids
      : [];

    if (!items.length && !reutilizar.length) {
      return res.status(400).json({ success: false, message: 'Indique garantías nuevas o a reutilizar.' });
    }

    const [pre] = await conn.execute(
      `SELECT id, cliente_id, estado FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [prestamoId]
    );
    if (!pre.length) {
      return res.status(404).json({ success: false, message: 'Préstamo no encontrado.' });
    }
    if (pre[0].estado !== 'Activo') {
      return res.status(400).json({ success: false, message: 'Solo se pueden agregar garantías a préstamos activos.' });
    }

    await conn.beginTransaction();
    const creadas = [];

    for (const gid of reutilizar) {
      const [g] = await conn.execute(
        `SELECT id FROM Garantias WHERE id = ? AND cliente_id = ? AND deleted_at IS NULL LIMIT 1`,
        [gid, pre[0].cliente_id]
      );
      if (!g.length) continue;
      await conn.execute(
        `INSERT INTO Prestamo_Garantias (prestamo_id, garantia_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE prestamo_id = prestamo_id`,
        [prestamoId, gid]
      );
      await conn.execute(`UPDATE Garantias SET estado = 'Comprometida', is_synced = 1 WHERE id = ?`, [gid]);
      creadas.push(gid);
    }

    for (const art of items) {
      const tipo = String(art.tipo_articulo || '').trim();
      const valor = Number(art.valor_estimado);
      if (!tipo || !Number.isFinite(valor) || valor < 0) {
        throw new Error('Cada garantía nueva requiere tipo_articulo y valor_estimado válido.');
      }
      const gid = `GAR-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
      await conn.execute(
        `INSERT INTO Garantias (id, cliente_id, tipo_articulo, marca, numero_serie, valor_estimado, estado, is_synced)
         VALUES (?, ?, ?, ?, ?, ?, 'Comprometida', 1)`,
        [
          gid,
          pre[0].cliente_id,
          tipo,
          art.marca || null,
          art.numero_serie || null,
          valor,
        ]
      );
      await conn.execute(
        `INSERT INTO Prestamo_Garantias (prestamo_id, garantia_id) VALUES (?, ?)`,
        [prestamoId, gid]
      );
      creadas.push(gid);
    }

    await conn.commit();
    return res.json({ success: true, garantias: creadas, total: creadas.length });
  } catch (e) {
    await conn.rollback();
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function aplicarProrroga(req, res) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const resultado = await aplicarProrrogaEnNube(conn, {
      prestamo_id: req.body.prestamo_id,
      semanas_extra: req.body.semanas_extra,
      comentario: req.body.comentario || 'Prórroga con interés congelado',
      operador_id: req.operadorId,
    });
    await conn.commit();
    return res.json({ success: true, data: resultado });
  } catch (e) {
    await conn.rollback();
    return res.status(400).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function castigarPerdida(req, res) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const resultado = await aplicarCastigoPerdidaEnNube(conn, {
      prestamo_id: req.params.id || req.body.prestamo_id,
      motivo: req.body.motivo,
      operador_id: req.operadorId,
    });
    await conn.commit();
    return res.json({ success: true, data: resultado });
  } catch (e) {
    await conn.rollback();
    return res.status(400).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function exportCarteraImportacion(req, res) {
  try {
    const cartera = await query(
      `SELECT c.cedula,
              c.primer_nombre, c.segundo_nombre, c.primer_apellido, c.segundo_apellido,
              c.nombre_completo, c.telefono, c.direccion, c.actividad_economica,
              u.email AS cobrador_email,
              p.monto_desembolsado, p.plazo_semanas,
              ROUND(p.tasa_interes_aplicada / GREATEST(p.plazo_semanas / 4, 1) * 100, 2) AS tasa_mensual,
              p.dias_de_cobro, DATE_FORMAT(p.fecha_desembolso, '%Y-%m-%d') AS fecha_desembolso,
              p.saldo_pendiente,
              FLOOR(
                (SELECT COUNT(*) FROM Cuotas_Calendario cc
                 WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL
                   AND (cc.estado = 'Pagada' OR cc.monto_pagado >= cc.monto_programado - 0.01))
                / GREATEST(p.frecuencia_semana, 1)
              ) AS semanas_pagadas,
              c.latitud, c.longitud,
              rc.orden_visita
       FROM Prestamos p
       JOIN Clientes c ON p.cliente_id = c.id AND c.deleted_at IS NULL
       LEFT JOIN Usuarios u ON c.cobrador_id = u.id
       LEFT JOIN Ruta_Clientes rc ON rc.cliente_id = c.id
       LEFT JOIN Rutas r ON r.id = rc.ruta_id AND r.cobrador_id = c.cobrador_id AND r.activa = 1
       WHERE p.estado = 'Activo' AND p.deleted_at IS NULL
       ORDER BY c.nombre_completo`
    );

    const garantias = await query(
      `SELECT c.cedula, g.tipo_articulo, g.marca, g.numero_serie, g.valor_estimado
       FROM Garantias g
       JOIN Clientes c ON g.cliente_id = c.id AND c.deleted_at IS NULL
       JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
       WHERE g.deleted_at IS NULL
       ORDER BY c.nombre_completo, g.tipo_articulo`
    );

    return res.json({
      success: true,
      data: { cartera, garantias },
      generado: new Date().toISOString(),
    });
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
  avisosCobrosCobrador,
  listPagosDetalle,
  getEstadoCuentaCliente,
  updatePago,
  deletePago,
  listSolicitudesCorreccion,
  syncRutasCobradores,
  optimizarRuta,
  seedDemoEsteli,
  getCumplimientoRuta,
  reabrirCierreCajaDia,
  validarCargaMasiva,
  importarCargaMasiva,
  validarCargaMasivaGarantias,
  importarCargaMasivaGarantias,
  getAuditoriaIntegridad,
  listGarantiasPrestamo,
  agregarGarantiasPrestamo,
  aplicarProrroga,
  castigarPerdida,
  exportCarteraImportacion,
  esIdClienteOficial,
  camposCliente,
  nextClienteId,
};
