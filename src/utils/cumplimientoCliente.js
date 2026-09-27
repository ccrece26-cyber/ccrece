/**
 * Cumplimiento del cliente a partir de Prestamos + Pagos (sin tablas nuevas).
 * Agenda estimada cuando no hay Cuotas_Calendario.
 */
const {
  generarAgendaDeCobro,
  calcularCuotaYDistribucion,
  fechaVencimientoCredito,
} = require('./finanzasNube');
const { hoyISO, toFechaISO } = require('./zonaHoraria');
const { resolverFrecuenciaCobro } = require('./frecuenciaCobro');

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const fechaISO = (v) => toFechaISO(v) || String(v || '').slice(0, 10) || null;

function situacionPrestamoActivo(prestamo, pagosActivo) {
  if (!prestamo) {
    return {
      tiene_activo: false,
      mensaje: 'Sin crédito activo',
    };
  }

  const hoy = hoyISO();
  const desembolso = fechaISO(prestamo.fecha_desembolso);
  const plazo = Math.max(1, num(prestamo.plazo_semanas, 1));
  const saldo = num(prestamo.saldo_pendiente);
  const cuotaSem = num(prestamo.cuota_semanal_base);
  const totalContrato = num(prestamo.monto_total_pagar);
  const freq = resolverFrecuenciaCobro({
    tipo_frecuencia: prestamo.tipo_frecuencia || prestamo.periodicidad,
    dias_de_cobro: prestamo.dias_de_cobro,
    dias_mes: prestamo.dias_mes,
  });
  const diasAgenda = freq.diasParaAgenda;
  const nDias = Math.max(1, diasAgenda.length || 1);
  const cuotaVisita =
    cuotaSem > 0
      ? Number((cuotaSem / nDias).toFixed(2))
      : Number((totalContrato / Math.max(1, plazo * nDias)).toFixed(2));

  const vencimiento = fechaVencimientoCredito(desembolso, plazo, diasAgenda, {
    tipo_frecuencia: freq.tipo,
    dias_mes: freq.diasMes,
    periodicidad: freq.periodicidad,
  });
  const vencidoPlazo = !!(vencimiento && hoy > vencimiento && saldo > 0.01);

  let agenda = [];
  try {
    agenda = generarAgendaDeCobro(desembolso, plazo, diasAgenda, cuotaVisita, {
      tipo_frecuencia: freq.tipo,
      dias_mes: freq.diasMes,
    });
  } catch {
    agenda = [];
  }

  const totalPagado = pagosActivo.reduce((s, p) => s + num(p.monto_pagado), 0);
  let acumProg = 0;
  const visitas = agenda.map((v, i) => {
    const monto = num(v.monto_programado, cuotaVisita);
    acumProg = Number((acumProg + monto).toFixed(2));
    const fecha = fechaISO(v.fecha_programada);
    let estado = 'futura';
    if (fecha && fecha < hoy) {
      estado = totalPagado + 0.5 >= acumProg ? 'cubierta' : 'atrasada';
    } else if (fecha === hoy) {
      estado = totalPagado + 0.5 >= acumProg ? 'cubierta' : 'hoy';
    }
    return {
      n: i + 1,
      fecha,
      dia: v.dia || null,
      monto,
      estado,
      acumulado_programado: acumProg,
    };
  });

  const atrasadas = visitas.filter((v) => v.estado === 'atrasada');
  const hoyVisitas = visitas.filter((v) => v.estado === 'hoy');
  const proximas = visitas.filter((v) => v.estado === 'futura');
  const visitasRestantesEst =
    cuotaVisita > 0.009 ? Math.ceil(saldo / cuotaVisita) : null;

  let estado_etiqueta = 'Al día';
  let estado_nivel = 'ok';
  if (vencidoPlazo) {
    estado_etiqueta = 'Vencido (plazo)';
    estado_nivel = 'danger';
  } else if (atrasadas.length > 0) {
    estado_etiqueta = `${atrasadas.length} visita(s) atrasada(s)`;
    estado_nivel = 'warn';
  } else if (hoyVisitas.length > 0) {
    estado_etiqueta = 'Toca cobrar hoy';
    estado_nivel = 'info';
  }

  return {
    tiene_activo: true,
    prestamo_id: prestamo.id,
    saldo_pendiente: saldo,
    cuota_semanal: cuotaSem,
    cuota_visita: cuotaVisita,
    dias_cobro: diasAgenda,
    tipo_frecuencia: freq.tipo,
    fecha_desembolso: desembolso,
    vencimiento,
    vencido_plazo: vencidoPlazo,
    total_pagado_activo: Number(totalPagado.toFixed(2)),
    visitas_atrasadas: atrasadas,
    visitas_hoy: hoyVisitas,
    visitas_proximas: proximas,
    visitas_restantes_est: visitasRestantesEst,
    estado_etiqueta,
    estado_nivel,
    estimado: true,
    nota:
      'Visitas estimadas según días de cobro y abonos reales. No hay calendario fijo guardado.',
  };
}

