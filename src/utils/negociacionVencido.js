const { v4: uuidv4 } = require('uuid');
const { aplicarProrrogaEnNube } = require('./prorrogasNube');

/**
 * Negociación admin: mora (suma), perdón (baja), y/o prórroga (más tiempo).
 * Modelo flexible: actualiza Prestamos (+ Historial_Prorrogas); no toca Cuotas_Calendario.
 */
async function aplicarNegociacionVencido(conn, opts) {
  const {
    prestamo_id: prestamoId,
    monto_perdonado: montoPerdonadoIn,
    monto_mora: montoMoraIn,
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
  const montoMora = Number(Number(montoMoraIn || 0).toFixed(2));
  if (!Number.isFinite(montoMora) || montoMora < 0) {
    throw new Error('Monto de mora inválido.');
  }
  if (montoMora > 0 && montoMora < 0.01) {
    throw new Error('La mora debe ser al menos C$ 0.01.');
  }

  // Orden: saldo actual → + mora → - perdón (nuevo saldo se interpreta tras la mora)
  const saldoTrasMora = Number((saldoAnterior + montoMora).toFixed(2));
  let montoPerdonado = 0;
  let nuevoSaldo = saldoTrasMora;

  if (nuevoSaldoIn != null && nuevoSaldoIn !== '') {
    const ns = Number(nuevoSaldoIn);
    if (!Number.isFinite(ns) || ns < 0) throw new Error('Nuevo saldo inválido.');
    if (ns >= saldoTrasMora - 0.001) {
      throw new Error(
        montoMora > 0
          ? 'El nuevo saldo (después de mora) debe ser menor para aplicar un perdón.'
          : 'El nuevo saldo debe ser menor al saldo actual para perdonar.'
      );
    }
    nuevoSaldo = Number(ns.toFixed(2));
    montoPerdonado = Number((saldoTrasMora - nuevoSaldo).toFixed(2));
  } else if (montoPerdonadoIn != null && Number(montoPerdonadoIn) > 0) {
    montoPerdonado = Number(Number(montoPerdonadoIn).toFixed(2));
    if (montoPerdonado >= saldoTrasMora) {
      throw new Error('El perdón no puede ser mayor o igual al saldo (use castigo a pérdida si cancela).');
    }
    nuevoSaldo = Number((saldoTrasMora - montoPerdonado).toFixed(2));
  }

  if (montoMora <= 0 && montoPerdonado <= 0 && semanasExtra < 1) {
    throw new Error('Indique mora, un monto a perdonar/nuevo saldo y/o semanas de prórroga.');
  }

  let diasN = 1;
  try {
    const raw =
      typeof prestamo.dias_de_cobro === 'string'
        ? JSON.parse(prestamo.dias_de_cobro)
        : prestamo.dias_de_cobro;
    if (Array.isArray(raw) && raw.length) diasN = raw.length;
  } catch {
    diasN = Number(prestamo.frecuencia_semana) || 1;
  }

  let cuotaTrasAjuste = null;
  const totalAnterior = Number(prestamo.monto_total_pagar) || 0;
  let totalNuevo = totalAnterior;
  let cuotaSemanal = Number(prestamo.cuota_semanal_base) || 0;

  if (montoMora > 0 || montoPerdonado > 0) {
    totalNuevo = Number((totalAnterior + montoMora - montoPerdonado).toFixed(2));
    if (totalNuevo < (Number(prestamo.monto_desembolsado) || 0)) {
      totalNuevo = Number(prestamo.monto_desembolsado) || totalNuevo;
    }

    // Mora: misma cuota. Perdón: escala la cuota según el saldo final vs original.
    if (montoPerdonado > 0) {
      const ratio = saldoAnterior > 0.01 ? nuevoSaldo / saldoAnterior : 1;
      cuotaSemanal = Number((cuotaSemanal * ratio).toFixed(2));
    }
    cuotaTrasAjuste = Number((cuotaSemanal / Math.max(1, diasN)).toFixed(2));

    await conn.execute(
      `UPDATE Prestamos SET
        saldo_pendiente = ?,
        monto_total_pagar = ?,
        cuota_semanal_base = ?,
        updated_at = NOW(),
        is_synced = 1
       WHERE id = ?`,
      [nuevoSaldo, Math.max(totalNuevo, Number(prestamo.monto_desembolsado) || 0), cuotaSemanal, prestamoId]
    );

    const partes = [];
    if (montoMora > 0) partes.push(`mora +C$ ${montoMora.toFixed(2)}`);
    if (montoPerdonado > 0) partes.push(`perdón C$ ${montoPerdonado.toFixed(2)}`);
    const nota = `Negociación: ${partes.join(' · ')} (saldo ${saldoAnterior.toFixed(2)} → ${nuevoSaldo.toFixed(2)})${
      comentario ? ` — ${comentario}` : ''
    }`;
    await conn.execute(
      `INSERT INTO Historial_Prorrogas (
        id, prestamo_id, semanas_extra, saldo_anterior, nueva_cuota_semanal,
        fecha_prorroga, comentario, is_synced
      ) VALUES (?, ?, 0, ?, ?, NOW(), ?, 1)`,
      [uuidv4(), prestamoId, saldoAnterior, cuotaSemanal, nota]
    );
  }

  let prorroga = null;
  if (semanasExtra >= 1) {
    const extraParts = [];
    if (montoMora > 0) extraParts.push(`mora C$ ${montoMora.toFixed(2)}`);
    if (montoPerdonado > 0) extraParts.push(`perdón`);
    prorroga = await aplicarProrrogaEnNube(conn, {
      prestamo_id: prestamoId,
      semanas_extra: semanasExtra,
      comentario:
        comentario ||
        (extraParts.length
          ? `Negociación: prórroga ${semanasExtra} sem. tras ${extraParts.join(' y ')}`
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

  const msgParts = [];
  if (montoMora > 0) msgParts.push(`Mora +C$ ${montoMora.toFixed(2)}`);
  if (montoPerdonado > 0) msgParts.push(`Perdón C$ ${montoPerdonado.toFixed(2)}`);
  if (semanasExtra >= 1) msgParts.push(`${semanasExtra} sem. de prórroga`);

  return {
    prestamo_id: prestamoId,
    saldo_anterior: saldoAnterior,
    monto_mora: montoMora,
    monto_perdonado: montoPerdonado,
    nuevo_saldo: Number(p.saldo_pendiente),
    monto_total_pagar: Number(p.monto_total_pagar),
    semanas_extra: semanasExtra,
    cuotas_ajustadas: 0,
    cuota_por_visita: prorroga?.cuotaPorDiaDeCobro ?? cuotaTrasAjuste,
    cuota_semanal: prorroga?.nuevaCuotaSemanal ?? Number(p.cuota_semanal_base),
    plazo_semanas: Number(p.plazo_semanas),
    prorroga,
    mensaje: msgParts.length ? `${msgParts.join(' + ')}.` : 'Negociación aplicada.',
  };
}

module.exports = { aplicarNegociacionVencido };
