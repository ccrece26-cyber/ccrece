const { v4: uuidv4 } = require('uuid');
const { calcularLiquidacionAnticipada } = require('./finanzasNube');
const { exigirUsuarioActivo } = require('./assertUsuarioActivo');
const { rangoDiaLocal } = require('./fechasSql');
const { normalizarAbonoCuota, absorberResiduosCuotas, sincronizarCuotasTrasCierrePagado } = require('./cuotasCalendario');

async function resolverCobradorAsignado(conn, prestamoId) {
  const [rows] = await conn.execute(
    `SELECT c.cobrador_id
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE p.id = ? AND p.deleted_at IS NULL
     LIMIT 1`,
    [prestamoId]
  );
  return rows[0]?.cobrador_id || null;
}

async function aplicarMontoACuotas(conn, prestamoId, monto, fechaISO) {
  const [cuotas] = await conn.execute(
    `SELECT id, monto_programado, monto_pagado FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND estado IN ('Programada', 'Parcial') AND deleted_at IS NULL
     ORDER BY fecha_programada ASC`,
    [prestamoId]
  );
  let restante = Number(monto);
  for (const cuota of cuotas) {
    if (restante <= 0) break;
    const pendiente = Math.max(
      0,
      Number((Number(cuota.monto_programado) - Number(cuota.monto_pagado || 0)).toFixed(2))
    );
    if (pendiente <= 0) continue;
    const abono = Math.min(restante, pendiente);
    const { monto_pagado: nuevoPagado, estado } = normalizarAbonoCuota(cuota, abono);
    await conn.execute(
      `UPDATE Cuotas_Calendario SET monto_pagado = ?, estado = ?, updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [nuevoPagado, estado, cuota.id]
    );
    restante = Number((restante - abono).toFixed(2));
  }
  await absorberResiduosCuotas(conn, prestamoId);
}

/** Revierte abono de cuotas (de la más reciente hacia atrás) al corregir un pago hacia abajo. */
async function revertirMontoDeCuotas(conn, prestamoId, monto) {
  let restante = Number(monto);
  if (restante <= 0) return;

  const [cuotas] = await conn.execute(
    `SELECT id, monto_programado, monto_pagado FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND COALESCE(monto_pagado, 0) > 0.009 AND deleted_at IS NULL
     ORDER BY fecha_programada DESC`,
    [prestamoId]
  );

  for (const cuota of cuotas) {
    if (restante <= 0) break;
    const pagado = Number(cuota.monto_pagado || 0);
    const quitar = Math.min(restante, pagado);
    const nuevo = Number((pagado - quitar).toFixed(2));
    let estado = 'Programada';
    if (nuevo >= Number(cuota.monto_programado) - 0.01) estado = 'Pagada';
    else if (nuevo > 0.009) estado = 'Parcial';
    await conn.execute(
      `UPDATE Cuotas_Calendario SET monto_pagado = ?, estado = ?, updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [nuevo, estado, cuota.id]
    );
    restante = Number((restante - quitar).toFixed(2));
  }
}

/**
 * Registra cobro en TiDB (admin modo campo — siempre en línea).
 */
