/**
 * Frecuencia SEMANAL | DIAS_MES (mirror app-financiera/src/utils/frecuenciaCobro.js)
 */
const TIPO_SEMANAL = 'SEMANAL';
const TIPO_DIAS_MES = 'DIAS_MES';
const FRECUENCIA_DEFAULT = ['LUNES', 'MIERCOLES', 'VIERNES'];
const ORDEN = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

const DIAS_ALIASES = {
  L: 'LUNES', LU: 'LUNES', LUN: 'LUNES', LUNES: 'LUNES',
  M: 'MARTES', MA: 'MARTES', MAR: 'MARTES', MARTES: 'MARTES',
  X: 'MIERCOLES', MI: 'MIERCOLES', MIE: 'MIERCOLES', MIERCOLES: 'MIERCOLES',
  J: 'JUEVES', JU: 'JUEVES', JUE: 'JUEVES', JUEVES: 'JUEVES',
  V: 'VIERNES', VI: 'VIERNES', VIE: 'VIERNES', VIERNES: 'VIERNES',
  S: 'SABADO', SA: 'SABADO', SAB: 'SABADO', SABADO: 'SABADO',
  D: 'DOMINGO', DO: 'DOMINGO', DOM: 'DOMINGO', DOMINGO: 'DOMINGO',
};

const normToken = (p) =>
  String(p || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]/g, '');

const normalizarDia = (d) =>
  String(d || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const esDiaMesNumero = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 31;
};

const esListaDiasMes = (arr) =>
  Array.isArray(arr) && arr.length > 0 && arr.every((d) => esDiaMesNumero(d));

const ordenarDias = (dias) =>
  [...new Set(dias.map(normalizarDia).filter((d) => ORDEN.includes(d)))].sort(
    (a, b) => ORDEN.indexOf(a) - ORDEN.indexOf(b)
  );

const ordenarDiasMes = (dias) =>
  [...new Set(dias.map((d) => Number(d)).filter(esDiaMesNumero))].sort((a, b) => a - b);

const parseDiasMesRaw = (raw) => {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return ordenarDiasMes(raw);
  const nums = String(raw).match(/\b([1-9]|[12]\d|3[01])\b/g);
  if (!nums || !nums.length) return [];
  return ordenarDiasMes(nums.map(Number));
};

const parecePatronMes = (raw) => {
  const s = String(raw || '');
  if (/\d+\s*y\s*\d+/i.test(s)) return true;
  if (/cada\s*mes/i.test(s)) return true;
  if (/quincen/i.test(s)) return true;
  const soloNums = s.replace(/[,;|/\s yYeE]+/g, ',').split(',').filter(Boolean);
  return soloNums.length > 0 && soloNums.every((p) => esDiaMesNumero(p));
};

const parseDiasCobroSemanal = (valor) => {
  if (!valor) return [...FRECUENCIA_DEFAULT];
  if (Array.isArray(valor)) {
    const dias = ordenarDias(
      valor.map((d) => DIAS_ALIASES[normToken(d)] || normalizarDia(d))
    );
    return dias.length ? dias : [...FRECUENCIA_DEFAULT];
  }
  try {
    const raw = typeof valor === 'string' ? JSON.parse(valor) : valor;
    if (Array.isArray(raw) && raw.length) {
      const dias = ordenarDias(
        raw.map((d) => DIAS_ALIASES[normToken(d)] || normalizarDia(d))
      );
      if (dias.length) return dias;
    }
  } catch {
    /* split */
  }
  const partes = String(valor)
    .split(/[,;|/+\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const dias = [];
  for (const p of partes) {
    const k = normToken(p);
    const dia = DIAS_ALIASES[k] || (ORDEN.includes(k) ? k : null);
    if (dia && !dias.includes(dia)) dias.push(dia);
  }
  return dias.length ? ordenarDias(dias) : [...FRECUENCIA_DEFAULT];
};

const resolverFrecuenciaCobro = ({
  tipo_frecuencia,
  periodicidad,
  dias_cobro,
  dias_de_cobro,
  dias_mes,
  dias,
} = {}) => {
  const hint = String(tipo_frecuencia || periodicidad || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const rawMes = dias_mes != null && dias_mes !== '' ? dias_mes : null;
  const rawDias = dias_cobro ?? dias_de_cobro ?? dias ?? null;

  if (hint === TIPO_DIAS_MES || hint === 'MENSUAL' || hint === 'QUINCENAL') {
    const dm = ordenarDiasMes(parseDiasMesRaw(rawMes != null ? rawMes : rawDias));
    const diasMes = dm.length ? dm : [15, 30];
    return {
      tipo: TIPO_DIAS_MES,
      diasSemana: [],
      diasMes,
      diasParaAgenda: diasMes,
      periodicidad: TIPO_DIAS_MES,
    };
  }

  if (rawMes != null && String(rawMes).trim() !== '') {
    const dm = parseDiasMesRaw(rawMes);
    if (dm.length) {
      return {
        tipo: TIPO_DIAS_MES,
        diasSemana: [],
        diasMes: dm,
        diasParaAgenda: dm,
        periodicidad: TIPO_DIAS_MES,
      };
    }
  }

  if (typeof rawDias === 'string' && parecePatronMes(rawDias)) {
    const dm = parseDiasMesRaw(rawDias);
    if (dm.length) {
      return {
        tipo: TIPO_DIAS_MES,
        diasSemana: [],
        diasMes: dm,
        diasParaAgenda: dm,
        periodicidad: TIPO_DIAS_MES,
      };
    }
  }

  if (Array.isArray(rawDias) && esListaDiasMes(rawDias)) {
    const dm = ordenarDiasMes(rawDias);
    return {
      tipo: TIPO_DIAS_MES,
      diasSemana: [],
      diasMes: dm,
      diasParaAgenda: dm,
      periodicidad: TIPO_DIAS_MES,
    };
  }

  if (typeof rawDias === 'string') {
    try {
      const parsed = JSON.parse(rawDias);
      if (esListaDiasMes(parsed)) {
        const dm = ordenarDiasMes(parsed);
        return {
          tipo: TIPO_DIAS_MES,
          diasSemana: [],
          diasMes: dm,
          diasParaAgenda: dm,
          periodicidad: TIPO_DIAS_MES,
        };
      }
    } catch {
      /* ignore */
    }
  }

  const diasSemana = parseDiasCobroSemanal(rawDias);
  return {
    tipo: TIPO_SEMANAL,
    diasSemana,
    diasMes: [],
    diasParaAgenda: diasSemana,
    periodicidad: TIPO_SEMANAL,
  };
};

const fechaDiaDelMes = (year, monthIndex0, diaMes) => {
  const last = new Date(year, monthIndex0 + 1, 0).getDate();
  const day = Math.min(Math.max(1, Number(diaMes) || 1), last);
  const d = new Date(year, monthIndex0, day, 12, 0, 0);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
};

module.exports = {
  TIPO_SEMANAL,
  TIPO_DIAS_MES,
  FRECUENCIA_DEFAULT,
  esDiaMesNumero,
  esListaDiasMes,
  parseDiasMesRaw,
  resolverFrecuenciaCobro,
  fechaDiaDelMes,
  ordenarDiasMes,
};
