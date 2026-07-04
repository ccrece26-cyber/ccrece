/** Misma lógica que app-financiera/src/utils/finanzas.js (motor nube / carga masiva) */

const { toFechaISO } = require('./zonaHoraria');

const SEMANAS_POR_MES = 4;
const TASA_MENSUAL_DEFAULT = 0.1;

const DIAS_SEMANA = {
  DOMINGO: 0,
  LUNES: 1,
  MARTES: 2,
  MIERCOLES: 3,
  JUEVES: 4,
  VIERNES: 5,
  SABADO: 6,
};

const calcularMesesFinancieros = (plazoSemanas) => Number(plazoSemanas) / SEMANAS_POR_MES;

const parseTasaMensualInput = (valor) => {
  const n = parseFloat(String(valor).replace('%', '').trim());
  if (Number.isNaN(n) || n < 0) return TASA_MENSUAL_DEFAULT;
  return n > 1 ? n / 100 : n;
};

const calcularTasaInteresVariableLineal = (plazoSemanas, tasaMensual = TASA_MENSUAL_DEFAULT) => {
  const meses = calcularMesesFinancieros(plazoSemanas);
  return Number((tasaMensual * meses).toFixed(4));
};

const calcularCuotaYDistribucion = (
  montoDesembolso,
  plazoSemanas,
  diasDeCobro = ['LUNES'],
  tasaMensual = TASA_MENSUAL_DEFAULT
) => {
  const tasaInteresAplicada = calcularTasaInteresVariableLineal(plazoSemanas, tasaMensual);
  const interesTotal = Number((montoDesembolso * tasaInteresAplicada).toFixed(2));
  const montoTotalPagar = Number((montoDesembolso + interesTotal).toFixed(2));
  const cuotaSemanalBase = Number((montoTotalPagar / plazoSemanas).toFixed(2));
  const frecuenciaSemanal = diasDeCobro.length || 1;
  const cuotaPorDiaDeCobro = Number((cuotaSemanalBase / frecuenciaSemanal).toFixed(2));
  return {
    montoDesembolso,
    plazoSemanas,
    tasaMensual,
    tasaInteresAplicada,
    interesTotal,
    montoTotalPagar,
    cuotaSemanalBase,
    cuotaPorDiaDeCobro,
    frecuenciaSemanal,
    diasDeCobro,
  };
};

const diaSemanaIndice = (nombreDia) => {
  const key = String(nombreDia).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return DIAS_SEMANA[key] ?? DIAS_SEMANA.LUNES;
};

const generarAgendaDeCobro = (fechaInicioISO, plazoSemanas, diasDeCobro = ['LUNES'], cuotaPorDia = 0) => {
  const agenda = [];
  const inicioStr = String(fechaInicioISO || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!inicioStr) return agenda;

  const inicio = new Date(`${inicioStr}T12:00:00`);
  if (Number.isNaN(inicio.getTime())) return agenda;

  const plazo = Math.min(Math.max(1, Number(plazoSemanas) || 1), 520);
  const dias = (Array.isArray(diasDeCobro) ? diasDeCobro : ['LUNES']).filter(Boolean);
  if (!dias.length) dias.push('LUNES');

  for (let semana = 0; semana < plazo; semana += 1) {
    for (const nombreDia of dias) {
      const targetDay = diaSemanaIndice(nombreDia);
      const fecha = new Date(inicio.getTime());
      fecha.setDate(inicio.getDate() + semana * 7);
      const delta = (targetDay - fecha.getDay() + 7) % 7;
      fecha.setDate(fecha.getDate() + delta);
      if (Number.isNaN(fecha.getTime())) continue;
      const y = fecha.getFullYear();
      const m = String(fecha.getMonth() + 1).padStart(2, '0');
      const day = String(fecha.getDate()).padStart(2, '0');
      const fechaISO = `${y}-${m}-${day}`;
      if (fechaISO === inicioStr) continue;
      agenda.push({
        fecha_programada: fechaISO,
        monto_programado: cuotaPorDia,
        estado: 'Programada',
        dia: String(nombreDia).toUpperCase(),
      });
    }
  }

  return agenda.sort((a, b) => a.fecha_programada.localeCompare(b.fecha_programada));
};

/** Ajusta la agenda para que suma(monto_programado) === montoTotalPagar (redondeo / visitas de más). */
function ajustarAgendaAlMontoTotal(agenda, montoTotalPagar) {
  if (!Array.isArray(agenda) || !agenda.length) return agenda;
  const total = Number(montoTotalPagar || 0);
  if (total <= 0) return agenda;

  let sum = Number(
    agenda.reduce((s, c) => s + Number(c.monto_programado || 0), 0).toFixed(2)
  );

  while (agenda.length > 1 && sum > total + 0.01) {
    const last = agenda[agenda.length - 1];
    sum = Number((sum - Number(last.monto_programado || 0)).toFixed(2));
    agenda.pop();
  }

  if (agenda.length && sum > total + 0.01) {
    const last = agenda[agenda.length - 1];
    const excess = Number((sum - total).toFixed(2));
    last.monto_programado = Number((Number(last.monto_programado) - excess).toFixed(2));
    sum = total;
  }

  if (agenda.length && sum < total - 0.01) {
    const last = agenda[agenda.length - 1];
    const diff = Number((total - sum).toFixed(2));
    last.monto_programado = Number((Number(last.monto_programado) + diff).toFixed(2));
  }

  return agenda;
}

