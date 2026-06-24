/** Nicaragua (UTC−6, sin horario de verano). */
const ZONA_NICARAGUA = 'America/Managua';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_NICARAGUA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function fechaNicaraguaManual(date = new Date()) {
  const ms = date.getTime() - 6 * 60 * 60 * 1000;
  const n = new Date(ms);
  const y = n.getUTCFullYear();
  const m = String(n.getUTCMonth() + 1).padStart(2, '0');
  const d = String(n.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fechaEnZona(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return fechaNicaraguaManual(new Date());
  }
  try {
    const s = fmt.format(date);
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  } catch {
    /* fallback */
  }
  return fechaNicaraguaManual(date);
}

function toFechaISO(valor) {
  if (typeof valor === 'function') return toFechaISO(valor());
  if (valor instanceof Date) return fechaEnZona(valor);
  if (valor == null || valor === '') return hoyISO();
  const s = String(valor).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s.includes('T') ? s : `${s}T12:00:00`);
  if (!Number.isNaN(d.getTime())) return fechaEnZona(d);
  return hoyISO();
}

function hoyISO() {
  return fechaEnZona(new Date());
}

/** Rango [inicio, fin) en UTC para filtros sobre fecha_pago almacenada en UTC. */
function rangoDiaNicaragua(fechaISO) {
  const d = toFechaISO(fechaISO);
  const [y, m, day] = d.split('-').map(Number);
  const inicio = `${d} 06:00:00`;
  const finDate = new Date(Date.UTC(y, m - 1, day + 1, 6, 0, 0, 0));
  const fin = `${finDate.toISOString().slice(0, 10)} 06:00:00`;
  return { inicio, fin };
}

module.exports = { ZONA_NICARAGUA, fechaEnZona, hoyISO, toFechaISO, rangoDiaNicaragua };
