/**
 * Mora por crédito vencido SIN prórrogas (misma regla que app-financiera).
 */
const { toFechaISO, hoyISO } = require('./zonaHoraria');

const SEMANAS_POR_MES = 4;

function prestamoSinProrrogas(prestamo, opts = {}) {
  if (opts.sinProrroga === true) return true;
  if (opts.sinProrroga === false) return false;
  if (opts.prorrogasCount != null) return Number(opts.prorrogasCount) === 0;
  if (prestamo?.prorrogas_count != null) return Number(prestamo.prorrogas_count) === 0;
  if (prestamo?.semanas_prorroga_total != null && Number(prestamo.semanas_prorroga_total) > 0) {
    return false;
  }
  if (Array.isArray(prestamo?.historial_prorrogas)) {
    return prestamo.historial_prorrogas.length === 0;
  }
  return false;
}

function diasEntre(desdeISO, hastaISO) {
  const a = new Date(`${desdeISO}T12:00:00`);
  const b = new Date(`${hastaISO}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function calcularInteresMoraVencido(prestamo, refDate = new Date(), opts = {}) {
  const { prestamoEstaVencido, fechaVencimientoCredito } = require('./finanzasNube');
  const vencido =
    opts.vencido != null ? !!opts.vencido : prestamoEstaVencido(prestamo, refDate);
  const sinProrroga = prestamoSinProrrogas(prestamo, opts);

  if (!vencido || !sinProrroga) {
    return {
      aplica: false,
      montoMora: 0,
      semanasVencidas: 0,
      diasVencido: 0,
      tasaSemanal: 0,
      tasaMensual: 0,
      saldoBase: Number(prestamo?.saldo_pendiente) || 0,
      saldoConMora: Number(prestamo?.saldo_pendiente) || 0,
      mensaje: null,
    };
  }

  const venc =
    opts.fechaVencimiento ||
    fechaVencimientoCredito(
      prestamo?.fecha_desembolso,
      prestamo?.plazo_semanas,
      prestamo?.dias_de_cobro,
      {
        periodicidad: prestamo?.periodicidad,
        tipo_frecuencia: prestamo?.tipo_frecuencia || prestamo?.periodicidad,
      }
    );
  const hoy = toFechaISO(refDate) || hoyISO();
  const diasVencido = venc ? diasEntre(String(venc).slice(0, 10), hoy) : 0;
  const semanasVencidas = Math.max(1, Math.ceil(Math.max(diasVencido, 1) / 7));

  const plazo = Math.max(1, Number(prestamo?.plazo_semanas) || 1);
  const tasaGlobal = Number(prestamo?.tasa_interes_aplicada) || 0;
  const tasaMensual = tasaGlobal / (plazo / SEMANAS_POR_MES);
  const tasaSemanal = tasaMensual / SEMANAS_POR_MES;
  const saldoBase = Number(prestamo?.saldo_pendiente) || 0;
  const montoMora = Number((saldoBase * tasaSemanal * semanasVencidas).toFixed(2));
  const saldoConMora = Number((saldoBase + montoMora).toFixed(2));

  return {
    aplica: true,
    montoMora,
    semanasVencidas,
    diasVencido,
    tasaSemanal,
    tasaMensual,
    saldoBase,
    saldoConMora,
    fechaVencimiento: venc,
    mensaje: `Mora por vencido sin prórroga: ${semanasVencidas} sem. × ${(tasaSemanal * 100).toFixed(2)}%/sem sobre saldo = C$ ${montoMora.toFixed(2)}`,
  };
}

module.exports = { calcularInteresMoraVencido, prestamoSinProrrogas };
