const {
  montoVisitaHoy,
  normalizarDia,
  debeSugerirCobroEnFecha,
  esCuotaDiaDesembolso,
  fechaCalendarioISO,
} = require('./diasCobro');
const { rangoDiaLocal } = require('./fechasSql');
const { analizarVisitaGps, resumenGpsAgenda, refCoordsCliente } = require('./gpsCumplimiento');
const { etiquetaVisitaDesdePago } = require('./visitaEtiquetas');
const { anotarTiemposVisitas, resumenTiemposRuta } = require('./tiemposVisita');
const { capMontoAlSaldo } = require('./cobroMontos');

const MAPA = ['DOMINGO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];

const diaCobroDeFecha = (fechaISO) => {
  const d = new Date(`${fechaISO}T12:00:00`);
  return MAPA[d.getDay()];
};

const incluyeDiaEnFecha = (fechaISO, diasRaw) => {
  try {
    const dias = typeof diasRaw === 'string' ? JSON.parse(diasRaw) : diasRaw;
    if (!Array.isArray(dias) || !dias.length) return true;
    const dia = normalizarDia(diaCobroDeFecha(fechaISO));
    return dias.some((d) => normalizarDia(d) === dia);
  } catch {
    return true;
  }
};

/** Arma agenda + resumen en memoria (sin SQL). */
function estadoVisitaDesdePago(pg) {
  if (!pg) return null;
  return Number(pg.registrado_por_admin) === 1 ? 'cobrado_admin' : 'cobrado';
}

function esVisitaCobrada(estado) {
  return estado === 'cobrado' || estado === 'cobrado_admin';
}

function armarAgendaDesdeDatos(hoy, clientes, prestamos, cuotas, pagos_hoy, gestiones_hoy, cobradorId = null) {
  const pagosRuta = pagos_hoy;
  const gestionesRuta = cobradorId
    ? gestiones_hoy.filter((g) => g.cobrador_id === cobradorId)
    : gestiones_hoy;

  const agenda = [];
  const pagoPorPrestamo = new Map(pagosRuta.map((pg) => [pg.prestamo_id, pg]));
  const gestionPorPrestamo = new Map(gestionesRuta.map((g) => [g.prestamo_id, g]));
  const prestamosEnAgenda = new Set();
  const prestamoPorId = new Map(prestamos.map((p) => [p.id, p]));

  const prestamoIdsPagos = [
    ...new Set(pagosRuta.map((pg) => pg.prestamo_id).filter((id) => id && !prestamoPorId.has(id))),
  ];

  const pushAgendaItem = (c, p, cuotaPend, extra = {}) => {
    if (!p?.id || prestamosEnAgenda.has(p.id)) return;
    prestamosEnAgenda.add(p.id);
    const pg = pagoPorPrestamo.get(p.id);
    const gest = gestionPorPrestamo.get(p.id);
    const montoDiaRaw = cuotaPend
      ? Math.max(0, Number(cuotaPend.monto_programado) - Number(cuotaPend.monto_pagado || 0))
      : montoVisitaHoy(p.cuota_semanal_base, p.dias_de_cobro);
    const montoDia = capMontoAlSaldo(montoDiaRaw, p.saldo_pendiente);

    const esLiquidacion =
      extra.tipo_visita === 'liquidado' ||
      (!!pg && (p.estado === 'Pagado' || Number(p.saldo_pendiente || 0) <= 0.01));

    const estado_visita =
      extra.estado_visita ??
      (pg
        ? estadoVisitaDesdePago(pg)
        : gestionPorPrestamo.has(p.id)
          ? 'no_pago'
          : 'pendiente');

    let tipo_visita = extra.tipo_visita || 'activo';
    if (esLiquidacion) tipo_visita = 'liquidado';
    else if (pg && esVisitaCobrada(estado_visita)) tipo_visita = 'cobrado';

    const monto_cobrado = pg ? Number(pg.monto_pagado || 0) : null;
    let monto_programado = extra.monto_programado ?? montoDia;
    if (pg && (esLiquidacion || esVisitaCobrada(estado_visita))) {
      monto_programado = monto_cobrado ?? monto_programado;
    }

    let etiqueta_visita = extra.etiqueta_visita ?? null;
    if (!etiqueta_visita && pg) {
      etiqueta_visita = etiquetaVisitaDesdePago(pg, esLiquidacion);
    }

    const ref = refCoordsCliente(c);
    agenda.push({
      prestamo_id: p.id,
      monto_programado,
      monto_cobrado,
      cliente_id: c.id,
      nombre_completo: c.nombre_completo,
      telefono: c.telefono,
      direccion: c.direccion,
      cedula: c.cedula,
      orden_visita: c.orden_visita,
      saldo_pendiente: p.saldo_pendiente,
      tipo_visita,
      estado_visita,
      registrado_por_admin: pg ? Number(pg.registrado_por_admin) === 1 : false,
      pago_hoy_id: extra.pago_hoy_id ?? pg?.id ?? null,
      motivo_no_pago: gest?.motivo ?? null,
      etiqueta_visita,
      fecha_evento: pg?.fecha_pago || gest?.fecha_gestion || null,
      latitud: c.latitud,
      longitud: c.longitud,
      latitud_cobro: c.latitud_cobro,
      longitud_cobro: c.longitud_cobro,
      ref_lat: ref?.lat ?? null,
      ref_lng: ref?.lng ?? null,
      ...analizarVisitaGps(c, {
        pago: pg,
        gestion: gest,
        estadoVisita: estado_visita,
        tipoVisita: tipo_visita,
      }),
    });
  };

  for (const c of clientes) {
    const p = prestamos.find((x) => x.cliente_id === c.id && x.estado === 'Activo');
    if (p && debeSugerirCobroEnFecha(hoy, p)) {
      const cuotaPend = cuotas.find(
        (cc) => cc.prestamo_id === p.id && !esCuotaDiaDesembolso(cc, p)
      );
      pushAgendaItem(c, p, cuotaPend);
    }

    for (const pg of pagosRuta.filter((x) => x.cliente_id === c.id)) {
      if (prestamosEnAgenda.has(pg.prestamo_id)) continue;
      const pr = prestamoPorId.get(pg.prestamo_id);
      if (!pr) continue;
      const esLiquidacion = pr.estado === 'Pagado' || Number(pr.saldo_pendiente || 0) <= 0;
      const ev = estadoVisitaDesdePago(pg);
      pushAgendaItem(c, pr, null, {
        monto_programado: Number(pg.monto_pagado),
        monto_cobrado: Number(pg.monto_pagado),
        tipo_visita: esLiquidacion ? 'liquidado' : 'cobrado',
        etiqueta_visita: etiquetaVisitaDesdePago(pg, esLiquidacion),
        estado_visita: ev,
        pago_hoy_id: pg.id,
      });
    }
  }

  agenda.sort((a, b) => {
    const o = (a.orden_visita ?? 999) - (b.orden_visita ?? 999);
    if (o !== 0) return o;
    return String(a.prestamo_id).localeCompare(String(b.prestamo_id));
  });

  const agendaConTiempos = anotarTiemposVisitas(agenda);
  const tiempos = resumenTiemposRuta(agendaConTiempos);

  const cobrado = agendaConTiempos.filter((v) => esVisitaCobrada(v.estado_visita)).length;
  const liquidado = agendaConTiempos.filter((v) => v.tipo_visita === 'liquidado').length;
  const no_pago = agendaConTiempos.filter((v) => v.estado_visita === 'no_pago').length;
  const pendiente = agendaConTiempos.filter((v) => v.estado_visita === 'pendiente').length;
  const total = agendaConTiempos.length;
  const visitadas = cobrado + no_pago;
  const monto_cobrado = pagosRuta.reduce((s, p) => s + Number(p.monto_pagado || 0), 0);

  return {
    agenda: agendaConTiempos,
    resumen: {
      total_visitas: total,
      cobrado,
      liquidado,
      no_pago,
      pendiente,
      visitadas,
      porcentaje: total ? Math.round((visitadas / total) * 100) : 0,
      monto_cobrado,
      gps: resumenGpsAgenda(agendaConTiempos),
      tiempos,
    },
    pagos_hoy: pagosRuta,
    gestiones_hoy: gestionesRuta,
    prestamoIdsPagos,
    prestamoPorId,
  };
}

async function cargarDatosCobrador(query, cobradorId, fechaISO) {
  const hoy = fechaISO || fechaCalendarioISO();

  const clientes = await query(
    `SELECT DISTINCT c.*, rc.ruta_id, rc.orden_visita
     FROM Clientes c
     INNER JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
     INNER JOIN Rutas r ON rc.ruta_id = r.id AND r.cobrador_id = ? AND r.activa = 1
     WHERE c.deleted_at IS NULL AND c.cobrador_id = ?
     ORDER BY rc.orden_visita ASC, c.id`,
    [cobradorId, cobradorId]
  );

  const clienteIds = clientes.map((c) => c.id);
  let prestamos = [];
  let cuotas = [];
  let pagos_hoy = [];
  let gestiones_hoy = [];

  if (clienteIds.length) {
    const ph2 = clienteIds.map(() => '?').join(',');
    const activosRows = await query(
      `SELECT * FROM Prestamos WHERE cliente_id IN (${ph2}) AND estado = 'Activo' AND deleted_at IS NULL
       ORDER BY fecha_desembolso DESC`,
      clienteIds
    );
    const activoPorCliente = new Map();
    for (const p of activosRows) {
      if (!activoPorCliente.has(p.cliente_id)) activoPorCliente.set(p.cliente_id, p);
    }
    prestamos = [...activoPorCliente.values()];
    const prestamoIds = prestamos.map((p) => p.id);
    if (prestamoIds.length) {
      const ph3 = prestamoIds.map(() => '?').join(',');
      cuotas = await query(
        `SELECT id, prestamo_id, fecha_programada, monto_programado, monto_pagado,
                estado, updated_at, deleted_at
         FROM Cuotas_Calendario
         WHERE prestamo_id IN (${ph3}) AND estado IN ('Programada','Parcial')
           AND fecha_programada <= ? AND deleted_at IS NULL
         ORDER BY fecha_programada`,
        [...prestamoIds, hoy]
      );
    }
    const { inicio: diaIni, fin: diaFin } = rangoDiaLocal(hoy);
    pagos_hoy = await query(
      `SELECT pg.*, p.cliente_id
       FROM Pagos pg
       INNER JOIN Prestamos p ON pg.prestamo_id = p.id
       WHERE pg.fecha_pago >= ? AND pg.fecha_pago < ? AND pg.deleted_at IS NULL
         AND p.cliente_id IN (${ph2})`,
      [diaIni, diaFin, ...clienteIds]
    );
    gestiones_hoy = await query(
      `SELECT g.*, p.cliente_id
       FROM Gestiones_No_Pago g
       INNER JOIN Prestamos p ON g.prestamo_id = p.id
       WHERE g.fecha_gestion >= ? AND g.fecha_gestion < ? AND g.deleted_at IS NULL
         AND p.cliente_id IN (${ph2})`,
      [diaIni, diaFin, ...clienteIds]
    );

    const prestamoIdsPagos = [
      ...new Set(pagos_hoy.map((pg) => pg.prestamo_id).filter((id) => id && !prestamos.some((p) => p.id === id))),
    ];
    if (prestamoIdsPagos.length) {
      const phP = prestamoIdsPagos.map(() => '?').join(',');
      const extraPrestamos = await query(
        `SELECT * FROM Prestamos WHERE id IN (${phP}) AND deleted_at IS NULL`,
        prestamoIdsPagos
      );
      prestamos = [...prestamos, ...extraPrestamos];
    }
  }

  return { hoy, clientes, prestamos, cuotas, pagos_hoy, gestiones_hoy };
}

/**
 * Carga datos de todos los cobradores en pocas consultas (cumplimiento admin).
 */
async function cargarDatosTodosCobradores(query, cobradorIds, fechaISO) {
  const hoy = fechaISO || fechaCalendarioISO();
  if (!cobradorIds.length) {
    return { hoy, clientes: [], prestamos: [], cuotas: [], pagos_hoy: [], gestiones_hoy: [], cierres: [] };
  }

  const ph = cobradorIds.map(() => '?').join(',');

  const clientes = await query(
    `SELECT DISTINCT c.*, rc.orden_visita, r.cobrador_id AS ruta_cobrador_id
     FROM Clientes c
     INNER JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
     INNER JOIN Rutas r ON rc.ruta_id = r.id AND r.cobrador_id IN (${ph}) AND r.activa = 1
     WHERE c.deleted_at IS NULL AND c.cobrador_id IN (${ph})
     ORDER BY r.cobrador_id, rc.orden_visita ASC, c.id`,
    [...cobradorIds, ...cobradorIds]
  );

  const clienteIds = [...new Set(clientes.map((c) => c.id))];
  let prestamos = [];
  let cuotas = [];
  let pagos_hoy = [];
  let gestiones_hoy = [];

  if (clienteIds.length) {
    const ph2 = clienteIds.map(() => '?').join(',');
    const activosRows = await query(
      `SELECT * FROM Prestamos WHERE cliente_id IN (${ph2}) AND estado = 'Activo' AND deleted_at IS NULL`,
      clienteIds
    );
    const activoPorCliente = new Map();
    for (const p of activosRows) {
      if (!activoPorCliente.has(p.cliente_id)) activoPorCliente.set(p.cliente_id, p);
    }
    prestamos = [...activoPorCliente.values()];

    const prestamoIds = prestamos.map((p) => p.id);
    if (prestamoIds.length) {
      const ph3 = prestamoIds.map(() => '?').join(',');
      cuotas = await query(
        `SELECT id, prestamo_id, fecha_programada, monto_programado, monto_pagado, estado
         FROM Cuotas_Calendario
         WHERE prestamo_id IN (${ph3}) AND estado IN ('Programada','Parcial')
           AND fecha_programada <= ? AND deleted_at IS NULL`,
        [...prestamoIds, hoy]
      );
    }

    const { inicio: diaIni, fin: diaFin } = rangoDiaLocal(hoy);
    pagos_hoy = await query(
      `SELECT pg.*, p.cliente_id
       FROM Pagos pg
       INNER JOIN Prestamos p ON pg.prestamo_id = p.id
       WHERE pg.fecha_pago >= ? AND pg.fecha_pago < ? AND pg.deleted_at IS NULL
         AND p.cliente_id IN (${ph2})`,
      [diaIni, diaFin, ...clienteIds]
    );
    gestiones_hoy = await query(
      `SELECT g.*, p.cliente_id
       FROM Gestiones_No_Pago g
       INNER JOIN Prestamos p ON g.prestamo_id = p.id
       WHERE g.fecha_gestion >= ? AND g.fecha_gestion < ? AND g.deleted_at IS NULL
         AND p.cliente_id IN (${ph2})`,
      [diaIni, diaFin, ...clienteIds]
    );

    const prestamoPorId = new Map(prestamos.map((p) => [p.id, p]));
    const extraIds = [
      ...new Set(pagos_hoy.map((pg) => pg.prestamo_id).filter((id) => id && !prestamoPorId.has(id))),
    ];
    if (extraIds.length) {
      const phE = extraIds.map(() => '?').join(',');
      const extra = await query(`SELECT * FROM Prestamos WHERE id IN (${phE}) AND deleted_at IS NULL`, extraIds);
      prestamos = [...prestamos, ...extra];
    }
  }

  const cierres = await query(
    `SELECT cobrador_id, id, monto_efectivo, transacciones
     FROM Cierre_Caja
     WHERE cobrador_id IN (${ph}) AND DATE(fecha_cierre) = DATE(?) AND deleted_at IS NULL`,
    [...cobradorIds, hoy]
  );

  return { hoy, clientes, prestamos, cuotas, pagos_hoy, gestiones_hoy, cierres };
}

async function buildAgendaCobrador(query, cobradorId, fechaISO) {
  const datos = await cargarDatosCobrador(query, cobradorId, fechaISO);
  const armado = armarAgendaDesdeDatos(
    datos.hoy,
    datos.clientes,
    datos.prestamos,
    datos.cuotas,
    datos.pagos_hoy,
    datos.gestiones_hoy,
    cobradorId
  );
  return {
    dia_cobro: diaCobroDeFecha(datos.hoy),
    fecha: datos.hoy,
    agenda: armado.agenda,
    resumen: armado.resumen,
    pagos_hoy: armado.pagos_hoy,
    gestiones_hoy: armado.gestiones_hoy,
  };
}

/**
 * Cumplimiento de todos los cobradores: ~6 consultas SQL en total (no N×8).
 */
async function buildCumplimientoBatch(query, cobradores, fechaISO, { incluirVisitas = false } = {}) {
  const cobIds = cobradores.map((c) => c.id);
  const datos = await cargarDatosTodosCobradores(query, cobIds, fechaISO);
  const cierreMap = new Map(
    datos.cierres.map((c) => [
      c.cobrador_id,
      {
        id: c.id,
        monto_efectivo: Number(c.monto_efectivo),
        transacciones: Number(c.transacciones),
      },
    ])
  );

  const filas = [];
  for (const cob of cobradores) {
    const clientesCob = datos.clientes.filter((c) => c.ruta_cobrador_id === cob.id);
    const clienteIds = new Set(clientesCob.map((c) => c.id));
    const prestamosCob = datos.prestamos.filter((p) => clienteIds.has(p.cliente_id));
    const pagosCob = datos.pagos_hoy.filter((pg) => clienteIds.has(pg.cliente_id));
    const gestCob = datos.gestiones_hoy.filter((g) => clienteIds.has(g.cliente_id));

    const armado = armarAgendaDesdeDatos(
      datos.hoy,
      clientesCob,
      prestamosCob,
      datos.cuotas,
      pagosCob,
      gestCob,
      cob.id
    );

    filas.push({
      cobrador_id: cob.id,
      cobrador: cob.nombre_completo,
      ...armado.resumen,
      cierre_caja: cierreMap.get(cob.id) || null,
      visitas: incluirVisitas ? armado.agenda : [],
    });
  }

  filas.sort((a, b) => b.porcentaje - a.porcentaje || String(a.cobrador).localeCompare(String(b.cobrador)));
  return { fecha: datos.hoy, dia_cobro: diaCobroDeFecha(datos.hoy), cobradores: filas };
}

function resumirAgenda(agenda, pagos_hoy = []) {
  const cobrado = agenda.filter((v) => esVisitaCobrada(v.estado_visita)).length;
  const liquidado = agenda.filter((v) => v.tipo_visita === 'liquidado').length;
  const no_pago = agenda.filter((v) => v.estado_visita === 'no_pago').length;
  const pendiente = agenda.filter((v) => v.estado_visita === 'pendiente').length;
  const total = agenda.length;
  const visitadas = cobrado + no_pago;
  const monto_cobrado = pagos_hoy.reduce((s, p) => s + Number(p.monto_pagado || 0), 0);
  return {
    total_visitas: total,
    cobrado,
    liquidado,
    no_pago,
    pendiente,
    visitadas,
    porcentaje: total ? Math.round((visitadas / total) * 100) : 0,
    monto_cobrado,
  };
}

module.exports = {
  buildAgendaCobrador,
  buildCumplimientoBatch,
  resumirAgenda,
  diaCobroDeFecha,
  incluyeDiaEnFecha,
};
