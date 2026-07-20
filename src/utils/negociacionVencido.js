const { v4: uuidv4 } = require('uuid');
const { aplicarProrrogaEnNube } = require('./prorrogasNube');

/**
 * Reparte el nuevo saldo entre cuotas Programada/Parcial (proporcional al pendiente).
 */
async function redistribuirSaldoEnCuotasPendientes(conn, prestamoId, nuevoSaldo) {
  const saldo = Math.max(0, Number(nuevoSaldo) || 0);
  const [cuotas] = await conn.execute(
    `SELECT id, monto_programado, COALESCE(monto_pagado, 0) AS monto_pagado, estado
     FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL
       AND estado IN ('Programada', 'Parcial')
     ORDER BY fecha_programada ASC`,
    [prestamoId]
  );
  if (!cuotas.length) return { cuotasAjustadas: 0, cuotaPorVisita: null };

  const pendientes = cuotas.map((c) => ({
    ...c,
    pend: Math.max(0, Number((Number(c.monto_programado) - Number(c.monto_pagado || 0)).toFixed(2))),
  }));
  const totalPend = Number(pendientes.reduce((s, c) => s + c.pend, 0).toFixed(2));
  if (totalPend <= 0.01) return { cuotasAjustadas: 0, cuotaPorVisita: null };

  let asignado = 0;
  for (let i = 0; i < pendientes.length; i += 1) {
    const c = pendientes[i];
    const esUltima = i === pendientes.length - 1;
    let nuevoPend;
    if (esUltima) {
      nuevoPend = Number((saldo - asignado).toFixed(2));
    } else {
      nuevoPend = Number(((saldo * c.pend) / totalPend).toFixed(2));
      asignado = Number((asignado + nuevoPend).toFixed(2));
    }
    if (nuevoPend < 0) nuevoPend = 0;
    const pagado = Number(c.monto_pagado || 0);
    const nuevoProgramado = Number((pagado + nuevoPend).toFixed(2));
    let estado = c.estado;
    if (nuevoPend <= 0.009) {
      estado = 'Pagada';
    } else if (pagado > 0.009) {
      estado = 'Parcial';
    } else {
      estado = 'Programada';
    }
    await conn.execute(
      `UPDATE Cuotas_Calendario SET monto_programado = ?, estado = ?, updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [Math.max(pagado, nuevoProgramado), estado, c.id]
    );
  }

  const conPend = pendientes.filter((c) => c.pend > 0.01).length || 1;
  const cuotaPorVisita = Number((saldo / conPend).toFixed(2));
  return { cuotasAjustadas: pendientes.length, cuotaPorVisita };
}

/**
 * Negociación admin: perdonar parte del saldo y/o dar prórroga (más tiempo, misma lógica de cuota).
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
    if (ns < 0.01 && semanasExtra < 1) {
      // permitir liquidar por perdón total casi
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
  let cuotasAjustadas = 0;

  if (montoPerdonado > 0) {
    const nuevoTotal = Number((Number(prestamo.monto_total_pagar) - montoPerdonado).toFixed(2));
    await conn.execute(
      `UPDATE Prestamos SET
        saldo_pendiente = ?,
        monto_total_pagar = ?,
        updated_at = NOW(),
        is_synced = 1
       WHERE id = ?`,
      [nuevoSaldo, Math.max(nuevoTotal, Number(prestamo.monto_desembolsado) || 0), prestamoId]
    );
    const redist = await redistribuirSaldoEnCuotasPendientes(conn, prestamoId, nuevoSaldo);
    cuotaTrasPerdon = redist.cuotaPorVisita;
    cuotasAjustadas = redist.cuotasAjustadas;

    const notaPerdon = `Negociación: perdón C$ ${montoPerdonado.toFixed(2)} (saldo ${saldoAnterior.toFixed(2)} → ${nuevoSaldo.toFixed(2)})${
      comentario ? ` — ${comentario}` : ''
    }`;
    await conn.execute(
      `INSERT INTO Historial_Prorrogas (
        id, prestamo_id, semanas_extra, saldo_anterior, nueva_cuota_semanal,
        fecha_prorroga, comentario, is_synced
      ) VALUES (?, ?, 0, ?, ?, NOW(), ?, 1)`,
      [
        uuidv4(),
        prestamoId,
        saldoAnterior,
        Number(prestamo.cuota_semanal_base) || cuotaTrasPerdon || 0,
        notaPerdon,
      ]
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
    cuotas_ajustadas: cuotasAjustadas,
    cuota_por_visita: prorroga?.cuotaPorDiaDeCobro ?? cuotaTrasPerdon,
    cuota_semanal: prorroga?.nuevaCuotaSemanal ?? Number(p.cuota_semanal_base),
    plazo_semanas: Number(p.plazo_semanas),
    prorroga,
    mensaje:
      montoPerdonado > 0 && semanasExtra >= 1
        ? `Perdón C$ ${montoPerdonado.toFixed(2)} + ${semanasExtra} sem. de prórroga.`
        : montoPerdonado > 0
          ? `Perdón C$ ${montoPerdonado.toFixed(2)}. Nuevo saldo C$ ${Number(p.saldo_pendiente).toFixed(2)}.`
          : `Prórroga de ${semanasExtra} semana(s) aplicada.`,
  };
}

module.exports = { aplicarNegociacionVencido, redistribuirSaldoEnCuotasPendientes };
