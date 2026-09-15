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

/**
 * Corrige plazo base vs semanas de prórroga mal marcadas.
 * Soft-borra historial con semanas_extra > 0, fija plazo_base y reaplica prórroga.
 * Por defecto recalcula cuota = monto_total_pagar / (base + prórroga).
 */
async function corregirPlazoProrrogaEnNube(conn, opts) {
  const {
    prestamo_id: prestamoId,
    plazo_base: plazoBaseRaw,
    semanas_prorroga: semanasProrrogaRaw = 0,
    recalcular_cuota: recalcularCuota = true,
    comentario = '',
    operador_id: operadorId = null,
  } = opts;

  const plazoBase = Math.floor(Number(plazoBaseRaw));
  const semanasProrroga = Math.floor(Number(semanasProrrogaRaw) || 0);
  if (!prestamoId || !Number.isFinite(plazoBase) || plazoBase < 1) {
    throw new Error('Indique un plazo base válido (semanas ≥ 1).');
  }
  if (!Number.isFinite(semanasProrroga) || semanasProrroga < 0) {
    throw new Error('Las semanas de prórroga no pueden ser negativas.');
  }
  if (plazoBase + semanasProrroga > 520) {
    throw new Error('El plazo total no puede superar 520 semanas.');
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

  const [histAntes] = await conn.execute(
    `SELECT COALESCE(SUM(semanas_extra), 0) AS sem
     FROM Historial_Prorrogas
     WHERE prestamo_id = ? AND deleted_at IS NULL AND semanas_extra > 0`,
    [prestamoId]
  );
  const semanasAntes = Number(histAntes[0]?.sem || 0);
  const plazoAntes = Number(prestamo.plazo_semanas) || 0;
  const baseAntes = Math.max(1, plazoAntes - semanasAntes);
  const cuotaAntes = Number(prestamo.cuota_semanal_base) || 0;
  const totalPagar = Number(prestamo.monto_total_pagar) || 0;

  await conn.execute(
    `UPDATE Historial_Prorrogas
     SET deleted_at = NOW(), is_synced = 1, updated_at = NOW()
     WHERE prestamo_id = ? AND deleted_at IS NULL AND semanas_extra > 0`,
    [prestamoId]
  );

  const plazoTotal = plazoBase + semanasProrroga;
  let nuevaCuota = cuotaAntes;
  if (recalcularCuota !== false && totalPagar > 0 && plazoTotal > 0) {
    nuevaCuota = Number((totalPagar / plazoTotal).toFixed(2));
  }

  await conn.execute(
    `UPDATE Prestamos SET
      plazo_semanas = ?,
      cuota_semanal_base = ?,
      updated_at = NOW(),
      is_synced = 1
     WHERE id = ?`,
    [plazoBase, nuevaCuota, prestamoId]
  );

  const nota =
    comentario ||
    `Corrección admin: base ${plazoBase} sem` +
      (semanasProrroga > 0 ? ` + ${semanasProrroga} prórroga` : ' (sin prórroga)');

  let prorroga = null;
  if (semanasProrroga > 0) {
    prorroga = await aplicarProrrogaEnNube(conn, {
      prestamo_id: prestamoId,
      semanas_extra: semanasProrroga,
      comentario: nota,
      operador_id: operadorId,
    });
  } else {
    const id = uuidv4();
    const fecha = new Date().toISOString();
    await conn.execute(
      `INSERT INTO Historial_Prorrogas (
        id, prestamo_id, semanas_extra, saldo_anterior, nueva_cuota_semanal,
        fecha_prorroga, comentario, is_synced
      ) VALUES (?, ?, 0, ?, ?, ?, ?, 1)`,
      [id, prestamoId, Number(prestamo.saldo_pendiente) || 0, nuevaCuota, fecha, nota]
    );
  }

  const [finalRows] = await conn.execute(
    `SELECT plazo_semanas, cuota_semanal_base, monto_total_pagar, saldo_pendiente
     FROM Prestamos WHERE id = ? LIMIT 1`,
    [prestamoId]
  );
  const finalP = finalRows[0] || {};

  return {
    prestamo_id: prestamoId,
    cobrador_id: prestamo.cobrador_id,
    cliente_id: prestamo.cliente_id,
    antes: {
      plazo_semanas: plazoAntes,
      plazo_base: baseAntes,
      semanas_prorroga: semanasAntes,
      cuota_semanal_base: cuotaAntes,
    },
    despues: {
      plazo_semanas: Number(finalP.plazo_semanas),
      plazo_base: plazoBase,
      semanas_prorroga: semanasProrroga,
      cuota_semanal_base: Number(finalP.cuota_semanal_base),
      monto_total_pagar: Number(finalP.monto_total_pagar),
      saldo_pendiente: Number(finalP.saldo_pendiente),
    },
    recalcular_cuota: recalcularCuota !== false,
    prorroga,
    mensaje: `Plazo corregido: ${plazoBase} base` +
      (semanasProrroga > 0 ? ` + ${semanasProrroga} prórroga` : '') +
      ` = ${plazoTotal} sem. Cuota ${nuevaCuota.toFixed(2)}.`,
  };
}

module.exports = {
  aplicarProrrogaEnNube,
  corregirPlazoProrrogaEnNube,
  parseDiasCobro,
  contarSemanasRestantes,
};