async function registrarPagoEnNube(conn, opts) {
  const {
    prestamo_id: prestamoId,
    operador_id: operadorId,
    monto_pagado: montoInput,
    latitud = 0,
    longitud = 0,
    tipo = 'personalizado',
    num_cuotas: numCuotas,
  } = opts;

  if (operadorId) await exigirUsuarioActivo(operadorId, conn);

  const [prestRows] = await conn.execute(
    `SELECT * FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [prestamoId]
  );
  if (!prestRows.length) throw new Error('Prestamo no encontrado');
  const prestamo = prestRows[0];

  const cobradorRegistro = (await resolverCobradorAsignado(conn, prestamoId)) || operadorId;
  const esLiquidacion = tipo === 'liquidacion';
  let montoEfectivo = Number(montoInput);

  if (esLiquidacion) {
    const [pagadoRows] = await conn.execute(
      `SELECT COALESCE(SUM(monto_pagado), 0) AS total FROM Pagos
       WHERE prestamo_id = ? AND deleted_at IS NULL`,
      [prestamoId]
    );
    const pagadoAcumulado = Number(pagadoRows[0]?.total || 0);
    const liq = calcularLiquidacionAnticipada(prestamo, new Date(), { pagadoAcumulado });
    montoEfectivo = Number(liq.montoLiquidacion);
    if (!Number.isFinite(montoEfectivo) || montoEfectivo <= 0) {
      throw new Error('Este prestamo ya esta liquidado o sin saldo.');
    }
  }

  if (!Number.isFinite(montoEfectivo) || montoEfectivo <= 0) throw new Error('Monto invalido');
  if (!esLiquidacion && montoEfectivo > Number(prestamo.saldo_pendiente) + 0.01) {
    throw new Error(`Monto supera saldo pendiente (C$ ${Number(prestamo.saldo_pendiente).toFixed(2)})`);
  }

  const { inicio, fin } = rangoDiaLocal(new Date());
  const [cobroHoy] = await conn.execute(
    `SELECT id, registrado_por_admin FROM Pagos
     WHERE prestamo_id = ? AND deleted_at IS NULL AND fecha_pago >= ? AND fecha_pago < ?
     LIMIT 1`,
    [prestamoId, inicio, fin]
  );
  if (cobroHoy.length) {
    throw new Error(
      Number(cobroHoy[0].registrado_por_admin) === 1
        ? 'Este credito ya fue cobrado hoy.'
        : 'Este credito ya tiene un cobro registrado hoy por el cobrador.'
    );
  }

  const pagoId = uuidv4();
  const fecha = new Date().toISOString();

  await conn.execute(
    `INSERT INTO Pagos (id, prestamo_id, cobrador_id, monto_pagado, fecha_pago, latitud, longitud,
      registrado_por_admin, operador_id, is_synced, editado_por_admin_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, NOW())`,
    [pagoId, prestamoId, cobradorRegistro, montoEfectivo, fecha, latitud, longitud, operadorId]
  );

  await aplicarMontoACuotas(conn, prestamoId, montoEfectivo, fecha);
  const nuevoSaldo = await actualizarPrestamoTrasCobro(conn, prestamoId, {
    esLiquidacion,
    prestamo,
    montoEfectivo,
  });

  return {
    pagoId,
    saldoRestante: esLiquidacion ? 0 : nuevoSaldo,
    montoAplicado: montoEfectivo,
    liquidacion: esLiquidacion,
    cobrador_id: cobradorRegistro,
    estado_visita: 'cobrado_admin',
  };
}

async function registrarGestionNoPagoEnNube(conn, opts) {
  const { prestamo_id: prestamoId, operador_id: operadorId, motivo, latitud = 0, longitud = 0 } = opts;
  if (operadorId) await exigirUsuarioActivo(operadorId, conn);
  const cobradorRegistro = (await resolverCobradorAsignado(conn, prestamoId)) || operadorId;
  const id = uuidv4();
  const fecha = new Date().toISOString();
  await conn.execute(
    `INSERT INTO Gestiones_No_Pago (id, prestamo_id, cobrador_id, motivo, fecha_gestion, latitud, longitud,
      registrado_por_admin, operador_id, is_synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
    [id, prestamoId, cobradorRegistro, motivo, fecha, latitud, longitud, operadorId]
  );
  return { id, cobrador_id: cobradorRegistro };
}

/** Reparte de cero el calendario según la suma real de Pagos (corrige liquidaciones). */
async function redistribuirCuotasDesdePagos(conn, prestamoId) {
  await conn.execute(
    `UPDATE Cuotas_Calendario SET monto_pagado = 0, estado = 'Programada', updated_at = NOW(), is_synced = 1
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const [pagos] = await conn.execute(
    `SELECT monto_pagado FROM Pagos
     WHERE prestamo_id = ? AND deleted_at IS NULL
     ORDER BY fecha_pago ASC`,
    [prestamoId]
  );
  for (const pg of pagos) {
    await aplicarMontoACuotas(conn, prestamoId, Number(pg.monto_pagado));
  }
  const [prestamo] = await conn.execute(
    `SELECT estado FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [prestamoId]
  );
  const estado = prestamo[0]?.estado || 'Activo';
  if (estado === 'Pagado' || String(estado).includes('Pagado')) {
    await sincronizarCuotasTrasCierrePagado(conn, prestamoId);
  }
  return recalcularSaldoPrestamoDesdeCuotas(conn, prestamoId);
}

async function recalcularSaldoPrestamoDesdeCuotas(conn, prestamoId) {
  const [rows] = await conn.execute(
    `SELECT COALESCE(SUM(GREATEST(0, monto_programado - COALESCE(monto_pagado, 0))), 0) AS saldo
     FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const saldo = Number(Number(rows[0]?.saldo || 0).toFixed(2));
  const estado = saldo <= 0.01 ? 'Pagado' : 'Activo';
  await conn.execute(
    `UPDATE Prestamos SET saldo_pendiente = ?, estado = ?, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
    [saldo, estado, prestamoId]
  );
  return saldo;
}

const TOLERANCIA_LIQUIDACION_PUSH = 2.5;

/** Detecta liquidación en sync push (flag explícito o monto ≈ liquidación en nube). */
function resolverLiquidacionEnPush(p, prestamo, pagadoAcumulado) {
  const fechaRef = new Date(p.fecha_pago || new Date());
  const liq = calcularLiquidacionAnticipada(prestamo, fechaRef, { pagadoAcumulado });
  const montoCliente = Number(p.monto_pagado);
  const flagExplicito =
    p.tipo_cobro === 'liquidacion' ||
    p.tipo === 'liquidacion' ||
    Number(p.es_liquidacion) === 1 ||
    p.es_liquidacion === true;

  const saldoNube = Number(prestamo.saldo_pendiente || 0);
  const porMonto =
    montoCliente > 0.01 &&
    (Math.abs(montoCliente - liq.montoLiquidacion) <= TOLERANCIA_LIQUIDACION_PUSH ||
      (liq.vencido && montoCliente >= saldoNube - 0.02));

  const esLiquidacion = flagExplicito || porMonto;
  let montoEfectivo = montoCliente;
  if (esLiquidacion && Number(liq.montoLiquidacion) > 0.01) {
    montoEfectivo = Number(liq.montoLiquidacion);
  }
  return { esLiquidacion, montoEfectivo, liq };
}

/** Fuente única de verdad tras cobro: calendario de cuotas (evita descuadres por resta manual). */
async function actualizarPrestamoTrasCobro(conn, prestamoId, opts = {}) {
  const { esLiquidacion = false, prestamo = null, montoEfectivo = 0 } = opts;

  if (esLiquidacion && prestamo) {
    await conn.execute(
      `UPDATE Prestamos SET saldo_pendiente = 0,
        monto_total_pagar = ?,
        estado = 'Pagado', updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [
        Number(
          (
            Number(prestamo.monto_total_pagar) -
            Number(prestamo.saldo_pendiente) +
            Number(montoEfectivo)
          ).toFixed(2)
        ),
        prestamoId,
      ]
    );
    await sincronizarCuotasTrasCierrePagado(conn, prestamoId);
    return 0;
  }

  const saldo = await recalcularSaldoPrestamoDesdeCuotas(conn, prestamoId);
  const [estRow] = await conn.execute(
    `SELECT estado FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [prestamoId]
  );
  if (estRow[0]?.estado === 'Pagado') {
    await sincronizarCuotasTrasCierrePagado(conn, prestamoId);
  }
  return saldo;
}

module.exports = {
  registrarPagoEnNube,
  registrarGestionNoPagoEnNube,
  aplicarMontoACuotas,
  revertirMontoDeCuotas,
  redistribuirCuotasDesdePagos,
  recalcularSaldoPrestamoDesdeCuotas,
  actualizarPrestamoTrasCobro,
  resolverLiquidacionEnPush,
  TOLERANCIA_LIQUIDACION_PUSH,
};
