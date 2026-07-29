const { v4: uuidv4 } = require('uuid');
const { aplicarProrrogaEnNube } = require('./prorrogasNube');

/**
 * Negociación admin: perdonar parte del saldo y/o dar prórroga (más tiempo).
 * Modelo flexible: actualiza solo Prestamos (+ Historial_Prorrogas); no toca Cuotas_Calendario.
 * No crea préstamo nuevo (a diferencia de renovación).
 */
async function aplicarNegociacionVencido(conn, opts) {
  const {
    prestamo_id: prestamoId,
    monto_perdonado: montoPerdonadoIn,
    nuevo_saldo: nuevoSaldoIn,
    semanas_extra: semanasExtraIn,
    comentario = '',
    operador_id: operadorId = null,
  } = opts;

  if (!prestamoId) throw new Error('prestamo_id requerido');

  const [rows] = await conn.execute(
    `SELECT * FROM Prestamos WHERE id = ? AND deleted_at IS NULL AND estado = 'Activo' LIMIT 1`,
    [prestamoId]
  );
  if (!rows.length) throw new Error('Préstamo activo no encontrado.');
  const prestamo = rows[0];

  const saldoAnterior = Number(prestamo.saldo_pendiente);
  if (saldoAnterior <= 0.01) throw new Error('El préstamo no tiene saldo pendiente.');

  const semanasExtra = Math.max(0, Math.floor(Number(semanasExtraIn) || 0));
  let montoPerdonado = 0;
  let nuevoSaldo = saldoAnterior;

  if (nuevoSaldoIn != null && nuevoSaldoIn !== '') {
    const ns = Number(nuevoSaldoIn);
    if (!Number.isFinite(ns) || ns < 0) throw new Error('Nuevo saldo inválido.');
    if (ns >= saldoAnterior - 0.001) {
      throw new Error('El nuevo saldo debe ser menor al saldo actual para perdonar.');
    }
    nuevoSaldo = Number(ns.toFixed(2));
    montoPerdonado = Number((saldoAnterior - nuevoSaldo).toFixed(2));
  } else if (montoPerdonadoIn != null && Number(montoPerdonadoIn) > 0) {
    montoPerdonado = Number(Number(montoPerdonadoIn).toFixed(2));
    if (montoPerdonado >= saldoAnterior) {
      throw new Error('El perdón no puede ser mayor o igual al saldo (use castigo a pérdida si cancela).');
    }
    nuevoSaldo = Number((saldoAnterior - montoPerdonado).toFixed(2));
  }

  if (montoPerdonado <= 0 && semanasExtra < 1) {
    throw new Error('Indique un monto a perdonar/nuevo saldo y/o semanas de prórroga.');
  }

  let cuotaTrasPerdon = null;

  if (montoPerdonado > 0) {
    const nuevoTotal = Number((Number(prestamo.monto_total_pagar) - montoPerdonado).toFixed(2));

    let diasN = 1;
    try {
      const raw = typeof prestamo.dias_de_cobro === 'string'
        ? JSON.parse(prestamo.dias_de_cobro)
        : prestamo.dias_de_cobro;
      if (Array.isArray(raw) && raw.length) diasN = raw.length;
    } catch {
      diasN = Number(prestamo.frecuencia_semana) || 1;
    }

    const ratio = saldoAnterior > 0.01 ? nuevoSaldo / saldoAnterior : 1;
    const cuotaSemanalAnterior = Number(prestamo.cuota_semanal_base) || 0;
    const nuevaCuotaSemanal = Number((cuotaSemanalAnterior * ratio).toFixed(2));
    cuotaTrasPerdon = Number((nuevaCuotaSemanal / Math.max(1, diasN)).toFixed(2));

    await conn.execute(
      `UPDATE Prestamos SET
        saldo_pendiente = ?,
        monto_total_pagar = ?,
        cuota_semanal_base = ?,
        updated_at = NOW(),
        is_synced = 1
       WHERE id = ?`,
      [
        nuevoSaldo,
        Math.max(nuevoTotal, Number(prestamo.monto_desembolsado) || 0),
        nuevaCuotaSemanal,
        prestamoId,
      ]
    );

    const notaPerdon = `Negociación: perdón C$ ${montoPerdonado.toFixed(2)} (saldo ${saldoAnterior.toFixed(2)} → ${nuevoSaldo.toFixed(2)})${
      comentario ? ` — ${comentario}` : ''
    }`;
    await conn.execute(
      `INSERT INTO Historial_Prorrogas (
        id, prestamo_id, semanas_extra, saldo_anterior, nueva_cuota_semanal,
        fecha_prorroga, comentario, is_synced
      ) VALUES (?, ?, 0, ?, ?, NOW(), ?, 1)`,
      [uuidv4(), prestamoId, saldoAnterior, nuevaCuotaSemanal, notaPerdon]
    );
  }

  let prorroga = null;
  if (semanasExtra >= 1) {
    prorroga = await aplicarProrrogaEnNube(conn, {
      prestamo_id: prestamoId,
      semanas_extra: semanasExtra,
      comentario:
        comentario ||
        (montoPerdonado > 0
          ? `Negociación: prórroga ${semanasExtra} sem. tras perdón`
          : `Prórroga negociación — ${semanasExtra} sem.`),
      operador_id: operadorId,
    });
  }

  const [act] = await conn.execute(
    `SELECT saldo_pendiente, monto_total_pagar, plazo_semanas, cuota_semanal_base
     FROM Prestamos WHERE id = ? LIMIT 1`,
    [prestamoId]
  );
  const p = act[0] || {};

  return {
    prestamo_id: prestamoId,
    saldo_anterior: saldoAnterior,
    monto_perdonado: montoPerdonado,
    nuevo_saldo: Number(p.saldo_pendiente),
    monto_total_pagar: Number(p.monto_total_pagar),
    semanas_extra: semanasExtra,
    cuotas_ajustadas: 0,
    cuota_por_visita: prorroga?.cuotaPorDiaDeCobro ?? cuotaTrasPerdon,
    cuota_semanal: prorroga?.nuevaCuotaSemanal ?? Number(p.cuota_semanal_base),
    plazo_semanas: Number(p.plazo_semanas),
    prorroga,
    mensaje:
      montoPerdonado > 0 && semanasExtra >= 1
        ? `Perdón C$ ${montoPerdonado.toFixed(2)} + ${semanasExtra} sem. de prórroga.`
        : montoPerdonado > 0
          ? `Perdón C$ ${montoPerdonado.toFixed(2)} aplicado.`
          : `Prórroga de ${semanasExtra} sem. aplicada.`,
  };
}

module.exports = { aplicarNegociacionVencido };
