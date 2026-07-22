const MAPA = {
  0: 'DOMINGO',
  1: 'LUNES',
  2: 'MARTES',
  3: 'MIERCOLES',
  4: 'JUEVES',
  5: 'VIERNES',
  6: 'SABADO',
};

const normalizarDia = (d) =>
  String(d || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const { hoyISO } = require('./zonaHoraria');

const fechaCalendarioISO = (d = new Date()) => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Managua',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
};

const normalizarFechaISO = (valor) => {
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    const y = valor.getFullYear();
    const m = String(valor.getMonth() + 1).padStart(2, '0');
    const day = String(valor.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const m = String(valor ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

const diaCobroHoy = () => {
  const hoy = hoyISO();
  const d = new Date(`${hoy}T12:00:00`);
  return MAPA[d.getDay()];
};

const diaCobroDeFecha = (fechaISO) => {
  const d = new Date(`${normalizarFechaISO(fechaISO) || fechaISO}T12:00:00`);
  return MAPA[d.getDay()];
};

const incluyeDiaHoy = (diasRaw, fechaRefISO = null, periodicidad = null) => {
  try {
    const dias = typeof diasRaw === 'string' ? JSON.parse(diasRaw) : diasRaw;
    if (!Array.isArray(dias) || !dias.length) return true;
    const nums = dias.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
    const esMes =
      String(periodicidad || '').toUpperCase() === 'DIAS_MES' ||
      (nums.length === dias.length && nums.length > 0);
    if (esMes) {
      const ref = normalizarFechaISO(fechaRefISO) || fechaCalendarioISO();
      const dayNum = Number(String(ref).slice(8, 10));
      return nums.includes(dayNum);
    }
    const hoy = normalizarDia(fechaRefISO ? diaCobroDeFecha(fechaRefISO) : diaCobroHoy());
    return dias.some((d) => normalizarDia(d) === hoy);
  } catch {
    return true;
  }
};

const incluyeDiaEnFecha = (fechaISO, diasRaw, periodicidad = null) =>
  incluyeDiaHoy(diasRaw, fechaISO, periodicidad);

const esDiaDesembolso = (fechaDesembolso, fechaRefISO = fechaCalendarioISO()) => {
  const des = normalizarFechaISO(fechaDesembolso);
  const ref = normalizarFechaISO(fechaRefISO);
  return !!des && !!ref && des === ref;
};

/** ¿Incluir en agenda/ruta del día? No el mismo día del desembolso. */
const debeSugerirCobroEnFecha = (fechaRefISO, prestamo) => {
  if (!prestamo) return false;
  if (!incluyeDiaEnFecha(fechaRefISO, prestamo.dias_de_cobro, prestamo.periodicidad)) return false;
  if (esDiaDesembolso(prestamo.fecha_desembolso, fechaRefISO)) return false;
  return true;
};

/**
 * Agenda con feriados / anticipos:
 * - En feriado: solo si hay cuota con fecha_programada = hoy (anticipo raro al feriado).
 * - Fuera de feriado: día de cobro habitual O cuota movida/anticipada a hoy.
 * - Día siguiente a un feriado: también quien cobraba el día feriado y tiene cuota vencida
 *   (sin mover fechas del calendario).
 */
const addDaysISOLocal = (fecha, days) => {
  const d = new Date(`${fecha}T12:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const siguienteDiaHabilLocal = (fecha, setFeriados) => {
  let f = addDaysISOLocal(normalizarFechaISO(fecha) || fecha, 1);
  let guard = 0;
  while (setFeriados && setFeriados.has(f) && guard < 60) {
    f = addDaysISOLocal(f, 1);
    guard += 1;
  }
  return f;
};

/** ¿Hoy es el día hábil siguiente a un feriado que era día de cobro de este préstamo? */
const esRecuperacionPostFeriado = (fechaRefISO, prestamo, feriadosSet) => {
  if (!feriadosSet || !feriadosSet.size || !prestamo) return false;
  const ref = normalizarFechaISO(fechaRefISO);
  if (!ref) return false;
  for (const f of feriadosSet) {
    const fer = normalizarFechaISO(f) || f;
    if (!fer) continue;
    if (siguienteDiaHabilLocal(fer, feriadosSet) !== ref) continue;
    if (incluyeDiaEnFecha(fer, prestamo.dias_de_cobro, prestamo.periodicidad)) return true;
  }
  return false;
};

const debeIncluirEnAgenda = (fechaRefISO, prestamo, opts = {}) => {
  if (!prestamo) return false;
  const ref = normalizarFechaISO(fechaRefISO) || fechaCalendarioISO();
  if (esDiaDesembolso(prestamo.fecha_desembolso, ref)) return false;
  const feriados = opts.feriadosSet;
  const tieneCuotaHoy = !!opts.tieneCuotaHoy;
  if (feriados && feriados.has(ref)) return tieneCuotaHoy;
  if (tieneCuotaHoy) return true;
  // Vencidos del día feriado: aparecen al día hábil siguiente sin mover calendario
  if (opts.tieneCuotaVencida && esRecuperacionPostFeriado(ref, prestamo, feriados)) {
    return true;
  }
  return incluyeDiaEnFecha(ref, prestamo.dias_de_cobro, prestamo.periodicidad);
};

const tieneCuotaProgramadaEnFecha = (cuotas, prestamoId, fechaISO, esCuotaDiaDesembolsoFn, prestamo) => {
  const ref = normalizarFechaISO(fechaISO);
  if (!ref || !prestamoId) return false;
  return (cuotas || []).some((c) => {
    if (c.prestamo_id !== prestamoId) return false;
    if (c.estado && !['Programada', 'Parcial'].includes(c.estado)) return false;
    const f = normalizarFechaISO(c.fecha_programada);
    if (f !== ref) return false;
    if (esCuotaDiaDesembolsoFn && esCuotaDiaDesembolsoFn(c, prestamo)) return false;
    return true;
  });
};

const esCuotaDiaDesembolso = (cuota, prestamo) => {
  const des = normalizarFechaISO(prestamo?.fecha_desembolso);
  if (!des) return false;
  return normalizarFechaISO(cuota?.fecha_programada) === des;
};

const montoVisitaHoy = (cuotaSemanal, diasRaw) => {
  try {
    const dias = typeof diasRaw === 'string' ? JSON.parse(diasRaw) : diasRaw;
    const n = Array.isArray(dias) && dias.length ? dias.length : 1;
    return Number((Number(cuotaSemanal || 0) / n).toFixed(2));
  } catch {
    return Number(cuotaSemanal || 0);
  }
};

module.exports = {
  diaCobroHoy,
  diaCobroDeFecha,
  incluyeDiaHoy,
  incluyeDiaEnFecha,
  montoVisitaHoy,
  normalizarDia,
  normalizarFechaISO,
  fechaCalendarioISO,
  esDiaDesembolso,
  debeSugerirCobroEnFecha,
  debeIncluirEnAgenda,
  tieneCuotaProgramadaEnFecha,
  esCuotaDiaDesembolso,
  esRecuperacionPostFeriado,
  siguienteDiaHabilLocal,
};
