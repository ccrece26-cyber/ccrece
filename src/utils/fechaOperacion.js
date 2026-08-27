/**
 * Fecha de operación admin (cobros / renovaciones / créditos con día pasado).
 * Solo YYYY-MM-DD o ISO; no admite futuro.
 */
const { hoyISO, toFechaISO, rangoDiaNicaragua } = require('./zonaHoraria');

const MAX_DIAS_ATRAS = 120;

function diasEntre(aISO, bISO) {
  const [ya, ma, da] = toFechaISO(aISO).split('-').map(Number);
  const [yb, mb, db] = toFechaISO(bISO).split('-').map(Number);
  const a = Date.UTC(ya, ma - 1, da);
  const b = Date.UTC(yb, mb - 1, db);
  return Math.round((b - a) / 86400000);
}

/**
 * @param {string|Date|null|undefined} valor
 * @param {{ permitirPasado?: boolean }} opts  permitirPasado=false → siempre hoy
 * @returns {{ dia: string, fechaSql: string, esHoy: boolean, rango: { inicio: string, fin: string } }}
 */
function resolverFechaOperacion(valor, opts = {}) {
  const { permitirPasado = true } = opts;
  const hoy = hoyISO();
  if (!permitirPasado || valor == null || valor === '') {
    const rango = rangoDiaNicaragua(hoy);
    return {
      dia: hoy,
      fechaSql: new Date().toISOString().slice(0, 19).replace('T', ' '),
      esHoy: true,
      rango,
    };
  }

  const dia = toFechaISO(valor);
  if (dia > hoy) {
    const err = new Error('No se puede registrar una operación en fecha futura.');
    err.status = 400;
    throw err;
  }
  const atras = diasEntre(dia, hoy);
  if (atras > MAX_DIAS_ATRAS) {
    const err = new Error(
      `La fecha no puede ser de hace más de ${MAX_DIAS_ATRAS} días. Use scripts de carga si es histórico.`
    );
    err.status = 400;
    throw err;
  }

  const rango = rangoDiaNicaragua(dia);
  const esHoy = dia === hoy;
  // 17:00 Nicaragua = 23:00 UTC del mismo día calendario
  const [y, m, d] = dia.split('-').map(Number);
  const fechaSql = esHoy
    ? new Date().toISOString().slice(0, 19).replace('T', ' ')
    : new Date(Date.UTC(y, m - 1, d, 23, 0, 0)).toISOString().slice(0, 19).replace('T', ' ');

  return { dia, fechaSql, esHoy, rango };
}

module.exports = { resolverFechaOperacion, MAX_DIAS_ATRAS };
