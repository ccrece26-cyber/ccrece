function parseFechaEvento(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function esVisitaConEvento(v) {
  return (
    v.estado_visita === 'cobrado' ||
    v.estado_visita === 'cobrado_admin' ||
    v.estado_visita === 'no_pago' ||
    v.tipo_visita === 'liquidado' ||
    v.tipo_visita === 'cobrado'
  );
}

/** Orden cronológico del día y minutos desde la visita anterior. */
function anotarTiemposVisitas(agenda = []) {
  const cronologico = agenda
    .filter((v) => v.fecha_evento && esVisitaConEvento(v))
    .map((v) => ({ prestamo_id: v.prestamo_id, ts: parseFechaEvento(v.fecha_evento)?.getTime() }))
    .filter((v) => v.ts != null)
    .sort((a, b) => a.ts - b.ts);

  const extras = new Map();
  cronologico.forEach((v, i) => {
    const minutos_desde_anterior =
      i > 0 ? Math.max(0, Math.round((v.ts - cronologico[i - 1].ts) / 60000)) : null;
    extras.set(v.prestamo_id, { orden_cronologico: i + 1, minutos_desde_anterior });
  });

  return agenda.map((v) => {
    const extra = extras.get(v.prestamo_id);
    return extra ? { ...v, ...extra } : v;
  });
}

function resumenTiemposRuta(agenda = []) {
  const eventos = agenda
    .filter((v) => v.fecha_evento && esVisitaConEvento(v))
    .map((v) => parseFechaEvento(v.fecha_evento))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!eventos.length) return null;

  const gaps = [];
  for (let i = 1; i < eventos.length; i += 1) {
    gaps.push(Math.max(0, Math.round((eventos[i] - eventos[i - 1]) / 60000)));
  }

  return {
    hora_primera_visita: eventos[0].toISOString(),
    hora_ultima_visita: eventos[eventos.length - 1].toISOString(),
    duracion_ruta_minutos: Math.max(
      0,
      Math.round((eventos[eventos.length - 1] - eventos[0]) / 60000)
    ),
    promedio_minutos_entre_visitas: gaps.length
      ? Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)
      : null,
    visitas_con_hora: eventos.length,
  };
}

module.exports = { anotarTiemposVisitas, resumenTiemposRuta, esVisitaConEvento };
