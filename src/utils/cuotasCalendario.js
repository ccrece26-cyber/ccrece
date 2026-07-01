/** Residuo menor a C$1 por redondeo de cuotas — se absorbe automáticamente. */
const UMBRAL_RESIDUO_CUOTA = 1;

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

function seleccionarCuotaAgenda(cuotasDelPrestamo, prestamo, hoy, esCuotaDiaDesembolso, montoVisitaHoyFn) {
  const hoyStr = hoy ? String(hoy).slice(0, 10) : null;
  const visita = montoVisitaHoyFn(prestamo?.cuota_semanal_base, prestamo?.dias_de_cobro);
  const saldo = Number(prestamo?.saldo_pendiente || 0);

  for (const c of cuotasDelPrestamo) {
    if (esCuotaDiaDesembolso(c, prestamo)) continue;
    const fechaCuota = String(c.fecha_programada || '').slice(0, 10);
    if (hoyStr && fechaCuota && fechaCuota > hoyStr) continue;
    const pendiente = pendienteCuota(c);
    if (esCuotaFantasma(pendiente, saldo, visita)) continue;
    return c;
  }
  return null;
}

function montoCobroDelDia(cuotaPend, prestamo, montoVisitaHoyFn) {
  const visitaTeorica = montoVisitaHoyFn(prestamo?.cuota_semanal_base, prestamo?.dias_de_cobro);
  let montoRaw = cuotaPend
    ? pendienteCuota(cuotaPend)
    : visitaTeorica;
  const saldo = Number(prestamo?.saldo_pendiente || 0);
  if (saldo > 5 && montoRaw < 5 && visitaTeorica >= 5) {
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
  esCuotaFantasma,
  seleccionarCuotaAgenda,
  montoCobroDelDia,
};
