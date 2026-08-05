const { v4: uuidv4 } = require('uuid');
const { calcularLiquidacionAnticipada } = require('./finanzasNube');
const { exigirUsuarioActivo } = require('./assertUsuarioActivo');
const { rangoDiaLocal } = require('./fechasSql');

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

/**
 * Modelo flexible: el calendario de cuotas ya no es fuente de verdad.
 * Se mantienen como no-op por compatibilidad con scripts antiguos.
 */
async function aplicarMontoACuotas() {
  /* no-op: saldo se actualiza solo desde Pagos */
}

async function revertirMontoDeCuotas() {
  /* no-op */
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
  } = opts;

  if (operadorId) await exigirUsuarioActivo(operadorId, conn);

  const [prestRows] = await conn.execute(
    `SELECT * FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [prestamoId]
  );
  if (!prestRows.length) throw new Error('Prestamo no encontrado');
  const prestamo = prestRows[0];

  // Caja del que cobra (admin en modo campo = su caja, no la del cobrador asignado).
  const cobradorRegistro = operadorId || (await resolverCobradorAsignado(conn, prestamoId));
  const esLiquidacion = tipo === 'liquidacion';
  let montoEfectivo = Number(montoInput);

  if (esLiquidacion) {
    const [pagadoRows] = await conn.execute(
      `SELECT COALESCE(SUM(monto_pagado), 0) AS total FROM Pagos
       WHERE prestamo_id = ? AND deleted_at IS NULL`,
      [prestamoId]
    );
    const pagadoAcumulado = Number(pagadoRows[0]?.total || 0);
    const [prorrogaRows] = await conn.execute(
      `SELECT COUNT(*) AS n FROM Historial_Prorrogas
       WHERE prestamo_id = ? AND deleted_at IS NULL`,
      [prestamoId]
    );
    const prorrogasCount = Number(prorrogaRows[0]?.n || 0);
    const liq = calcularLiquidacionAnticipada(prestamo, new Date(), {
      pagadoAcumulado,
      prorrogasCount,
    });
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

/**
 * Fuente de verdad: saldo ≈ monto_total_pagar − sum(Pagos).
 * Nombre histórico conservado por compatibilidad.
 */
async function recalcularSaldoPrestamoDesdeCuotas(conn, prestamoId) {
  return recalcularSaldoPrestamoDesdePagos(conn, prestamoId);
}

async function recalcularSaldoPrestamoDesdePagos(conn, prestamoId) {
  const [rows] = await conn.execute(
    `SELECT p.monto_total_pagar,
            COALESCE((SELECT SUM(pg.monto_pagado) FROM Pagos pg
                      WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL), 0) AS total_pagos
     FROM Prestamos p
     WHERE p.id = ? AND p.deleted_at IS NULL
     LIMIT 1`,
    [prestamoId]
  );
  if (!rows.length) return 0;
  const total = Number(rows[0].monto_total_pagar || 0);
  const pagado = Number(rows[0].total_pagos || 0);
  const saldo = Math.max(0, Number((total - pagado).toFixed(2)));
  const estado = saldo <= 0.01 ? 'Pagado' : 'Activo';
  await conn.execute(
    `UPDATE Prestamos SET saldo_pendiente = ?, estado = ?, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
    [saldo, estado, prestamoId]
  );
  return saldo;
}

/** Compat: ya no redistribuye cuotas; solo realinea saldo desde pagos. */
async function redistribuirCuotasDesdePagos(conn, prestamoId) {
  return recalcularSaldoPrestamoDesdePagos(conn, prestamoId);
}

const TOLERANCIA_LIQUIDACION_PUSH = 2.5;

/** Detecta liquidación en sync push (flag explícito o monto ≈ liquidación en nube). */
function resolverLiquidacionEnPush(p, prestamo, pagadoAcumulado, opts = {}) {
  const fechaRef = new Date(p.fecha_pago || new Date());
  const liq = calcularLiquidacionAnticipada(prestamo, fechaRef, {
    pagadoAcumulado,
    prorrogasCount: opts.prorrogasCount,
  });
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

/**
 * Fuente de verdad tras cobro: saldo_pendiente − monto (modelo flexible).
 * No usa calendario de cuotas.
 */
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
    return 0;
  }

  let saldoAnterior = Number(prestamo?.saldo_pendiente);
  if (!Number.isFinite(saldoAnterior)) {
    const [rows] = await conn.execute(
      `SELECT saldo_pendiente FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [prestamoId]
    );
    saldoAnterior = Number(rows[0]?.saldo_pendiente || 0);
  }
  const saldo = Math.max(0, Number((saldoAnterior - Number(montoEfectivo || 0)).toFixed(2)));
  const estado = saldo <= 0.01 ? 'Pagado' : 'Activo';
  await conn.execute(
    `UPDATE Prestamos SET saldo_pendiente = ?, estado = ?, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
    [saldo, estado, prestamoId]
  );
  return saldo;
}

module.exports = {
  registrarPagoEnNube,
  registrarGestionNoPagoEnNube,
  aplicarMontoACuotas,
  revertirMontoDeCuotas,
  redistribuirCuotasDesdePagos,
  recalcularSaldoPrestamoDesdeCuotas,
  recalcularSaldoPrestamoDesdePagos,
  actualizarPrestamoTrasCobro,
  resolverLiquidacionEnPush,
  TOLERANCIA_LIQUIDACION_PUSH,
};
