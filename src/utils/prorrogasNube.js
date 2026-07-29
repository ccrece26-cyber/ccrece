const { v4: uuidv4 } = require('uuid');

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

/**
 * Prórroga con interés congelado (modelo flexible):
 * solo registra historial y alarga plazo_semanas.
 * No genera cuotas de calendario.
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
  const cuotaPorDia =
    cuotaSemanalActual > 0
      ? Number((cuotaSemanalActual / frecuencia).toFixed(2))
      : 0;

  const plazoActual = Number(prestamo.plazo_semanas) || 0;
  const semanasRestantes = Math.max(1, Math.ceil(saldo / (cuotaSemanalActual || saldo || 1)));
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

  return {
    prorrogaId,
    nuevaCuotaSemanal: cuotaSemanalActual,
    cuotaPorDiaDeCobro: cuotaPorDia,
    plazoRestante,
    semanasRestantes,
    semanasExtra: extra,
    saldoPendiente: saldo,
    cuotaSinCambio: true,
    visitasAgregadas: 0,
    plazo_semanas_nuevo: plazoActual + extra,
    operador_id: operadorId,
  };
}

async function contarSemanasRestantes(_conn, _prestamoId, cuotaSemanal) {
  if (cuotaSemanal > 0) return 1;
  return 1;
}

module.exports = { aplicarProrrogaEnNube, parseDiasCobro, contarSemanasRestantes };