const numSeguro = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const normalizarFechaDesembolso = (valor) => {
  if (valor == null || valor === '') return null;
  const s = String(valor).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s.includes('T') ? s : `${s}T12:00:00`);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
};

const semanasTranscurridas = (fechaDesembolsoISO, plazoSemanas, refDate = new Date()) => {
  const dia = normalizarFechaDesembolso(fechaDesembolsoISO);
  const inicio = dia ? new Date(`${dia}T12:00:00`) : new Date(NaN);
  if (Number.isNaN(inicio.getTime())) return 1;
  const plazo = Math.max(1, numSeguro(plazoSemanas, 1));
  const diffMs = refDate - inicio;
  const dias = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  const sem = Math.max(1, Math.ceil(dias / 7));
  return Math.min(plazo, sem);
};

const parseDiasCobro = (valor) => {
  if (!valor) return ['LUNES'];
  try {
    const raw = typeof valor === 'string' ? JSON.parse(valor) : valor;
    if (!Array.isArray(raw) || !raw.length) return ['LUNES'];
    return raw.map((d) => String(d).toUpperCase());
  } catch {
    return ['LUNES'];
  }
};

const fechaVencimientoCredito = (fechaDesembolso, plazoSemanas, diasDeCobro) => {
  const inicio = normalizarFechaDesembolso(fechaDesembolso);
  if (!inicio) return null;
  const agenda = generarAgendaDeCobro(inicio, plazoSemanas, parseDiasCobro(diasDeCobro), 0);
  if (!agenda.length) return inicio;
  return agenda[agenda.length - 1].fecha_programada;
};

const prestamoEstaVencido = (prestamo, refDate = new Date()) => {
  const vencimiento = fechaVencimientoCredito(
    prestamo?.fecha_desembolso,
    prestamo?.plazo_semanas,
    prestamo?.dias_de_cobro
  );
  if (!vencimiento) return false;
  return toFechaISO(refDate) >= vencimiento;
};

const calcularLiquidacionAnticipada = (prestamo, refDate = new Date(), opts = {}) => {
  const capital = numSeguro(prestamo.monto_desembolsado);
  const plazo = Math.max(1, numSeguro(prestamo.plazo_semanas, 1));
  const tasaGlobal = numSeguro(prestamo.tasa_interes_aplicada);
  const saldo = numSeguro(prestamo.saldo_pendiente);
  const totalOriginal = numSeguro(prestamo.monto_total_pagar, capital);
  const pagadoAcumulado =
    opts.pagadoAcumulado != null
      ? numSeguro(opts.pagadoAcumulado)
      : Number((totalOriginal - saldo).toFixed(2));
  const saldoContrato = Math.max(0, Number((totalOriginal - pagadoAcumulado).toFixed(2)));
  const tasaMensual = tasaGlobal / (plazo / SEMANAS_POR_MES);
  const interesOriginal = Number((capital * tasaGlobal).toFixed(2));
  const vencimiento = fechaVencimientoCredito(
    prestamo.fecha_desembolso,
    plazo,
    parseDiasCobro(prestamo.dias_de_cobro)
  );
  const vencido = prestamoEstaVencido(prestamo, refDate);

  if (vencido) {
    let montoLiquidacion = saldoContrato;
    if (!Number.isFinite(montoLiquidacion) || montoLiquidacion <= 0) {
      montoLiquidacion = Math.max(0, saldo);
    }
    return {
      capital,
      plazoSemanas: plazo,
      semanasUsadas: plazo,
      montoLiquidacion,
      descuentoInteres: 0,
      saldoActual: saldo,
      saldoContrato,
      pagadoAcumulado,
      esAnticipado: false,
      vencido: true,
      fechaVencimiento: vencimiento,
      mensaje: `Crédito vencido (última visita ${vencimiento || '—'}): se cobra saldo con interés completo del contrato.`,
    };
  }

  const semUsadas = semanasTranscurridas(prestamo.fecha_desembolso, plazo, refDate);
  const tasaAjustada = Number((tasaMensual * (semUsadas / SEMANAS_POR_MES)).toFixed(4));
  const interesAjustado = Number((capital * tasaAjustada).toFixed(2));
  const totalAjustado = Number((capital + interesAjustado).toFixed(2));
  let montoLiquidacion = Math.max(0, Number((totalAjustado - pagadoAcumulado).toFixed(2)));
  if (!Number.isFinite(montoLiquidacion) || montoLiquidacion <= 0) {
    montoLiquidacion = Math.max(0, saldoContrato, saldo);
  }
  const descuentoInteres = Math.max(0, Number((saldoContrato - montoLiquidacion).toFixed(2)));
  return {
    capital,
    plazoSemanas: plazo,
    semanasUsadas: semUsadas,
    montoLiquidacion,
    descuentoInteres,
    saldoActual: saldo,
    saldoContrato,
    pagadoAcumulado,
    esAnticipado: true,
    vencido: false,
    fechaVencimiento: vencimiento,
    mensaje:
      descuentoInteres > 0
        ? `Liquidación anticipada: interés por ${semUsadas} semana(s). Ahorro: C$ ${descuentoInteres.toFixed(2)}`
        : `Liquidación anticipada: interés por ${semUsadas} semana(s).`,
  };
};

module.exports = {
  TASA_MENSUAL_DEFAULT,
  SEMANAS_POR_MES,
  parseTasaMensualInput,
  calcularCuotaYDistribucion,
  generarAgendaDeCobro,
  ajustarAgendaAlMontoTotal,
  calcularLiquidacionAnticipada,
  fechaVencimientoCredito,
  prestamoEstaVencido,
};
