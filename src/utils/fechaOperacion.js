/**
 * Fecha de operación admin (cobros / renovaciones / créditos con día pasado).
 * Guarda DATETIME en hora de Nicaragua (America/Managua), no UTC.
 */
const {
  hoyISO,
  toFechaISO,
  rangoDiaNicaragua,
  fechaHoraSqlNicaragua,
} = require('./zonaHoraria');

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
      fechaSql: fechaHoraSqlNicaragua(hoy),
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
  const fechaSql = fechaHoraSqlNicaragua(dia);

  return { dia, fechaSql, esHoy, rango };
}

module.exports = { resolverFechaOperacion, MAX_DIAS_ATRAS };