function resumenHistorial(prestamos, pagosPorPrestamo) {
  const creditos = prestamos.length;
  const pagados = prestamos.filter((p) => String(p.estado).toLowerCase() === 'pagado').length;
  const activos = prestamos.filter((p) => String(p.estado).toLowerCase() === 'activo').length;
  let totalAbonado = 0;
  let numAbonos = 0;
  const detalle = prestamos.map((p) => {
    const pagos = pagosPorPrestamo.get(p.id) || [];
    const abonado = pagos.reduce((s, x) => s + num(x.monto_pagado), 0);
    totalAbonado += abonado;
    numAbonos += pagos.length;
    return {
      id: p.id,
      estado: p.estado,
      monto_desembolsado: num(p.monto_desembolsado),
      monto_total_pagar: num(p.monto_total_pagar),
      saldo_pendiente: num(p.saldo_pendiente),
      cuota_semanal_base: num(p.cuota_semanal_base),
      plazo_semanas: num(p.plazo_semanas),
      fecha_desembolso: fechaISO(p.fecha_desembolso),
      numero_recibo_fisico: p.numero_recibo_fisico || null,
      renovacion_previa_id: p.renovacion_previa_id || null,
      total_abonado: Number(abonado.toFixed(2)),
      num_abonos: pagos.length,
      pagos: pagos.map((pg) => ({
        id: pg.id,
        fecha: fechaISO(pg.fecha_pago),
        monto: num(pg.monto_pagado),
        tipo_cobro: pg.tipo_cobro || null,
        cobrador_nombre: pg.cobrador_nombre || null,
      })),
    };
  });

  // Señal simple de cumplimiento (solo lectura)
  let cumplimiento_etiqueta = 'Sin historial';
  let cumplimiento_nivel = 'muted';
  if (creditos > 0) {
    const ratioPagados = pagados / creditos;
    const avgAbonos = numAbonos / creditos;
    if (ratioPagados >= 0.6 && avgAbonos >= 4) {
      cumplimiento_etiqueta = 'Buen cumplimiento';
      cumplimiento_nivel = 'ok';
    } else if (activos && pagados === 0 && numAbonos < 3) {
      cumplimiento_etiqueta = 'Historial corto';
      cumplimiento_nivel = 'info';
    } else if (ratioPagados >= 0.3) {
      cumplimiento_etiqueta = 'Cumplimiento regular';
      cumplimiento_nivel = 'warn';
    } else {
      cumplimiento_etiqueta = 'Revisar historial';
      cumplimiento_nivel = 'warn';
    }
  }

  return {
    creditos_totales: creditos,
    creditos_pagados: pagados,
    creditos_activos: activos,
    total_abonado_historico: Number(totalAbonado.toFixed(2)),
    num_abonos: numAbonos,
    cumplimiento_etiqueta,
    cumplimiento_nivel,
    creditos: detalle,
  };
}

/**
 * @param {Function} query - db query
 * @param {string} clienteId
 */
async function cargarCumplimientoCliente(query, clienteId) {
  const clientes = await query(
    `SELECT c.*, uc.nombre_completo AS cobrador_nombre
     FROM Clientes c
     LEFT JOIN Usuarios uc ON c.cobrador_id = uc.id
     WHERE c.id = ? AND c.deleted_at IS NULL
     LIMIT 1`,
    [clienteId]
  );
  if (!clientes.length) return null;

  const cliente = clientes[0];
  const prestamos = await query(
    `SELECT p.*, ur.nombre_completo AS registrado_por, ue.nombre_completo AS entregado_por
     FROM Prestamos p
     LEFT JOIN Usuarios ur ON p.cobrador_registro_id = ur.id
     LEFT JOIN Usuarios ue ON p.cobrador_entrega_id = ue.id
     WHERE p.cliente_id = ? AND p.deleted_at IS NULL
     ORDER BY p.fecha_desembolso DESC`,
    [clienteId]
  );

  const prestamoActivo = prestamos.find((p) => p.estado === 'Activo') || null;
  const ids = prestamos.map((p) => p.id);
  let pagos = [];
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    pagos = await query(
      `SELECT pg.id, pg.prestamo_id, pg.monto_pagado, pg.fecha_pago, pg.tipo_cobro,
              pg.registrado_por_admin, u.nombre_completo AS cobrador_nombre
       FROM Pagos pg
       LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
       WHERE pg.prestamo_id IN (${ph}) AND pg.deleted_at IS NULL
       ORDER BY pg.fecha_pago ASC`,
      ids
    );
  }

  const pagosPorPrestamo = new Map();
  for (const pg of pagos) {
    if (!pagosPorPrestamo.has(pg.prestamo_id)) pagosPorPrestamo.set(pg.prestamo_id, []);
    pagosPorPrestamo.get(pg.prestamo_id).push(pg);
  }

  const pagosActivo = prestamoActivo ? pagosPorPrestamo.get(prestamoActivo.id) || [] : [];

  // Cuotas_Calendario solo si existen (raro en modelo flexible)
  let cuotas = [];
  if (prestamoActivo) {
    cuotas = await query(
      `SELECT cc.id AS cuota_id, cc.fecha_programada, cc.monto_programado, cc.monto_pagado,
              cc.estado AS estado_cuota
       FROM Cuotas_Calendario cc
       WHERE cc.prestamo_id = ? AND cc.deleted_at IS NULL
       ORDER BY cc.fecha_programada ASC`,
      [prestamoActivo.id]
    );
  }

  return {
    cliente: { ...cliente, codigo_cliente: cliente.id },
    prestamo_activo: prestamoActivo,
    prestamos,
    pagos,
    cuotas,
    situacion: situacionPrestamoActivo(prestamoActivo, pagosActivo),
    historial: resumenHistorial(prestamos, pagosPorPrestamo),
    resumen: {
      saldo_pendiente: prestamoActivo ? num(prestamoActivo.saldo_pendiente) : 0,
      total_abonado_activo: Number(pagosActivo.reduce((s, p) => s + num(p.monto_pagado), 0).toFixed(2)),
      total_abonado_historico: Number(
        pagos.reduce((s, p) => s + num(p.monto_pagado), 0).toFixed(2)
      ),
      estado_prestamo: prestamoActivo?.estado || 'Sin préstamo',
      cuotas_calendario: cuotas.length,
    },
  };
}

module.exports = {
  cargarCumplimientoCliente,
  situacionPrestamoActivo,
  resumenHistorial,
};
