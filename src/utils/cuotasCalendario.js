/** Residuo menor a C$1 por redondeo de cuotas — se absorbe automáticamente. */
const UMBRAL_RESIDUO_CUOTA = 1;

const { toFechaISO } = require('./zonaHoraria');

function fechaCuotaISO(cuota) {
  return toFechaISO(cuota?.fecha_programada) || String(cuota?.fecha_programada || '').slice(0, 10);
}

function pendienteCuota(cuota) {
  return Math.max(
    0,
    Number((Number(cuota.monto_programado) - Number(cuota.monto_pagado || 0)).toFixed(2))
  );
}

function estadoCuotaTrasAbono(nuevoPagado, montoProgramado) {
  const prog = Number(montoProgramado);
  const pag = Number(nuevoPagado);
  if (pag >= prog - 0.01) return 'Pagada';
  if (prog - pag < UMBRAL_RESIDUO_CUOTA) return 'Pagada';
  return 'Parcial';
}

function normalizarAbonoCuota(cuota, abono) {
  const prog = Number(cuota.monto_programado);
  const nuevoPagado = Number((Number(cuota.monto_pagado || 0) + abono).toFixed(2));
  const estado = estadoCuotaTrasAbono(nuevoPagado, prog);
  return {
    monto_pagado: estado === 'Pagada' ? prog : nuevoPagado,
    estado,
  };
}

function absorberResiduosCuotasEnMemoria(cuotas) {
  for (const c of cuotas) {
    if (!['Programada', 'Parcial'].includes(c.estado)) continue;
    const pend = pendienteCuota(c);
    if (pend > 0.009 && pend < UMBRAL_RESIDUO_CUOTA) {
      c.monto_pagado = Number(c.monto_programado);
      c.estado = 'Pagada';
    }
  }
}

async function absorberResiduosCuotas(conn, prestamoId) {
  await conn.execute(
    `UPDATE Cuotas_Calendario SET monto_pagado = monto_programado, estado = 'Pagada',
      updated_at = NOW(), is_synced = 1
     WHERE prestamo_id = ? AND estado IN ('Programada', 'Parcial') AND deleted_at IS NULL
       AND (monto_programado - COALESCE(monto_pagado, 0)) > 0.009
       AND (monto_programado - COALESCE(monto_pagado, 0)) < ?`,
    [prestamoId, UMBRAL_RESIDUO_CUOTA]
  );
}

function esCuotaFantasma(pendiente, saldoPrestamo, visitaTeorica) {
  if (pendiente < 0.01) return true;
  const saldo = Number(saldoPrestamo || 0);
  const visita = Number(visitaTeorica || 0);
  if (saldo > 5 && pendiente < UMBRAL_RESIDUO_CUOTA && visita >= 5) return true;
  return false;
}

/** Parcial con abono previo y resto menor a una visita — remanente de importación, no es la cuota del día. */
function esRemanenteParcialAgenda(cuota, visitaTeorica) {
  if (!cuota || cuota.estado !== 'Parcial') return false;
  const pag = Number(cuota.monto_pagado || 0);
  if (pag <= 0.009) return false;
  const pend = pendienteCuota(cuota);
  const visita = Number(visitaTeorica || 0);
  if (visita < 5 || pend < 0.01) return false;
  return pend < visita - 0.5;
}

function seleccionarCuotaAgenda(cuotasDelPrestamo, prestamo, hoy, esCuotaDiaDesembolso, montoVisitaHoyFn) {
  const hoyStr = hoy ? String(hoy).slice(0, 10) : null;
  const visita = montoVisitaHoyFn(prestamo?.cuota_semanal_base, prestamo?.dias_de_cobro);
  const saldo = Number(prestamo?.saldo_pendiente || 0);

  for (const c of cuotasDelPrestamo) {
    if (esCuotaDiaDesembolso(c, prestamo)) continue;
    const fechaCuota = fechaCuotaISO(c);
    if (hoyStr && fechaCuota && fechaCuota > hoyStr) continue;
    const pendiente = pendienteCuota(c);
    if (esCuotaFantasma(pendiente, saldo, visita)) continue;
    if (esRemanenteParcialAgenda(c, visita)) continue;
    return c;
  }
  return null;
}

function calcularToleranciaReconciliacionCuotas(montoTotalPagar, cuotasRows) {
  const total = Number(montoTotalPagar || 0);
  const sumProg = (cuotasRows || []).reduce(
    (s, c) => s + Number(c.monto_programado || 0),
    0
  );
  const residuoAgenda = Math.abs(Number((total - sumProg).toFixed(2)));
  return Math.max(120, residuoAgenda + 1.5, total * 0.02);
}

