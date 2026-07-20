const { query } = require('../config/db');
const { hoyISO } = require('./zonaHoraria');

function fechaISO(valor) {
  if (valor == null || valor === '') return null;
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    const y = valor.getUTCFullYear();
    const m = String(valor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(valor.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const m = String(valor).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function addDaysISO(fecha, days) {
  const d = new Date(`${fecha}T12:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function ensureFeriadosTable(conn = null) {
  const sql = `CREATE TABLE IF NOT EXISTS Feriados (
    id VARCHAR(36) NOT NULL,
    fecha DATE NOT NULL,
    nombre VARCHAR(120) DEFAULT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    is_synced TINYINT(1) DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_feriado_fecha (fecha)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
  if (conn) await conn.execute(sql);
  else await query(sql);
}

async function listarFeriadosActivos() {
  await ensureFeriadosTable();
  const rows = await query(
    `SELECT id, fecha, nombre, activo, updated_at
     FROM Feriados
     WHERE deleted_at IS NULL AND activo = 1
     ORDER BY fecha ASC`
  );
  return (rows || []).map((r) => ({
    ...r,
    fecha: fechaISO(r.fecha),
  }));
}

async function listarFeriadosTodos() {
  await ensureFeriadosTable();
  const rows = await query(
    `SELECT id, fecha, nombre, activo, updated_at, deleted_at
     FROM Feriados
     WHERE deleted_at IS NULL
     ORDER BY fecha ASC`
  );
  return (rows || []).map((r) => ({
    ...r,
    fecha: fechaISO(r.fecha),
  }));
}

/** Set de fechas YYYY-MM-DD activas. */
async function cargarSetFeriados(conn = null) {
  await ensureFeriadosTable(conn);
  const sql = `SELECT fecha FROM Feriados WHERE deleted_at IS NULL AND activo = 1`;
  const rows = conn
    ? (await conn.execute(sql))[0]
    : await query(sql);
  const set = new Set();
  for (const r of rows || []) {
    const f = fechaISO(r.fecha);
    if (f) set.add(f);
  }
  return set;
}

/** Siguiente día hábil (no feriado). */
function siguienteDiaHabil(fecha, setFeriados) {
  let f = addDaysISO(fechaISO(fecha), 1);
  let guard = 0;
  while (setFeriados.has(f) && guard < 60) {
    f = addDaysISO(f, 1);
    guard += 1;
  }
  return f;
}

/**
 * Mueve cuotas Programada/Parcial del día feriado al siguiente hábil.
 * Solo esa cuota (ese día); no cambia el resto del plan.
 */
async function moverCuotasDeFeriado(conn, fechaFeriado) {
  const feriado = fechaISO(fechaFeriado);
  if (!feriado) return { movidas: 0 };
  const set = await cargarSetFeriados(conn);
  set.add(feriado);
  const destino = siguienteDiaHabil(feriado, set);

  const [cuotas] = await conn.execute(
    `SELECT id, prestamo_id, fecha_programada, monto_programado
     FROM Cuotas_Calendario
     WHERE deleted_at IS NULL
       AND estado IN ('Programada', 'Parcial')
       AND fecha_programada = ?`,
    [feriado]
  );

  let movidas = 0;
  for (const c of cuotas || []) {
    // Evitar chocar con otra cuota el mismo día mismo préstamo
    const [dup] = await conn.execute(
      `SELECT id FROM Cuotas_Calendario
       WHERE prestamo_id = ? AND deleted_at IS NULL
         AND fecha_programada = ? AND id <> ?
       LIMIT 1`,
      [c.prestamo_id, destino, c.id]
    );
    let fechaDest = destino;
    if (dup.length) {
      fechaDest = siguienteDiaHabil(destino, set);
    }
    await conn.execute(
      `UPDATE Cuotas_Calendario
       SET fecha_programada = ?, updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [fechaDest, c.id]
    );
    movidas += 1;
  }
  return { movidas, destino };
}

async function ensureHistorialAnticiposTable(conn = null) {
  const sql = `CREATE TABLE IF NOT EXISTS Historial_Anticipos (
    id VARCHAR(36) NOT NULL,
    prestamo_id VARCHAR(36) NOT NULL,
    cuota_id VARCHAR(36) NOT NULL,
    fecha_original DATE NOT NULL,
    fecha_anticipo DATE NOT NULL,
    monto_programado DECIMAL(12,2) DEFAULT NULL,
    operador_id VARCHAR(36) DEFAULT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
    comentario VARCHAR(255) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_anticipo_prestamo (prestamo_id),
    KEY idx_anticipo_estado (estado),
    KEY idx_anticipo_cuota (cuota_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
  if (conn) await conn.execute(sql);
  else await query(sql);
}

/**
 * Anticipar: mueve la próxima cuota pendiente (o una con fecha >= hoy) a fechaObjetivo.
 */
async function anticiparCuotaPrestamo(conn, prestamoId, fechaObjetivo, opts = {}) {
  await ensureHistorialAnticiposTable(conn);
  const destino = fechaISO(fechaObjetivo) || hoyISO();
  const hoy = hoyISO();

  const [prest] = await conn.execute(
    `SELECT id, estado, saldo_pendiente FROM Prestamos
     WHERE id = ? AND deleted_at IS NULL AND estado = 'Activo' LIMIT 1`,
    [prestamoId]
  );
  if (!prest.length) throw new Error('Préstamo activo no encontrado');

  let cuota = null;
  if (opts.cuota_id) {
    const [rows] = await conn.execute(
      `SELECT * FROM Cuotas_Calendario
       WHERE id = ? AND prestamo_id = ? AND deleted_at IS NULL
         AND estado IN ('Programada', 'Parcial') LIMIT 1`,
      [opts.cuota_id, prestamoId]
    );
    cuota = rows[0] || null;
  }
  if (!cuota) {
    const [futuras] = await conn.execute(
      `SELECT * FROM Cuotas_Calendario
       WHERE prestamo_id = ? AND deleted_at IS NULL
         AND estado IN ('Programada', 'Parcial')
         AND fecha_programada >= ?
       ORDER BY fecha_programada ASC LIMIT 1`,
      [prestamoId, hoy]
    );
    if (futuras.length) cuota = futuras[0];
    else {
      const [atras] = await conn.execute(
        `SELECT * FROM Cuotas_Calendario
         WHERE prestamo_id = ? AND deleted_at IS NULL
           AND estado IN ('Programada', 'Parcial')
         ORDER BY fecha_programada ASC LIMIT 1`,
        [prestamoId]
      );
      cuota = atras[0] || null;
    }
  }
  if (!cuota) throw new Error('No hay cuota pendiente para anticipar');

  const fechaAntes = fechaISO(cuota.fecha_programada);
  if (fechaAntes === destino) {
    throw new Error('La fecha de anticipo es igual a la fecha actual de la cuota');
  }

  await conn.execute(
    `UPDATE Cuotas_Calendario
     SET fecha_programada = ?, updated_at = NOW(), is_synced = 1
     WHERE id = ?`,
    [destino, cuota.id]
  );

  // Cerrar anticipos activos previos de la misma cuota
  await conn.execute(
    `UPDATE Historial_Anticipos
     SET estado = 'Reemplazado', updated_at = NOW()
     WHERE cuota_id = ? AND estado = 'Activo' AND deleted_at IS NULL`,
    [cuota.id]
  );

  const { v4: uuidv4 } = require('uuid');
  const histId = uuidv4();
  await conn.execute(
    `INSERT INTO Historial_Anticipos
       (id, prestamo_id, cuota_id, fecha_original, fecha_anticipo, monto_programado, operador_id, estado, comentario)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Activo', ?)`,
    [
      histId,
      prestamoId,
      cuota.id,
      fechaAntes,
      destino,
      Number(cuota.monto_programado),
      opts.operador_id || null,
      opts.comentario || 'Anticipo de cuota',
    ]
  );

  return {
    id: histId,
    cuota_id: cuota.id,
    prestamo_id: prestamoId,
    fecha_antes: fechaAntes,
    fecha_cobro: destino,
    monto_programado: Number(cuota.monto_programado),
    mensaje: `Cuota movida de ${fechaAntes} a ${destino} (anticipo). Aparecerá en la ruta ese día.`,
  };
}

async function listarHistorialAnticipos(opts = {}) {
  await ensureHistorialAnticiposTable();
  const soloActivos = opts.solo_activos !== false;
  const limit = Math.min(200, Number(opts.limit) || 80);
  const sql = `
    SELECT h.id, h.prestamo_id, h.cuota_id, h.fecha_original, h.fecha_anticipo,
           h.monto_programado, h.operador_id, h.estado, h.comentario, h.created_at, h.updated_at,
           c.nombre_completo, c.cedula, c.id AS cliente_id,
           cc.estado AS estado_cuota, cc.fecha_programada AS fecha_cuota_actual,
           cc.monto_pagado AS cuota_monto_pagado,
           u.nombre_completo AS operador_nombre
    FROM Historial_Anticipos h
    INNER JOIN Prestamos p ON p.id = h.prestamo_id
    INNER JOIN Clientes c ON c.id = p.cliente_id
    LEFT JOIN Cuotas_Calendario cc ON cc.id = h.cuota_id
    LEFT JOIN Usuarios u ON u.id = h.operador_id
    WHERE h.deleted_at IS NULL
      ${soloActivos ? `AND h.estado = 'Activo'` : ''}
    ORDER BY h.created_at DESC
    LIMIT ${limit}`;
  const rows = await query(sql);
  return (rows || []).map((r) => ({
    ...r,
    fecha_original: fechaISO(r.fecha_original),
    fecha_anticipo: fechaISO(r.fecha_anticipo),
    fecha_cuota_actual: fechaISO(r.fecha_cuota_actual),
    monto_programado: r.monto_programado != null ? Number(r.monto_programado) : null,
    cuota_monto_pagado: r.cuota_monto_pagado != null ? Number(r.cuota_monto_pagado) : 0,
    puede_revertir:
      r.estado === 'Activo' &&
      r.estado_cuota &&
      ['Programada', 'Parcial'].includes(r.estado_cuota),
    puede_corregir:
      r.estado === 'Activo' &&
      r.estado_cuota &&
      ['Programada', 'Parcial'].includes(r.estado_cuota),
  }));
}

/** Restaura la fecha original de la cuota. */
async function revertirAnticipo(conn, anticipoId, opts = {}) {
  await ensureHistorialAnticiposTable(conn);
  const [rows] = await conn.execute(
    `SELECT * FROM Historial_Anticipos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [anticipoId]
  );
  const h = rows[0];
  if (!h) throw new Error('Anticipo no encontrado');
  if (h.estado !== 'Activo') throw new Error(`Este anticipo ya está ${h.estado}`);

  const [cuotas] = await conn.execute(
    `SELECT * FROM Cuotas_Calendario WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [h.cuota_id]
  );
  const cuota = cuotas[0];
  if (!cuota) throw new Error('La cuota ya no existe');
  if (!['Programada', 'Parcial'].includes(cuota.estado)) {
    throw new Error('La cuota ya fue cobrada; no se puede revertir el anticipo');
  }

  const original = fechaISO(h.fecha_original);
  await conn.execute(
    `UPDATE Cuotas_Calendario
     SET fecha_programada = ?, updated_at = NOW(), is_synced = 1
     WHERE id = ?`,
    [original, h.cuota_id]
  );
  await conn.execute(
    `UPDATE Historial_Anticipos
     SET estado = 'Revertido', comentario = CONCAT(COALESCE(comentario,''), ?), updated_at = NOW()
     WHERE id = ?`,
    [` | Revertido → ${original}`, anticipoId]
  );

  return {
    id: anticipoId,
    cuota_id: h.cuota_id,
    fecha_restaurada: original,
    mensaje: `Anticipo revertido. La cuota volvió a ${original}.`,
  };
}

/** Corrige la fecha de anticipo (sin perder el historial original). */
async function corregirAnticipo(conn, anticipoId, nuevaFecha, opts = {}) {
  await ensureHistorialAnticiposTable(conn);
  const destino = fechaISO(nuevaFecha);
  if (!destino) throw new Error('Nueva fecha inválida');

  const [rows] = await conn.execute(
    `SELECT * FROM Historial_Anticipos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [anticipoId]
  );
  const h = rows[0];
  if (!h) throw new Error('Anticipo no encontrado');
  if (h.estado !== 'Activo') throw new Error(`Este anticipo ya está ${h.estado}`);

  const [cuotas] = await conn.execute(
    `SELECT * FROM Cuotas_Calendario WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [h.cuota_id]
  );
  const cuota = cuotas[0];
  if (!cuota) throw new Error('La cuota ya no existe');
  if (!['Programada', 'Parcial'].includes(cuota.estado)) {
    throw new Error('La cuota ya fue cobrada; no se puede corregir el anticipo');
  }

  const antes = fechaISO(h.fecha_anticipo);
  if (antes === destino) throw new Error('Es la misma fecha de anticipo');

  await conn.execute(
    `UPDATE Cuotas_Calendario
     SET fecha_programada = ?, updated_at = NOW(), is_synced = 1
     WHERE id = ?`,
    [destino, h.cuota_id]
  );
  await conn.execute(
    `UPDATE Historial_Anticipos
     SET fecha_anticipo = ?, updated_at = NOW(),
         comentario = CONCAT(COALESCE(comentario,''), ?)
     WHERE id = ?`,
    [destino, ` | Corregido ${antes} → ${destino}`, anticipoId]
  );

  return {
    id: anticipoId,
    cuota_id: h.cuota_id,
    fecha_original: fechaISO(h.fecha_original),
    fecha_antes: antes,
    fecha_cobro: destino,
    mensaje: `Anticipo corregido a ${destino}. Fecha original de cuota: ${fechaISO(h.fecha_original)}.`,
  };
}

const MAPA_WD = ['DOMINGO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];

function normalizarDiaNombre(d) {
  return String(d || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function cuotaFueraDeAgenda(fecha, diasRaw, periodicidad) {
  const f = fechaISO(fecha);
  if (!f) return false;
  try {
    const dias = typeof diasRaw === 'string' ? JSON.parse(diasRaw) : diasRaw;
    if (!Array.isArray(dias) || !dias.length) return false;
    const nums = dias.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
    const esMes =
      String(periodicidad || '').toUpperCase() === 'DIAS_MES' ||
      (nums.length === dias.length && nums.length > 0);
    if (esMes) {
      const dayNum = Number(f.slice(8, 10));
      return !nums.includes(dayNum);
    }
    const wd = MAPA_WD[new Date(`${f}T12:00:00`).getDay()];
    return !dias.some((d) => normalizarDiaNombre(d) === normalizarDiaNombre(wd));
  } catch {
    return false;
  }
}

/** Cuotas pendientes sin registro en historial (p.ej. anticipos antes del módulo). */
async function listarCuotasPendientesSinHistorial(opts = {}) {
  await ensureHistorialAnticiposTable();
  const limit = Math.min(100, Number(opts.limit) || 60);
  const rows = await query(
    `SELECT cc.id AS cuota_id, cc.prestamo_id, cc.fecha_programada, cc.monto_programado,
            cc.monto_pagado, cc.estado AS estado_cuota,
            p.dias_de_cobro, p.periodicidad, p.saldo_pendiente, p.cuota_semanal_base,
            c.nombre_completo, c.cedula, c.id AS cliente_id
     FROM Cuotas_Calendario cc
     INNER JOIN Prestamos p ON p.id = cc.prestamo_id AND p.deleted_at IS NULL AND p.estado = 'Activo'
     INNER JOIN Clientes c ON c.id = p.cliente_id AND c.deleted_at IS NULL
     LEFT JOIN Historial_Anticipos h
       ON h.cuota_id = cc.id AND h.estado = 'Activo' AND h.deleted_at IS NULL
     WHERE cc.deleted_at IS NULL
       AND cc.estado IN ('Programada', 'Parcial')
       AND h.id IS NULL
       AND cc.fecha_programada >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       AND cc.fecha_programada <= DATE_ADD(CURDATE(), INTERVAL 45 DAY)
     ORDER BY cc.fecha_programada ASC
     LIMIT ${limit * 3}`
  );

  const fuera = [];
  for (const r of rows || []) {
    const fecha = fechaISO(r.fecha_programada);
    if (!cuotaFueraDeAgenda(fecha, r.dias_de_cobro, r.periodicidad)) continue;
    fuera.push({
      cuota_id: r.cuota_id,
      prestamo_id: r.prestamo_id,
      cliente_id: r.cliente_id,
      nombre_completo: r.nombre_completo,
      cedula: r.cedula,
      fecha_programada: fecha,
      monto_pendiente: Math.max(
        0,
        Number((Number(r.monto_programado) - Number(r.monto_pagado || 0)).toFixed(2))
      ),
      estado_cuota: r.estado_cuota,
      dias_de_cobro: r.dias_de_cobro,
      periodicidad: r.periodicidad || 'SEMANAL',
      sin_historial: true,
    });
    if (fuera.length >= limit) break;
  }
  return fuera;
}

async function listarCuotasPendientesPrestamo(prestamoId) {
  const rows = await query(
    `SELECT cc.id AS cuota_id, cc.prestamo_id, cc.fecha_programada, cc.monto_programado,
            cc.monto_pagado, cc.estado AS estado_cuota,
            p.dias_de_cobro, p.periodicidad,
            c.nombre_completo, c.cedula, c.id AS cliente_id,
            (SELECT h.id FROM Historial_Anticipos h
             WHERE h.cuota_id = cc.id AND h.estado = 'Activo' AND h.deleted_at IS NULL
             LIMIT 1) AS anticipo_id
     FROM Cuotas_Calendario cc
     INNER JOIN Prestamos p ON p.id = cc.prestamo_id
     INNER JOIN Clientes c ON c.id = p.cliente_id
     WHERE cc.prestamo_id = ? AND cc.deleted_at IS NULL
       AND cc.estado IN ('Programada', 'Parcial')
     ORDER BY cc.fecha_programada ASC
     LIMIT 24`,
    [prestamoId]
  );
  return (rows || []).map((r) => {
    const fecha = fechaISO(r.fecha_programada);
    return {
      cuota_id: r.cuota_id,
      prestamo_id: r.prestamo_id,
      cliente_id: r.cliente_id,
      nombre_completo: r.nombre_completo,
      cedula: r.cedula,
      fecha_programada: fecha,
      monto_pendiente: Math.max(
        0,
        Number((Number(r.monto_programado) - Number(r.monto_pagado || 0)).toFixed(2))
      ),
      estado_cuota: r.estado_cuota,
      anticipo_id: r.anticipo_id || null,
      fuera_de_agenda: cuotaFueraDeAgenda(fecha, r.dias_de_cobro, r.periodicidad),
    };
  });
}

/**
 * Ajusta fecha de una cuota (útil para anticipos previos al historial).
 * Registra en Historial_Anticipos para poder revertir después.
 */
async function ajustarFechaCuota(conn, cuotaId, nuevaFecha, opts = {}) {
  await ensureHistorialAnticiposTable(conn);
  const destino = fechaISO(nuevaFecha);
  if (!destino) throw new Error('Fecha inválida');

  const [rows] = await conn.execute(
    `SELECT cc.*, p.estado AS estado_prestamo
     FROM Cuotas_Calendario cc
     INNER JOIN Prestamos p ON p.id = cc.prestamo_id
     WHERE cc.id = ? AND cc.deleted_at IS NULL LIMIT 1`,
    [cuotaId]
  );
  const cuota = rows[0];
  if (!cuota) throw new Error('Cuota no encontrada');
  if (cuota.estado_prestamo !== 'Activo') throw new Error('El préstamo no está activo');
  if (!['Programada', 'Parcial'].includes(cuota.estado)) {
    throw new Error('La cuota ya fue cobrada; no se puede cambiar la fecha');
  }

  const fechaAntes = fechaISO(cuota.fecha_programada);
  if (fechaAntes === destino) throw new Error('Es la misma fecha');

  await conn.execute(
    `UPDATE Cuotas_Calendario
     SET fecha_programada = ?, updated_at = NOW(), is_synced = 1
     WHERE id = ?`,
    [destino, cuotaId]
  );

  await conn.execute(
    `UPDATE Historial_Anticipos
     SET estado = 'Reemplazado', updated_at = NOW()
     WHERE cuota_id = ? AND estado = 'Activo' AND deleted_at IS NULL`,
    [cuotaId]
  );

  const { v4: uuidv4 } = require('uuid');
  const histId = uuidv4();
  // fecha_original = a dónde podría volver (la que tenía); fecha_anticipo = nueva
  await conn.execute(
    `INSERT INTO Historial_Anticipos
       (id, prestamo_id, cuota_id, fecha_original, fecha_anticipo, monto_programado, operador_id, estado, comentario)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Activo', ?)`,
    [
      histId,
      cuota.prestamo_id,
      cuotaId,
      fechaAntes,
      destino,
      Number(cuota.monto_programado),
      opts.operador_id || null,
      opts.comentario || 'Ajuste manual de fecha de cuota',
    ]
  );

  return {
    id: histId,
    cuota_id: cuotaId,
    prestamo_id: cuota.prestamo_id,
    fecha_antes: fechaAntes,
    fecha_cobro: destino,
    mensaje: `Cuota movida de ${fechaAntes} a ${destino}. Ya aparece en el historial para revertir si hace falta.`,
  };
}

module.exports = {
  ensureFeriadosTable,
  ensureHistorialAnticiposTable,
  listarFeriadosActivos,
  listarFeriadosTodos,
  cargarSetFeriados,
  siguienteDiaHabil,
  moverCuotasDeFeriado,
  anticiparCuotaPrestamo,
  listarHistorialAnticipos,
  revertirAnticipo,
  corregirAnticipo,
  listarCuotasPendientesSinHistorial,
  listarCuotasPendientesPrestamo,
  ajustarFechaCuota,
  fechaISO,
  addDaysISO,
};
