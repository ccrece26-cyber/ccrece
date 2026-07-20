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

/**
 * Anticipar: mueve la próxima cuota pendiente (o una con fecha >= hoy) a fechaObjetivo.
 */
async function anticiparCuotaPrestamo(conn, prestamoId, fechaObjetivo, opts = {}) {
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
    // Preferir cuota futura más cercana (>= hoy); si no, la más antigua pendiente
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
  await conn.execute(
    `UPDATE Cuotas_Calendario
     SET fecha_programada = ?, updated_at = NOW(), is_synced = 1
     WHERE id = ?`,
    [destino, cuota.id]
  );

  return {
    cuota_id: cuota.id,
    prestamo_id: prestamoId,
    fecha_antes: fechaAntes,
    fecha_cobro: destino,
    monto_programado: Number(cuota.monto_programado),
    mensaje: `Cuota movida de ${fechaAntes} a ${destino} (anticipo). Aparecerá en la ruta ese día.`,
  };
}

module.exports = {
  ensureFeriadosTable,
  listarFeriadosActivos,
  listarFeriadosTodos,
  cargarSetFeriados,
  siguienteDiaHabil,
  moverCuotasDeFeriado,
  anticiparCuotaPrestamo,
  fechaISO,
  addDaysISO,
};
