const { v4: uuidv4 } = require('uuid');
const { generarAgendaDeCobro } = require('./finanzasNube');

function parseDiasCobro(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.filter(Boolean) : ['LUNES'];
    } catch {
      return ['LUNES'];
    }
  }
  return ['LUNES'];
}

async function contarSemanasRestantes(conn, prestamoId, cuotaSemanal) {
  const [pend] = await conn.execute(
    `SELECT COUNT(*) AS n, COALESCE(SUM(monto_programado - monto_pagado), 0) AS saldo_prog
     FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL
       AND estado IN ('Programada', 'Parcial')`,
    [prestamoId]
  );
  const n = Number(pend[0]?.n || 0);
  if (n > 0) return Math.max(1, n);
  if (cuotaSemanal > 0) return 1;
  return 1;
}

/**
 * Prórroga con interés congelado: extiende calendario sin cambiar cuotas ni sumar interés.
 */
async function aplicarProrrogaEnNube(conn, opts) {
  const {
    prestamo_id: prestamoId,
    semanas_extra: semanasExtra,
    comentario = '',
    operador_id: operadorId = null,
  } = opts;

  const extra = Math.floor(Number(semanasExtra));
  if (!prestamoId || !extra || extra < 1) {
    throw new Error('Datos de prórroga inválidos.');
  }

  const [rows] = await conn.execute(
    `SELECT p.*, c.cobrador_id
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE p.id = ? AND p.deleted_at IS NULL AND p.estado = 'Activo'
     LIMIT 1`,
    [prestamoId]
  );
  if (!rows.length) throw new Error('Préstamo activo no encontrado.');
  const prestamo = rows[0];

  const saldo = Number(prestamo.saldo_pendiente);
  if (saldo <= 0.01) throw new Error('El préstamo no tiene saldo pendiente.');

  const dias = parseDiasCobro(prestamo.dias_de_cobro);
  const frecuencia = dias.length || 1;
  const cuotaSemanalActual = Number(prestamo.cuota_semanal_base) || 0;

  const [cuotaRow] = await conn.execute(
    `SELECT monto_programado FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL AND estado IN ('Programada', 'Parcial')
     ORDER BY fecha_programada ASC LIMIT 1`,
    [prestamoId]
  );
  let cuotaPorDia = Number(cuotaRow[0]?.monto_programado) || 0;
  if (cuotaPorDia <= 0 && cuotaSemanalActual > 0) {
    cuotaPorDia = Number((cuotaSemanalActual / frecuencia).toFixed(2));
  }
  if (cuotaPorDia <= 0) {
    throw new Error('No se pudo determinar el monto de la cuota actual.');
  }

  const semanasRestantes = await contarSemanasRestantes(conn, prestamoId, cuotaSemanalActual);
  const plazoRestante = semanasRestantes + extra;

  const prorrogaId = uuidv4();
  const fecha = new Date().toISOString();

  await conn.execute(
    `INSERT INTO Historial_Prorrogas (
      id, prestamo_id, semanas_extra, saldo_anterior, nueva_cuota_semanal,
      fecha_prorroga, comentario, is_synced
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [prorrogaId, prestamoId, extra, saldo, cuotaSemanalActual, fecha, comentario || null]
  );

  await conn.execute(
    `UPDATE Prestamos SET
      plazo_semanas = plazo_semanas + ?,
      updated_at = NOW(),
      is_synced = 1
     WHERE id = ?`,
    [extra, prestamoId]
  );

  const [ultima] = await conn.execute(
    `SELECT fecha_programada FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL
     ORDER BY fecha_programada DESC LIMIT 1`,
    [prestamoId]
  );
  const ultimaFecha = ultima[0]?.fecha_programada;
  const inicioExtra = ultimaFecha
    ? String(ultimaFecha).slice(0, 10)
    : String(prestamo.fecha_desembolso).slice(0, 10);

  const agendaExtra = generarAgendaDeCobro(inicioExtra, extra, dias, cuotaPorDia);
  const [existentes] = await conn.execute(
    `SELECT fecha_programada FROM Cuotas_Calendario WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const fechasSet = new Set(existentes.map((r) => String(r.fecha_programada).slice(0, 10)));

  for (const c of agendaExtra) {
    const f = String(c.fecha_programada).slice(0, 10);
    if (fechasSet.has(f)) continue;
    fechasSet.add(f);
    await conn.execute(
      `INSERT INTO Cuotas_Calendario (id, prestamo_id, fecha_programada, monto_programado, monto_pagado, estado, is_synced)
       VALUES (?, ?, ?, ?, 0, 'Programada', 1)`,
      [uuidv4(), prestamoId, f, c.monto_programado]
    );
  }

  return {
    prorrogaId,
    nuevaCuotaSemanal: cuotaSemanalActual,
    cuotaPorDiaDeCobro: cuotaPorDia,
    plazoRestante,
    semanasRestantes,
    semanasExtra: extra,
    saldoPendiente: saldo,
    cuotaSinCambio: true,
    visitasAgregadas: agendaExtra.length,
    operador_id: operadorId,
  };
}

module.exports = { aplicarProrrogaEnNube, parseDiasCobro, contarSemanasRestantes };
