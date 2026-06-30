const { hoyISO, rangoDiaNicaragua, rangoPeriodoNicaragua } = require('./zonaHoraria');

/** Rango [inicio, fin) en UTC para filtros sobre fecha_pago almacenada en UTC. */
function rangoDiaLocal(fechaISO) {
  return rangoDiaNicaragua(fechaISO);
}

function rangoPeriodoLocal(desdeISO, hastaISO) {
  return rangoPeriodoNicaragua(desdeISO, hastaISO);
}

function hoyRango() {
  return rangoDiaLocal(hoyISO());
}

/** Cierres guardan fecha calendario YYYY-MM-DD; usar DATE(), no rango horario. */
function whereCierreCalendarioDia(columna = 'fecha_cierre') {
  return `DATE(${columna}) = DATE(?)`;
}

/** Convierte ISO local del cobrador a unix seg para comparar con DATETIME en TiDB. */
function desdeCorreccionesUnix(desde) {
  const ms = new Date(desde || 0).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

module.exports = {
  rangoDiaLocal,
  rangoPeriodoLocal,
  hoyRango,
  hoyISO,
  whereCierreCalendarioDia,
  desdeCorreccionesUnix,
};
