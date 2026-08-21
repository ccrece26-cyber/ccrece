/**
 * Renovación atómica en nube: pago saldo (tipo renovacion) + cierra viejo + crea nuevo + log.
 * Todo en la misma transacción del caller (conn).
 */
const { v4: uuidv4 } = require('uuid');
const { aplicarProrrogaEnNube } = require('./prorrogasNube');

function parseDias(np) {
  if (Array.isArray(np.dias_de_cobro)) return np.dias_de_cobro.filter(Boolean);
  if (typeof np.dias_de_cobro === 'string') {
    try {
      const p = JSON.parse(np.dias_de_cobro);
      return Array.isArray(p) && p.length ? p.filter(Boolean) : ['LUNES'];
    } catch {
      return ['LUNES'];
    }
  }
  return ['LUNES'];
}

/**
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {{ prestamo_anterior_id: string, nuevo_prestamo: object, log?: object, operador?: { id?: string, nombre?: string }, pago_id?: string }} opts
 */
async function ejecutarRenovacionAtomica(conn, opts) {
  const { prestamo_anterior_id, nuevo_prestamo, log = {}, operador = {}, pago_id = null } = opts;
  const np = nuevo_prestamo || {};
  const operadorId = operador?.id || np.cobrador_registro_id || null;

  const [antRows] = await conn.execute(
    `SELECT p.id, p.saldo_pendiente, p.estado, p.cliente_id, c.cobrador_id
     FROM Prestamos p
     JOIN Clientes c ON c.id = p.cliente_id
     WHERE p.id = ? AND p.deleted_at IS NULL
     LIMIT 1`,
    [prestamo_anterior_id]
  );
  if (!antRows.length) {
    const err = new Error('Préstamo anterior no encontrado.');
    err.status = 404;
    throw err;
  }
  const ant = antRows[0];

  if (String(ant.estado) === 'Pagado' && Number(ant.saldo_pendiente) <= 0.01) {
    const [yaNuevo] = await conn.execute(
      `SELECT id FROM Prestamos
       WHERE renovacion_previa_id = ? AND deleted_at IS NULL
       ORDER BY fecha_desembolso DESC LIMIT 1`,
      [prestamo_anterior_id]
    );
    if (yaNuevo.length) {
      return {
        already: true,
        id: yaNuevo[0].id,
        efectivo_entregar: Number(log.efectivo_entregar) || 0,
        pago_saldo_anterior: Number(log.saldo_pendiente_anterior) || 0,
        cobrador_id: ant.cobrador_id,
        cliente_id: ant.cliente_id,
      };
    }
  }

  if (String(ant.estado) !== 'Activo') {
    const err = new Error('El préstamo anterior no está activo; no se puede renovar.');
    err.status = 400;
    throw err;
  }

  const saldoAnt =
    Number(log.saldo_pendiente_anterior != null ? log.saldo_pendiente_anterior : ant.saldo_pendiente) ||
    0;

  const montoRecibo = Number(
    log.base_nominal != null
      ? log.base_nominal
      : log.nuevo_desembolso != null
        ? log.nuevo_desembolso
        : np.monto_desembolsado
  );
  if (!(montoRecibo > 0)) {
    const err = new Error('Monto de renovación inválido.');
    err.status = 400;
    throw err;
  }

  const efectivoEntregar =
    log.efectivo_entregar != null
      ? Number(log.efectivo_entregar)
      : Number((montoRecibo - saldoAnt).toFixed(2));

  let cobradorCumplimiento = ant.cobrador_id || operadorId || null;
  if (cobradorCumplimiento) {
    const [uOk] = await conn.execute(
      `SELECT id FROM Usuarios WHERE id = ? AND (deleted_at IS NULL OR deleted_at = '') LIMIT 1`,
      [cobradorCumplimiento]
    );
    if (!uOk.length) cobradorCumplimiento = operadorId || null;
  }
  if (saldoAnt > 0.009 && !cobradorCumplimiento) {
    const err = new Error(
      'No hay cobrador válido para registrar el cobro del saldo. Cierre sesión y entre de nuevo.'
    );
    err.status = 400;
    throw err;
  }

  const [otroActivo] = await conn.execute(
    `SELECT id FROM Prestamos
     WHERE cliente_id = ? AND estado = 'Activo' AND id != ? AND deleted_at IS NULL
     LIMIT 1`,
    [ant.cliente_id, prestamo_anterior_id]
  );
  if (otroActivo.length) {
    const err = new Error('Este cliente ya tiene otro crédito activo.');
    err.status = 400;
    throw err;
  }

  const regAdmin =
    operadorId && cobradorCumplimiento && String(operadorId) !== String(cobradorCumplimiento) ? 1 : 0;

  let pagoSaldoId = null;
  if (saldoAnt > 0.009) {
    pagoSaldoId = pago_id || uuidv4();
    try {
      await conn.execute(
        `INSERT INTO Pagos (
          id, prestamo_id, cobrador_id, monto_pagado, fecha_pago, latitud, longitud,
          registrado_por_admin, operador_id, tipo_cobro, is_synced
        ) VALUES (?, ?, ?, ?, NOW(), 0, 0, ?, ?, 'renovacion', 1)`,
        [
          pagoSaldoId,
          prestamo_anterior_id,
          cobradorCumplimiento,
          saldoAnt,
          regAdmin,
          operadorId || cobradorCumplimiento,
        ]
      );
    } catch (e) {
      // Compat: columna tipo_cobro aún no migrada
      if (/tipo_cobro/i.test(String(e.message || ''))) {
        await conn.execute(
          `INSERT INTO Pagos (
            id, prestamo_id, cobrador_id, monto_pagado, fecha_pago, latitud, longitud,
            registrado_por_admin, operador_id, is_synced
          ) VALUES (?, ?, ?, ?, NOW(), 0, 0, ?, ?, 1)`,
          [
            pagoSaldoId,
            prestamo_anterior_id,
            cobradorCumplimiento,
            saldoAnt,
            regAdmin,
            operadorId || cobradorCumplimiento,
          ]
        );
      } else {
        throw e;
      }
    }
  }

  await conn.execute(
    `UPDATE Prestamos SET estado = 'Pagado', saldo_pendiente = 0, updated_at = NOW(), is_synced = 1
     WHERE id = ?`,
    [prestamo_anterior_id]
  );

  const diasArr = parseDias(np);
  const diasJson = JSON.stringify(diasArr);
  const frecuencia = diasArr.length || 1;

  let tasa = Number(np.tasa_interes_aplicada ?? log.tasa_aplicada);
  if (!Number.isFinite(tasa)) tasa = 0;
  if (tasa > 1 && tasa <= 100) tasa = Number((tasa / 100).toFixed(4));
  const tasaPrestamo = Number(tasa.toFixed(2));
  const tasaLog = Number(Math.min(9.9999, Math.max(0, tasa)).toFixed(4));

  const entregaId = np.cobrador_entrega_id || operadorId || cobradorCumplimiento || null;
  const nuevoId = np.id || uuidv4();
  const cuota = Number(np.cuota_semanal_base ?? log.cuota_semanal) || 0;
  const totalPagar = Number(np.monto_total_pagar ?? log.monto_total_a_pagar) || 0;
  const saldoNuevo = Number(np.saldo_pendiente != null ? np.saldo_pendiente : totalPagar) || 0;
  const semanasProrroga = Math.max(
    0,
    Math.floor(Number(np.semanas_prorroga ?? log.semanas_prorroga ?? 0))
  );
  const plazoBase = Math.max(
    1,
    Math.floor(
      Number(
        np.plazo_base_semanas ??
          (np.plazo_semanas != null && semanasProrroga
            ? Number(np.plazo_semanas) - semanasProrroga
            : np.plazo_semanas)
      )
    ) || 0
  );
  const plazoTotal = plazoBase + semanasProrroga;

  await conn.execute(
    `INSERT INTO Prestamos (
      id, cliente_id, monto_desembolsado, plazo_semanas, tasa_interes_aplicada,
      cuota_semanal_base, monto_total_pagar, saldo_pendiente, frecuencia_semana, dias_de_cobro,
      periodicidad, renovacion_previa_id, estado, fecha_desembolso,
      numero_recibo_fisico, cobrador_registro_id, cobrador_entrega_id, is_synced
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SEMANAL', ?, 'Activo', ?, ?, ?, ?, 1)`,
    [
      nuevoId,
      np.cliente_id || ant.cliente_id,
      montoRecibo,
      plazoBase,
      tasaPrestamo,
      cuota,
      totalPagar,
      saldoNuevo,
      frecuencia,
      diasJson,
      prestamo_anterior_id,
      np.fecha_desembolso || null,
      np.numero_recibo_fisico || null,
      operadorId,
      entregaId,
    ]
  );

  if (semanasProrroga >= 1) {
    await aplicarProrrogaEnNube(conn, {
      prestamo_id: nuevoId,
      semanas_extra: semanasProrroga,
      comentario:
        log.comentario_prorroga ||
        `Renovación: ${plazoBase}+${semanasProrroga} sem (prórroga al crear)`,
      operador_id: operadorId,
    });
  }

  const logId = log.id || uuidv4();
  await conn.execute(
    `INSERT INTO Renovaciones_Log (
      id, prestamo_anterior_id, prestamo_nuevo_id, saldo_pendiente_anterior, nuevo_desembolso,
      base_nominal, tasa_aplicada, monto_total_a_pagar, cuota_semanal, fecha_renovacion,
      cobrador_opero_id, cobrador_entrega_id, plazo_semanas, efectivo_entregar, is_synced
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 1)`,
    [
      logId,
      prestamo_anterior_id,
      nuevoId,
      saldoAnt,
      montoRecibo,
      montoRecibo,
      tasaLog,
      totalPagar,
      cuota,
      operadorId,
      log.cobrador_entrega_id || entregaId,
      plazoTotal,
      efectivoEntregar,
    ]
  );

  const [cliRows] = await conn.execute(
    'SELECT nombre_completo, telefono FROM Clientes WHERE id = ? LIMIT 1',
    [np.cliente_id || ant.cliente_id]
  );

  return {
    already: false,
    id: nuevoId,
    pago_id: pagoSaldoId,
    renovacion_log_id: logId,
    efectivo_entregar: efectivoEntregar,
    pago_saldo_anterior: saldoAnt,
    cobrador_id: ant.cobrador_id,
    cliente_id: ant.cliente_id,
    cliente: cliRows[0] || null,
    operador_nombre: operador?.nombre || null,
  };
}

module.exports = { ejecutarRenovacionAtomica };