function reconciliarCuotasConPagosInMemoria(cuotasRows, sumPagos, toleranciaMax = 120) {
  const sumCuotas = Number(
    cuotasRows.reduce((s, c) => s + Number(c.monto_pagado || 0), 0).toFixed(2)
  );
  let diff = Number((sumPagos - sumCuotas).toFixed(2));
  if (Math.abs(diff) <= 0.01) return;

  if (Math.abs(diff) > toleranciaMax) {
    throw new Error(
      `No se pudo reconciliar pagos vs cuotas: pagos C$ ${sumPagos.toFixed(2)}, cuotas C$ ${sumCuotas.toFixed(2)}`
    );
  }

  const candidatas = cuotasRows.filter((c) => Number(c.monto_pagado || 0) > 0.009);
  const orden = candidatas.length ? candidatas : cuotasRows;
  for (let i = orden.length - 1; i >= 0 && Math.abs(diff) > 0.01; i -= 1) {
    const cuota = orden[i];
    const pagado = Number(cuota.monto_pagado || 0);
    const prog = Number(cuota.monto_programado || 0);
    const capped = Math.max(0, Number((pagado + diff).toFixed(2)));
    const aplicado = Number((capped - pagado).toFixed(2));
    if (aplicado === 0) continue;
    cuota.monto_pagado = capped;
    cuota.estado = capped >= prog - 0.01 ? 'Pagada' : capped > 0.009 ? 'Parcial' : 'Programada';
    diff = Number((diff - aplicado).toFixed(2));
  }
  absorberResiduosCuotasEnMemoria(cuotasRows);
}

async function reconciliarCuotasConPagos(conn, prestamoId, toleranciaMax = 120) {
  const [pagosRow] = await conn.execute(
    `SELECT COALESCE(SUM(monto_pagado), 0) AS t FROM Pagos
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const sumPagos = Number(pagosRow[0]?.t || 0);
  const [cuotasRows] = await conn.execute(
    `SELECT id, monto_programado, monto_pagado, estado FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL
     ORDER BY fecha_programada ASC`,
    [prestamoId]
  );
  const sumCuotas = Number(
    cuotasRows.reduce((s, c) => s + Number(c.monto_pagado || 0), 0).toFixed(2)
  );
  let diff = Number((sumPagos - sumCuotas).toFixed(2));
  if (Math.abs(diff) <= 0.01) return;

  if (Math.abs(diff) > toleranciaMax) {
    throw new Error(
      `No se pudo reconciliar pagos vs cuotas: pagos C$ ${sumPagos.toFixed(2)}, cuotas C$ ${sumCuotas.toFixed(2)}`
    );
  }

  const candidatas = cuotasRows.filter((c) => Number(c.monto_pagado || 0) > 0.009);
  const orden = candidatas.length ? candidatas : cuotasRows;
  for (let i = orden.length - 1; i >= 0 && Math.abs(diff) > 0.01; i -= 1) {
    const cuota = orden[i];
    const pagado = Number(cuota.monto_pagado || 0);
    const prog = Number(cuota.monto_programado || 0);
    const nuevo = Number((pagado + diff).toFixed(2));
    const capped = Math.max(0, nuevo);
    const aplicado = Number((capped - pagado).toFixed(2));
    if (aplicado === 0) continue;
    const estado =
      capped >= prog - 0.01 ? 'Pagada' : capped > 0.009 ? 'Parcial' : 'Programada';
    await conn.execute(
      `UPDATE Cuotas_Calendario SET monto_pagado = ?, estado = ?, updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [capped, estado, cuota.id]
    );
    diff = Number((diff - aplicado).toFixed(2));
  }
  await absorberResiduosCuotas(conn, prestamoId);
}

async function sincronizarCuotasTrasCierrePagado(conn, prestamoId) {
  const { voidarCuotasRestantesAlCerrar } = require('./cobroMontos');
  const [prestamoRow] = await conn.execute(
    `SELECT monto_total_pagar, estado FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [prestamoId]
  );
  if (!prestamoRow.length) return;
  const estado = prestamoRow[0].estado;
  if (estado !== 'Pagado' && !String(estado).includes('Pagado')) return;

  await voidarCuotasRestantesAlCerrar(conn, prestamoId);
  const [cuotasRows] = await conn.execute(
    `SELECT monto_programado, monto_pagado FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const tol = calcularToleranciaReconciliacionCuotas(prestamoRow[0].monto_total_pagar, cuotasRows);
  await reconciliarCuotasConPagos(conn, prestamoId, tol);
}

function montoCobroDelDia(cuotaPend, prestamo, montoVisitaHoyFn) {
  const visitaTeorica = montoVisitaHoyFn(prestamo?.cuota_semanal_base, prestamo?.dias_de_cobro);
  let montoRaw = cuotaPend
    ? pendienteCuota(cuotaPend)
    : visitaTeorica;
  const saldo = Number(prestamo?.saldo_pendiente || 0);
  if (
    cuotaPend &&
    visitaTeorica >= 5 &&
    saldo >= visitaTeorica &&
    esRemanenteParcialAgenda(cuotaPend, visitaTeorica)
  ) {
    montoRaw = visitaTeorica;
  } else if (saldo > 5 && montoRaw < 5 && visitaTeorica >= 5) {
    montoRaw = visitaTeorica;
  }
  return montoRaw;
}

module.exports = {
  UMBRAL_RESIDUO_CUOTA,
  pendienteCuota,
  estadoCuotaTrasAbono,
  normalizarAbonoCuota,
  absorberResiduosCuotasEnMemoria,
  absorberResiduosCuotas,
  calcularToleranciaReconciliacionCuotas,
  reconciliarCuotasConPagosInMemoria,
  reconciliarCuotasConPagos,
  sincronizarCuotasTrasCierrePagado,
  esCuotaFantasma,
  esRemanenteParcialAgenda,
  seleccionarCuotaAgenda,
  montoCobroDelDia,
};
