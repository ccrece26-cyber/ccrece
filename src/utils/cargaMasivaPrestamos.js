const { v4: uuidv4 } = require('uuid');
const { nombreCompleto } = require('./cliente');
const { normalizarCedula, validarCedula } = require('./cedulaNic');
const { reserveClienteIds, initSecuenciaCliente } = require('./clienteId');
const { insertMany, updateManyById } = require('./bulkSql');
const { aplicarMontoACuotas } = require('./registrarPagoNube');
const { voidarCuotasRestantesAlCerrar } = require('./cobroMontos');
const {
  parseTasaMensualInput,
  calcularCuotaYDistribucion,
  generarAgendaDeCobro,
} = require('./finanzasNube');
const { optimizarOrdenRuta } = require('./rutas');

const DIAS_ALIASES = {
  L: 'LUNES',
  LU: 'LUNES',
  LUN: 'LUNES',
  LUNES: 'LUNES',
  M: 'MARTES',
  MA: 'MARTES',
  MAR: 'MARTES',
  MARTES: 'MARTES',
  X: 'MIERCOLES',
  MI: 'MIERCOLES',
  MIE: 'MIERCOLES',
  MIERCOLES: 'MIERCOLES',
  J: 'JUEVES',
  JU: 'JUEVES',
  JUE: 'JUEVES',
  JUEVES: 'JUEVES',
  V: 'VIERNES',
  VI: 'VIERNES',
  VIE: 'VIERNES',
  VIERNES: 'VIERNES',
  S: 'SABADO',
  SA: 'SABADO',
  SAB: 'SABADO',
  SABADO: 'SABADO',
  D: 'DOMINGO',
  DO: 'DOMINGO',
  DOM: 'DOMINGO',
  DOMINGO: 'DOMINGO',
};

const normKey = (k) =>
  String(k || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

const txt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
};

const parseDiasCobro = (raw) => {
  if (!raw) return ['LUNES'];
  if (Array.isArray(raw)) return raw.map((d) => DIAS_ALIASES[normKey(d).toUpperCase()] || String(d).toUpperCase());
  const partes = String(raw)
    .split(/[,;|/+\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const dias = [];
  for (const p of partes) {
    const k = normKey(p).toUpperCase().replace(/_/g, '');
    const dia = DIAS_ALIASES[k] || DIAS_ALIASES[p.toUpperCase()] || (k.length >= 3 ? k.slice(0, 9) : null);
    if (dia && !dias.includes(dia)) dias.push(dia);
  }
  return dias.length ? dias : ['LUNES'];
};

const excelSerialAISO = (serial) => {
  const n = Math.floor(Number(serial));
  if (!Number.isFinite(n) || n < 25569 || n >= 120000) return null;
  try {
    const d = new Date((n - 25569) * 86400 * 1000);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
};

const parseFechaISO = (v) => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    try {
      return v.toISOString().split('T')[0];
    } catch {
      return null;
    }
  }
  if (typeof v === 'number') {
    const ex = excelSerialAISO(v);
    if (ex) return ex;
  }
  const s = txt(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const soloNum = s.match(/^(\d{4,6})$/);
  if (soloNum) {
    const ex = excelSerialAISO(soloNum[1]);
    if (ex) return ex;
  }
  const d = new Date(s.includes('T') ? s : `${s}T12:00:00`);
  if (!Number.isNaN(d.getTime())) {
    try {
      return d.toISOString().split('T')[0];
    } catch {
      return null;
    }
  }
  return null;
};

function esFilaEjemplo(raw) {
  const email = String(raw?.cobrador_email ?? raw?.email_cobrador ?? '')
    .trim()
    .toLowerCase();
  return email === 'ejemplo@borrar.com';
}

/** Normaliza fila Excel/CSV (objeto clave-valor) */
function normalizarFila(raw, indice) {
  if (esFilaEjemplo(raw)) return { _fila: indice + 1, _omitir: true };
  const src = {};
  for (const [k, v] of Object.entries(raw || {})) {
    src[normKey(k)] = v;
  }

  const cedula = normalizarCedula(txt(src.cedula));
  const cobrador_email = txt(src.cobrador_email || src.email_cobrador);
  const cobrador_id = txt(src.cobrador_id || src.id_cobrador);

  let primer_nombre = txt(src.primer_nombre);
  let primer_apellido = txt(src.primer_apellido);
  const segundo_nombre = txt(src.segundo_nombre);
  const segundo_apellido = txt(src.segundo_apellido);
  let nombre_completo = txt(src.nombre_completo || src.nombre);

  if (!nombre_completo && (primer_nombre || primer_apellido)) {
    nombre_completo = nombreCompleto({
      primer_nombre,
      segundo_nombre,
      primer_apellido,
      segundo_apellido,
    });
  }
  if (nombre_completo && !primer_nombre) {
    const partes = nombre_completo.split(/\s+/);
    primer_nombre = partes[0] || null;
    primer_apellido = partes.length > 1 ? partes[partes.length - 1] : null;
  }

  const monto = num(src.monto_desembolsado ?? src.monto ?? src.capital);
  const plazo = num(src.plazo_semanas ?? src.plazo);
  const tasaMensual = parseTasaMensualInput(src.tasa_mensual ?? src.tasa ?? '10');
  const dias = parseDiasCobro(src.dias_cobro ?? src.dias_de_cobro ?? src.dias);
  const fecha_desembolso = parseFechaISO(src.fecha_desembolso ?? src.fecha_inicio);
  let saldo_pendiente = num(src.saldo_pendiente ?? src.saldo);
  const monto_pagado_historico = num(src.monto_pagado_historico ?? src.monto_pagado ?? src.abonado_historico);
  const fecha_ultimo_abono = parseFechaISO(
    src.fecha_ultimo_abono ?? src.fecha_ultimo_pago ?? src.ultimo_abono
  );
  const semanas_pagadas = Math.max(0, Math.floor(num(src.semanas_pagadas ?? src.semanas_pagada) || 0));

  return {
    _fila: indice + 1,
    cedula,
    primer_nombre,
    segundo_nombre,
    primer_apellido,
    segundo_apellido,
    nombre_completo,
    telefono: txt(src.telefono),
    direccion: txt(src.direccion),
    actividad_economica: txt(src.actividad_economica),
    latitud: num(src.latitud),
    longitud: num(src.longitud),
    cobrador_email,
    cobrador_id,
    monto_desembolsado: monto,
    plazo_semanas: plazo != null ? Math.floor(plazo) : null,
    tasa_mensual: tasaMensual,
    dias_de_cobro: dias,
    fecha_desembolso,
    saldo_pendiente,
    monto_pagado_historico,
    fecha_ultimo_abono,
    semanas_pagadas,
    orden_visita: num(src.orden_visita ?? src.orden_ruta),
  };
}

function validarFilaCampos(fila) {
  const errores = [];
  if (!fila.cedula) errores.push('Cedula requerida');
  else {
    const v = validarCedula(fila.cedula);
    if (!v.ok) errores.push(v.error);
  }
  if (!fila.nombre_completo) errores.push('Nombre requerido (nombre_completo o primer_nombre + primer_apellido)');
  if (!fila.cobrador_email && !fila.cobrador_id) errores.push('cobrador_email o cobrador_id requerido');
  if (!fila.monto_desembolsado || fila.monto_desembolsado <= 0) errores.push('monto_desembolsado invalido');
  if (!fila.plazo_semanas || fila.plazo_semanas < 1 || fila.plazo_semanas > 520) errores.push('plazo_semanas invalido (1-520)');
  if (!fila.fecha_desembolso) errores.push('fecha_desembolso invalida (YYYY-MM-DD)');
  return errores;
}

async function cargarMapaCobradores(queryFn) {
  const rows = await queryFn(
    `SELECT u.id, u.email, u.nombre_completo FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id
     WHERE r.nombre = 'COBRADOR' AND u.activo = 1`
  );
  const porEmail = new Map();
  const porId = new Map();
  for (const c of rows) {
    if (c.email) porEmail.set(String(c.email).trim().toLowerCase(), c);
    porId.set(c.id, c);
  }
  return { porEmail, porId, lista: rows };
}

function resolverCobrador(fila, mapa) {
  if (fila.cobrador_id && mapa.porId.has(fila.cobrador_id)) {
    return mapa.porId.get(fila.cobrador_id);
  }
  const email = (fila.cobrador_email || '').toLowerCase();
  if (email && mapa.porEmail.has(email)) return mapa.porEmail.get(email);
  return null;
}

function resolverImportacionFinanciera(fila) {
  const fin = calcularCuotaYDistribucion(
    fila.monto_desembolsado,
    fila.plazo_semanas,
    fila.dias_de_cobro,
    fila.tasa_mensual
  );
  const agenda = generarAgendaDeCobro(
    fila.fecha_desembolso,
    fila.plazo_semanas,
    fila.dias_de_cobro,
    fin.cuotaPorDiaDeCobro
  );
  const total = fin.montoTotalPagar;
  const cuotasPorSemana = fila.dias_de_cobro.length || 1;

  let saldo;
  if (fila.saldo_pendiente != null && fila.saldo_pendiente >= 0) {
    saldo = Number(Math.min(Math.max(0, fila.saldo_pendiente), total).toFixed(2));
  } else if (fila.semanas_pagadas > 0) {
    const cuotasVirtuales = Math.min(agenda.length, fila.semanas_pagadas * cuotasPorSemana);
    const pagadoEst = Number((cuotasVirtuales * fin.cuotaPorDiaDeCobro).toFixed(2));
    saldo = Math.max(0, Number((total - pagadoEst).toFixed(2)));
  } else {
    saldo = total;
  }

  let monto_pagado_historico;
  if (fila.monto_pagado_historico != null && fila.monto_pagado_historico >= 0) {
    monto_pagado_historico = Number(Math.min(fila.monto_pagado_historico, total).toFixed(2));
    saldo = Math.max(0, Number((total - monto_pagado_historico).toFixed(2)));
  } else {
    monto_pagado_historico = Math.max(0, Number((total - saldo).toFixed(2)));
  }

  const fecha_ultimo_abono = fila.fecha_ultimo_abono || fila.fecha_desembolso;

  return {
    fin,
    agenda,
    saldo_pendiente: saldo,
    monto_pagado_historico,
    fecha_ultimo_abono,
  };
}

function calcularPreview(fila) {
  const resolved = resolverImportacionFinanciera(fila);
  const { fin, agenda, saldo_pendiente: saldo, monto_pagado_historico } = resolved;

  if (saldo > fin.montoTotalPagar + 0.02) {
    return { error: `saldo_pendiente (${saldo}) mayor que total a pagar (${fin.montoTotalPagar})` };
  }
  if (monto_pagado_historico > fin.montoTotalPagar + 0.02) {
    return {
      error: `monto_pagado_historico (${monto_pagado_historico}) supera total a pagar (${fin.montoTotalPagar})`,
    };
  }
  const diffCuadre = Math.abs(fin.montoTotalPagar - saldo - monto_pagado_historico);
  if (diffCuadre > 0.02) {
    return {
      error: `No cuadra: saldo (${saldo}) + pagado histórico (${monto_pagado_historico}) ≠ total (${fin.montoTotalPagar})`,
    };
  }
  if (
    fila.semanas_pagadas > 0 &&
    fila.saldo_pendiente != null &&
    fila.saldo_pendiente >= 0 &&
    (fila.monto_pagado_historico == null || fila.monto_pagado_historico === '')
  ) {
    const cuotasVirtuales = Math.min(agenda.length, fila.semanas_pagadas * (fila.dias_de_cobro.length || 1));
    const saldoPorSemanas = Math.max(
      0,
      Number((fin.montoTotalPagar - cuotasVirtuales * fin.cuotaPorDiaDeCobro).toFixed(2))
    );
    const diff = Math.abs(saldo - saldoPorSemanas);
    if (diff > fin.cuotaPorDiaDeCobro * 1.5 && diff > fin.montoTotalPagar * 0.08) {
      return {
        error: `saldo_pendiente (${fila.saldo_pendiente}) no cuadra con semanas_pagadas (${fila.semanas_pagadas}); esperado ~${saldoPorSemanas}`,
      };
    }
  }
  if (saldo <= 0.01 && monto_pagado_historico + 0.02 < fin.montoTotalPagar) {
    return { error: 'Saldo 0 pero el monto pagado histórico no cubre el total del crédito' };
  }
  return {
    ...fin,
    saldo_pendiente: saldo,
    monto_pagado_historico,
    fecha_ultimo_abono: resolved.fecha_ultimo_abono,
    cuotas_agenda: agenda.length,
    creara_pago_historico: monto_pagado_historico > 0.01,
  };
}

function aplicarMontoACuotasInMemoria(cuotas, monto) {
  let restante = Number(monto);
  for (const cuota of cuotas) {
    if (restante <= 0) break;
    if (!['Programada', 'Parcial'].includes(cuota.estado)) continue;
    const pendiente = Math.max(
      0,
      Number((Number(cuota.monto_programado) - Number(cuota.monto_pagado || 0)).toFixed(2))
    );
    if (pendiente <= 0) continue;
    const abono = Math.min(restante, pendiente);
    const nuevoPagado = Number((Number(cuota.monto_pagado || 0) + abono).toFixed(2));
    cuota.monto_pagado = nuevoPagado;
    cuota.estado =
      nuevoPagado >= Number(cuota.monto_programado) - 0.01 ? 'Pagada' : 'Parcial';
    restante = Number((restante - abono).toFixed(2));
  }
}

function reconciliarCuotasConPagosInMemoria(cuotasRows, sumPagos, toleranciaMax = 120) {
  const sumCuotas = Number(
    cuotasRows.reduce((s, c) => s + Number(c.monto_pagado || 0), 0).toFixed(2)
  );
  let diff = Number((sumPagos - sumCuotas).toFixed(2));
  if (Math.abs(diff) <= 0.01) return;

  if (Math.abs(diff) > toleranciaMax) {
    throw new Error(
      `No se pudo reconciliar pagos vs cuotas: pagos C$ ${sumPagos.toFixed(2)}, cuotas C$ ${sumCuotas.toFixed(2)}`
    );
  }

  const candidatas = cuotasRows.filter((c) => Number(c.monto_pagado || 0) > 0.009);
  const orden = candidatas.length ? candidatas : cuotasRows;
  for (let i = orden.length - 1; i >= 0 && Math.abs(diff) > 0.01; i -= 1) {
    const cuota = orden[i];
    const pagado = Number(cuota.monto_pagado || 0);
    const prog = Number(cuota.monto_programado || 0);
    const capped = Math.max(0, Number((pagado + diff).toFixed(2)));
    const aplicado = Number((capped - pagado).toFixed(2));
    if (aplicado === 0) continue;
    cuota.monto_pagado = capped;
    cuota.estado = capped >= prog - 0.01 ? 'Pagada' : capped > 0.009 ? 'Parcial' : 'Programada';
    diff = Number((diff - aplicado).toFixed(2));
  }
}

async function reconciliarCuotasConPagos(conn, prestamoId, toleranciaMax = 120) {
  const [pagosRow] = await conn.execute(
    `SELECT COALESCE(SUM(monto_pagado), 0) AS t FROM Pagos
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const sumPagos = Number(pagosRow[0]?.t || 0);
  const [cuotasRows] = await conn.execute(
    `SELECT id, monto_programado, monto_pagado, estado FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL
     ORDER BY fecha_programada ASC`,
    [prestamoId]
  );
  const sumCuotas = Number(
    cuotasRows.reduce((s, c) => s + Number(c.monto_pagado || 0), 0).toFixed(2)
  );
  let diff = Number((sumPagos - sumCuotas).toFixed(2));
  if (Math.abs(diff) <= 0.01) return;

  if (Math.abs(diff) > toleranciaMax) {
    throw new Error(
      `No se pudo reconciliar pagos vs cuotas: pagos C$ ${sumPagos.toFixed(2)}, cuotas C$ ${sumCuotas.toFixed(2)}`
    );
  }

  const candidatas = cuotasRows.filter((c) => Number(c.monto_pagado || 0) > 0.009);
  const orden = candidatas.length ? candidatas : cuotasRows;
  for (let i = orden.length - 1; i >= 0 && Math.abs(diff) > 0.01; i -= 1) {
    const cuota = orden[i];
    const pagado = Number(cuota.monto_pagado || 0);
    const prog = Number(cuota.monto_programado || 0);
    const nuevo = Number((pagado + diff).toFixed(2));
    const capped = Math.max(0, nuevo);
    const aplicado = Number((capped - pagado).toFixed(2));
    if (aplicado === 0) continue;
    const estado =
      capped >= prog - 0.01 ? 'Pagada' : capped > 0.009 ? 'Parcial' : 'Programada';
    await conn.execute(
      `UPDATE Cuotas_Calendario SET monto_pagado = ?, estado = ?, updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [capped, estado, cuota.id]
    );
    diff = Number((diff - aplicado).toFixed(2));
  }
}

async function verificarCuadrePrestamo(conn, prestamoId, tolerancia = 1.5) {
  const [rows] = await conn.execute(
    `SELECT monto_total_pagar, saldo_pendiente FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [prestamoId]
  );
  if (!rows.length) throw new Error('Prestamo no encontrado tras importar');
  const total = Number(rows[0].monto_total_pagar);
  const saldo = Number(rows[0].saldo_pendiente);
  const [pagosRow] = await conn.execute(
    `SELECT COALESCE(SUM(monto_pagado), 0) AS t FROM Pagos
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const [cuotasRow] = await conn.execute(
    `SELECT COALESCE(SUM(monto_pagado), 0) AS t FROM Cuotas_Calendario
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const sumPagos = Number(pagosRow[0]?.t || 0);
  const sumCuotas = Number(cuotasRow[0]?.t || 0);
  const saldoEsperado = Math.max(0, Number((total - sumPagos).toFixed(2)));

  if (Math.abs(saldo - saldoEsperado) > tolerancia) {
    throw new Error(
      `Descuadre saldo vs pagos: saldo C$ ${saldo.toFixed(2)}, esperado C$ ${saldoEsperado.toFixed(2)}`
    );
  }
  if (Math.abs(sumPagos - sumCuotas) > tolerancia) {
    throw new Error(
      `Descuadre pagos vs cuotas: pagos C$ ${sumPagos.toFixed(2)}, cuotas C$ ${sumCuotas.toFixed(2)}`
    );
  }
}

async function aplicarPagoHistoricoImportacion(conn, item) {
  const { prestamo_id: prestamoId, cobrador_id: cobradorId, monto_pagado_historico: monto, fecha_ultimo_abono: fecha } =
    item;
  if (!monto || monto <= 0.01) return;

  const fechaPago = fecha ? `${fecha}T12:00:00.000Z` : new Date().toISOString();
  const pagoId = uuidv4();
  await conn.execute(
    `INSERT INTO Pagos (id, prestamo_id, cobrador_id, monto_pagado, fecha_pago, latitud, longitud,
      registrado_por_admin, operador_id, is_synced)
     VALUES (?, ?, ?, ?, ?, 0, 0, 1, ?, 1)`,
    [pagoId, prestamoId, cobradorId, monto, fechaPago, cobradorId]
  );
  await aplicarMontoACuotas(conn, prestamoId, monto, fecha);
  await reconciliarCuotasConPagos(conn, prestamoId);

  const [pagosRow] = await conn.execute(
    `SELECT COALESCE(SUM(monto_pagado), 0) AS t FROM Pagos
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
  const [prestRows] = await conn.execute(
    `SELECT monto_total_pagar FROM Prestamos WHERE id = ? LIMIT 1`,
    [prestamoId]
  );
  const total = Number(prestRows[0]?.monto_total_pagar || 0);
  const sumPagos = Number(pagosRow[0]?.t || 0);
  const nuevoSaldo = Math.max(0, Number((total - sumPagos).toFixed(2)));
  const estado = nuevoSaldo <= 0.01 ? 'Pagado' : 'Activo';
  if (estado === 'Pagado') {
    await voidarCuotasRestantesAlCerrar(conn, prestamoId);
  }
  await conn.execute(
    `UPDATE Prestamos SET saldo_pendiente = ?, estado = ?, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
    [estado === 'Pagado' ? 0 : nuevoSaldo, estado, prestamoId]
  );
  await verificarCuadrePrestamo(conn, prestamoId);
}

async function validarFilas(filasRaw, queryFn) {
  const mapa = await cargarMapaCobradores(queryFn);
  const validas = [];
  const errores = [];
  const cedulasVistas = new Map();

  for (let i = 0; i < filasRaw.length; i += 1) {
    const raw = filasRaw[i];
    if (!raw || (typeof raw === 'object' && Object.values(raw).every((v) => v === '' || v == null))) continue;

    const fila = normalizarFila(raw, i);
    if (fila._omitir) continue;
    const camposErr = validarFilaCampos(fila);
    if (camposErr.length) {
      errores.push({ fila: fila._fila, cedula: fila.cedula, errores: camposErr });
      continue;
    }

    if (fila.cedula) {
      const prev = cedulasVistas.get(fila.cedula);
      if (prev != null) {
        errores.push({
          fila: fila._fila,
          cedula: fila.cedula,
          errores: [`Cédula duplicada en el archivo (ya en fila ${prev})`],
        });
        continue;
      }
      cedulasVistas.set(fila.cedula, fila._fila);
    }

    const cobrador = resolverCobrador(fila, mapa);
    if (!cobrador) {
      errores.push({
        fila: fila._fila,
        cedula: fila.cedula,
        errores: [`Cobrador no encontrado: ${fila.cobrador_email || fila.cobrador_id}`],
      });
      continue;
    }

    const preview = calcularPreview(fila);
    if (preview.error) {
      errores.push({ fila: fila._fila, cedula: fila.cedula, errores: [preview.error] });
      continue;
    }

    validas.push({
      fila: fila._fila,
      cedula: fila.cedula,
      nombre_completo: fila.nombre_completo,
      cobrador: cobrador.nombre_completo,
      cobrador_id: cobrador.id,
      monto_desembolsado: fila.monto_desembolsado,
      plazo_semanas: fila.plazo_semanas,
      saldo_pendiente: preview.saldo_pendiente,
      monto_pagado_historico: preview.monto_pagado_historico,
      cuota_semanal: preview.cuotaSemanalBase,
      monto_total: preview.montoTotalPagar,
      dias_de_cobro: fila.dias_de_cobro.join(','),
      fecha_desembolso: fila.fecha_desembolso,
      cuotas_pagadas: preview.creara_pago_historico ? 'vía Pago histórico' : 0,
      _datos: { ...fila, cobrador_id: cobrador.id },
    });
  }

  return {
    total_recibidas: filasRaw.length,
    validas: validas.length,
    errores: errores.length,
    preview: validas.slice(0, 50),
    detalle_errores: errores,
    cobradores: mapa.lista.map((c) => ({ id: c.id, email: c.email, nombre: c.nombre_completo })),
  };
}

async function precargarCedulas(conn, cedulas) {
  const map = new Map();
  if (!cedulas.length) return map;
  const uniq = [...new Set(cedulas)];
  const CHUNK = 100;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const [rows] = await conn.execute(
      `SELECT cedula, id FROM Clientes WHERE cedula IN (${ph}) AND deleted_at IS NULL`,
      slice
    );
    for (const r of rows) map.set(r.cedula, r.id);
  }
  return map;
}

async function precargarClientesConCreditoActivo(conn, clienteIds) {
  const set = new Set();
  if (!clienteIds.length) return set;
  const uniq = [...new Set(clienteIds)];
  const CHUNK = 100;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const [rows] = await conn.execute(
      `SELECT cliente_id FROM Prestamos
       WHERE cliente_id IN (${ph}) AND estado = 'Activo' AND deleted_at IS NULL`,
      slice
    );
    for (const r of rows) set.add(r.cliente_id);
  }
  return set;
}

async function precargarCuotasPorPrestamos(conn, prestamoIds) {
  const map = new Map();
  if (!prestamoIds.length) return map;
  const CHUNK = 40;
  for (let i = 0; i < prestamoIds.length; i += CHUNK) {
    const slice = prestamoIds.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const [rows] = await conn.execute(
      `SELECT id, prestamo_id, fecha_programada, monto_programado, monto_pagado, estado
       FROM Cuotas_Calendario
       WHERE prestamo_id IN (${ph}) AND deleted_at IS NULL
       ORDER BY prestamo_id, fecha_programada ASC`,
      slice
    );
    for (const r of rows) {
      if (!map.has(r.prestamo_id)) map.set(r.prestamo_id, []);
      map.get(r.prestamo_id).push({ ...r });
    }
  }
  return map;
}

async function verificarCuadrePrestamosBulk(conn, prestamoIds, tolerancia = 1.5) {
  if (!prestamoIds.length) return;
  const CHUNK = 50;
  for (let i = 0; i < prestamoIds.length; i += CHUNK) {
    const slice = prestamoIds.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const [rows] = await conn.execute(
      `SELECT p.id, p.monto_total_pagar, p.saldo_pendiente,
              (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg
               WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS sum_pagos,
              (SELECT COALESCE(SUM(monto_pagado), 0) FROM Cuotas_Calendario cc
               WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL) AS sum_cuotas
       FROM Prestamos p
       WHERE p.id IN (${ph}) AND p.deleted_at IS NULL`,
      slice
    );
    for (const r of rows) {
      const total = Number(r.monto_total_pagar);
      const saldo = Number(r.saldo_pendiente);
      const sumPagos = Number(r.sum_pagos || 0);
      const sumCuotas = Number(r.sum_cuotas || 0);
      const saldoEsperado = Math.max(0, Number((total - sumPagos).toFixed(2)));
      if (Math.abs(saldo - saldoEsperado) > tolerancia) {
        throw new Error(
          `Descuadre saldo vs pagos (${r.id}): saldo C$ ${saldo.toFixed(2)}, esperado C$ ${saldoEsperado.toFixed(2)}`
        );
      }
      if (Math.abs(sumPagos - sumCuotas) > tolerancia) {
        throw new Error(
          `Descuadre pagos vs cuotas (${r.id}): pagos C$ ${sumPagos.toFixed(2)}, cuotas C$ ${sumCuotas.toFixed(2)}`
        );
      }
    }
  }
}

async function precargarRutas(conn, cobradorIds, mapa) {
  const cache = new Map();
  const ids = [...new Set(cobradorIds.filter(Boolean))];
  if (!ids.length) return cache;

  const ph = ids.map(() => '?').join(',');
  const [rows] = await conn.execute(
    `SELECT id, cobrador_id FROM Rutas
     WHERE cobrador_id IN (${ph}) AND activa = 1 AND deleted_at IS NULL`,
    ids
  );
  for (const r of rows) cache.set(r.cobrador_id, r.id);

  for (const cobId of ids) {
    if (cache.has(cobId)) continue;
    const nombre = mapa.porId.get(cobId)?.nombre_completo || cobId;
    const rutaId = `RUTA-${cobId}`;
    await conn.execute(
      `INSERT INTO Rutas (id, nombre, descripcion, cobrador_id, activa, is_synced)
       VALUES (?, ?, ?, ?, 1, 1)
       ON DUPLICATE KEY UPDATE cobrador_id = VALUES(cobrador_id), activa = 1, updated_at = NOW()`,
      [rutaId, `Ruta ${nombre}`, 'Ruta diaria automatica — Esteli', cobId]
    );
    cache.set(cobId, rutaId);
  }
  return cache;
}

async function insertarCuotasBulk(conn, cuotasRows) {
  return insertMany(
    conn,
    {
      insert:
        'INSERT INTO Cuotas_Calendario (id, prestamo_id, fecha_programada, monto_programado, monto_pagado, estado, is_synced)',
      placeholder: '(?, ?, ?, ?, ?, ?, 1)',
      values: (c) => [
        c.id,
        c.prestamo_id,
        c.fecha_programada,
        c.monto_programado,
        c.monto_pagado ?? 0,
        c.estado,
      ],
    },
    cuotasRows,
    150
  );
}

async function importarFilasEnLote(conn, preparadas, mapa) {
  const cedulaMap = await precargarCedulas(
    conn,
    preparadas.map((p) => p.cedula)
  );
  const nuevos = preparadas.filter((p) => !cedulaMap.has(p.cedula)).length;
  const newIds = await reserveClienteIds(conn, nuevos);
  let newIdIdx = 0;

  const cobIds = [...new Set(preparadas.map((p) => p.cobrador_id))];
  const rutaCache = await precargarRutas(conn, cobIds, mapa);
  const rutaOrden = new Map();

  const clienteIdsPrevistos = [];
  for (const fila of preparadas) {
    clienteIdsPrevistos.push(cedulaMap.get(fila.cedula) || newIds[newIdIdx]);
    if (!cedulaMap.has(fila.cedula)) newIdIdx += 1;
  }
  const activos = await precargarClientesConCreditoActivo(conn, clienteIdsPrevistos);
  for (const fila of preparadas) {
    const cid = cedulaMap.get(fila.cedula);
    if (cid && activos.has(cid)) {
      throw new Error(`Cliente ya tiene credito activo (${fila.cedula})`);
    }
  }

  newIdIdx = 0;
  const clientesInsert = [];
  const clientesUpdate = [];
  const prestamosInsert = [];
  const cuotasBuffer = [];
  const rutaClientes = [];
  const pendientesPago = [];
  const exitos = [];
  const prestamoIds = [];

  for (const fila of preparadas) {
    const { fin, agenda, saldo_pendiente: saldo, monto_pagado_historico, fecha_ultimo_abono } =
      resolverImportacionFinanciera(fila);

    let clienteId = cedulaMap.get(fila.cedula);
    let clienteNuevo = false;
    if (clienteId) {
      clientesUpdate.push({
        id: clienteId,
        primer_nombre: fila.primer_nombre,
        segundo_nombre: fila.segundo_nombre,
        primer_apellido: fila.primer_apellido,
        segundo_apellido: fila.segundo_apellido,
        nombre_completo: fila.nombre_completo,
        telefono: fila.telefono,
        direccion: fila.direccion,
        actividad_economica: fila.actividad_economica,
        latitud: fila.latitud,
        longitud: fila.longitud,
        cobrador_id: fila.cobrador_id,
      });
    } else {
      clienteId = newIds[newIdIdx];
      newIdIdx += 1;
      cedulaMap.set(fila.cedula, clienteId);
      clienteNuevo = true;
      clientesInsert.push({
        id: clienteId,
        primer_nombre: fila.primer_nombre,
        segundo_nombre: fila.segundo_nombre,
        primer_apellido: fila.primer_apellido,
        segundo_apellido: fila.segundo_apellido,
        nombre_completo: fila.nombre_completo,
        cedula: fila.cedula,
        telefono: fila.telefono,
        direccion: fila.direccion,
        actividad_economica: fila.actividad_economica,
        latitud: fila.latitud,
        longitud: fila.longitud,
        cobrador_id: fila.cobrador_id,
      });
    }

    const prestamoId = uuidv4();
    prestamoIds.push(prestamoId);
    const diasJson = JSON.stringify(fila.dias_de_cobro);
    prestamosInsert.push({
      id: prestamoId,
      cliente_id: clienteId,
      monto_desembolsado: fila.monto_desembolsado,
      plazo_semanas: fila.plazo_semanas,
      tasa_interes_aplicada: fin.tasaInteresAplicada,
      cuota_semanal_base: fin.cuotaSemanalBase,
      monto_total_pagar: fin.montoTotalPagar,
      saldo_pendiente: saldo,
      frecuencia_semana: fin.frecuenciaSemanal,
      dias_de_cobro: diasJson,
      fecha_desembolso: fila.fecha_desembolso,
    });

    for (const c of agenda) {
      cuotasBuffer.push({
        id: uuidv4(),
        prestamo_id: prestamoId,
        fecha_programada: c.fecha_programada,
        monto_programado: c.monto_programado,
        monto_pagado: 0,
        estado: 'Programada',
      });
    }

    const rutaId = rutaCache.get(fila.cobrador_id);
    let orden =
      fila.orden_visita != null && Number.isFinite(fila.orden_visita)
        ? Math.floor(fila.orden_visita)
        : null;
    if (orden == null) {
      const next = (rutaOrden.get(rutaId) || 0) + 1;
      rutaOrden.set(rutaId, next);
      orden = next;
    }
    rutaClientes.push({ ruta_id: rutaId, cliente_id: clienteId, orden_visita: orden });

    const item = {
      fila: fila._fila,
      cedula: fila.cedula,
      cliente_id: clienteId,
      prestamo_id: prestamoId,
      cliente_nuevo: clienteNuevo,
      ruta_id: rutaId,
      cobrador_id: fila.cobrador_id,
      monto_pagado_historico,
      fecha_ultimo_abono,
      monto_total_pagar: fin.montoTotalPagar,
    };
    pendientesPago.push(item);
    exitos.push(item);
  }

  if (clientesInsert.length) {
    await insertMany(
      conn,
      {
        insert: `INSERT INTO Clientes (
          id, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
          nombre_completo, cedula, telefono, direccion, actividad_economica,
          latitud, longitud, cobrador_id, is_synced
        )`,
        placeholder: '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        values: (c) => [
          c.id,
          c.primer_nombre,
          c.segundo_nombre,
          c.primer_apellido,
          c.segundo_apellido,
          c.nombre_completo,
          c.cedula,
          c.telefono,
          c.direccion,
          c.actividad_economica,
          c.latitud,
          c.longitud,
          c.cobrador_id,
        ],
      },
      clientesInsert,
      80
    );
  }

  for (const c of clientesUpdate) {
    await conn.execute(
      `UPDATE Clientes SET
        primer_nombre = ?, segundo_nombre = ?, primer_apellido = ?, segundo_apellido = ?,
        nombre_completo = ?, telefono = COALESCE(?, telefono), direccion = COALESCE(?, direccion),
        actividad_economica = COALESCE(?, actividad_economica),
        latitud = COALESCE(?, latitud), longitud = COALESCE(?, longitud),
        cobrador_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        c.primer_nombre,
        c.segundo_nombre,
        c.primer_apellido,
        c.segundo_apellido,
        c.nombre_completo,
        c.telefono,
        c.direccion,
        c.actividad_economica,
        c.latitud,
        c.longitud,
        c.cobrador_id,
        c.id,
      ]
    );
  }

  await insertMany(
    conn,
    {
      insert: `INSERT INTO Prestamos (
        id, cliente_id, fiador_id, monto_desembolsado, plazo_semanas, tasa_interes_aplicada,
        cuota_semanal_base, monto_total_pagar, saldo_pendiente, frecuencia_semana,
        dias_de_cobro, periodicidad, estado, fecha_desembolso, is_synced
      )`,
      placeholder: "(?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'SEMANAL', 'Activo', ?, 1)",
      values: (p) => [
        p.id,
        p.cliente_id,
        p.monto_desembolsado,
        p.plazo_semanas,
        p.tasa_interes_aplicada,
        p.cuota_semanal_base,
        p.monto_total_pagar,
        p.saldo_pendiente,
        p.frecuencia_semana,
        p.dias_de_cobro,
        p.fecha_desembolso,
      ],
    },
    prestamosInsert,
    80
  );

  await insertarCuotasBulk(conn, cuotasBuffer);

  const clienteIdsRuta = [...new Set(rutaClientes.map((r) => r.cliente_id))];
  if (clienteIdsRuta.length) {
    const CHUNK = 100;
    for (let i = 0; i < clienteIdsRuta.length; i += CHUNK) {
      const slice = clienteIdsRuta.slice(i, i + CHUNK);
      const ph = slice.map(() => '?').join(',');
      await conn.execute(`DELETE FROM Ruta_Clientes WHERE cliente_id IN (${ph})`, slice);
    }
  }

  await insertMany(
    conn,
    {
      insert: 'INSERT INTO Ruta_Clientes (ruta_id, cliente_id, orden_visita)',
      placeholder: '(?, ?, ?)',
      values: (r) => [r.ruta_id, r.cliente_id, r.orden_visita],
    },
    rutaClientes,
    120
  );

  const pagosInsert = pendientesPago
    .filter((p) => p.monto_pagado_historico > 0.01)
    .map((p) => {
      const fecha = p.fecha_ultimo_abono;
      const fechaPago = fecha ? `${fecha}T12:00:00.000Z` : new Date().toISOString();
      return {
        id: uuidv4(),
        prestamo_id: p.prestamo_id,
        cobrador_id: p.cobrador_id,
        monto_pagado: p.monto_pagado_historico,
        fecha_pago: fechaPago,
        operador_id: p.cobrador_id,
      };
    });

  if (pagosInsert.length) {
    await insertMany(
      conn,
      {
        insert: `INSERT INTO Pagos (id, prestamo_id, cobrador_id, monto_pagado, fecha_pago, latitud, longitud,
          registrado_por_admin, operador_id, is_synced)`,
        placeholder: '(?, ?, ?, ?, ?, 0, 0, 1, ?, 1)',
        values: (pg) => [
          pg.id,
          pg.prestamo_id,
          pg.cobrador_id,
          pg.monto_pagado,
          pg.fecha_pago,
          pg.operador_id,
        ],
      },
      pagosInsert,
      100
    );

    const cuotasPorPrestamo = await precargarCuotasPorPrestamos(
      conn,
      pagosInsert.map((p) => p.prestamo_id)
    );
    const cuotasDirty = new Map();

    for (const pg of pagosInsert) {
      const cuotas = cuotasPorPrestamo.get(pg.prestamo_id) || [];
      aplicarMontoACuotasInMemoria(cuotas, pg.monto_pagado);
      reconciliarCuotasConPagosInMemoria(cuotas, pg.monto_pagado);
      cuotasDirty.set(pg.prestamo_id, cuotas);
    }

    const cuotaUpdates = [];
    for (const cuotas of cuotasDirty.values()) {
      for (const c of cuotas) {
        cuotaUpdates.push({ id: c.id, monto_pagado: c.monto_pagado, estado: c.estado });
      }
    }
    if (cuotaUpdates.length) {
      await updateManyById(conn, {
        table: 'Cuotas_Calendario',
        idCol: 'id',
        fields: ['monto_pagado', 'estado'],
        rows: cuotaUpdates,
        chunkSize: 150,
        extraSet: 'is_synced = 1',
      });
    }

    const prestamosUpdate = [];
    const liquidados = [];
    for (const p of pendientesPago) {
      if (p.monto_pagado_historico <= 0.01) continue;
      const total = Number(p.monto_total_pagar || 0);
      const sumPagos = Number(p.monto_pagado_historico);
      const nuevoSaldo = Math.max(0, Number((total - sumPagos).toFixed(2)));
      const estado = nuevoSaldo <= 0.01 ? 'Pagado' : 'Activo';
      prestamosUpdate.push({
        id: p.prestamo_id,
        saldo_pendiente: estado === 'Pagado' ? 0 : nuevoSaldo,
        estado,
      });
      if (estado === 'Pagado') liquidados.push(p.prestamo_id);
    }

    if (prestamosUpdate.length) {
      await updateManyById(conn, {
        table: 'Prestamos',
        idCol: 'id',
        fields: ['saldo_pendiente', 'estado'],
        rows: prestamosUpdate,
        chunkSize: 80,
        extraSet: 'is_synced = 1',
      });
    }

    if (liquidados.length) {
      const CHUNK = 50;
      for (let i = 0; i < liquidados.length; i += CHUNK) {
        const slice = liquidados.slice(i, i + CHUNK);
        const ph = slice.map(() => '?').join(',');
        await conn.execute(
          `UPDATE Cuotas_Calendario SET
            estado = 'Pagada',
            monto_programado = COALESCE(monto_pagado, 0),
            updated_at = NOW(),
            is_synced = 1
           WHERE prestamo_id IN (${ph}) AND estado IN ('Programada', 'Parcial') AND deleted_at IS NULL`,
          slice
        );
      }
    }
  }

  const verificarIds = pendientesPago.map((p) => p.prestamo_id);
  await verificarCuadrePrestamosBulk(conn, verificarIds);

  return { exitos, rutasOptimizar: new Set(exitos.map((e) => e.ruta_id)) };
}

async function importarUnaFila(conn, fila, ctx) {
  const { fin, agenda, saldo_pendiente: saldo, monto_pagado_historico, fecha_ultimo_abono } =
    resolverImportacionFinanciera(fila);

  let clienteId = ctx.cedulaMap.get(fila.cedula);
  let clienteNuevo = false;

  if (clienteId) {
    await conn.execute(
      `UPDATE Clientes SET
        primer_nombre = ?, segundo_nombre = ?, primer_apellido = ?, segundo_apellido = ?,
        nombre_completo = ?, telefono = COALESCE(?, telefono), direccion = COALESCE(?, direccion),
        actividad_economica = COALESCE(?, actividad_economica),
        latitud = COALESCE(?, latitud), longitud = COALESCE(?, longitud),
        cobrador_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        fila.primer_nombre,
        fila.segundo_nombre,
        fila.primer_apellido,
        fila.segundo_apellido,
        fila.nombre_completo,
        fila.telefono,
        fila.direccion,
        fila.actividad_economica,
        fila.latitud,
        fila.longitud,
        fila.cobrador_id,
        clienteId,
      ]
    );
  } else {
    clienteId = ctx.newIds[ctx.newIdIdx];
    ctx.newIdIdx += 1;
    ctx.cedulaMap.set(fila.cedula, clienteId);
    clienteNuevo = true;
    await conn.execute(
      `INSERT INTO Clientes (
        id, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
        nombre_completo, cedula, telefono, direccion, actividad_economica,
        latitud, longitud, cobrador_id, is_synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        clienteId,
        fila.primer_nombre,
        fila.segundo_nombre,
        fila.primer_apellido,
        fila.segundo_apellido,
        fila.nombre_completo,
        fila.cedula,
        fila.telefono,
        fila.direccion,
        fila.actividad_economica,
        fila.latitud,
        fila.longitud,
        fila.cobrador_id,
      ]
    );
  }

  const [activo] = await conn.execute(
    `SELECT id FROM Prestamos WHERE cliente_id = ? AND estado = 'Activo' AND deleted_at IS NULL LIMIT 1`,
    [clienteId]
  );
  if (activo.length) {
    throw new Error('Cliente ya tiene credito activo');
  }

  const prestamoId = uuidv4();
  const diasJson = JSON.stringify(fila.dias_de_cobro);
  await conn.execute(
    `INSERT INTO Prestamos (
      id, cliente_id, fiador_id,
      monto_desembolsado, plazo_semanas, tasa_interes_aplicada,
      cuota_semanal_base, monto_total_pagar, saldo_pendiente, frecuencia_semana,
      dias_de_cobro, periodicidad, estado, fecha_desembolso, is_synced
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'SEMANAL', 'Activo', ?, 1)`,
    [
      prestamoId,
      clienteId,
      fila.monto_desembolsado,
      fila.plazo_semanas,
      fin.tasaInteresAplicada,
      fin.cuotaSemanalBase,
      fin.montoTotalPagar,
      saldo,
      fin.frecuenciaSemanal,
      diasJson,
      fila.fecha_desembolso,
    ]
  );

  const agendaCuotas = agenda;
  for (let i = 0; i < agendaCuotas.length; i += 1) {
    const c = agendaCuotas[i];
    ctx.cuotasBuffer.push({
      id: uuidv4(),
      prestamo_id: prestamoId,
      fecha_programada: c.fecha_programada,
      monto_programado: c.monto_programado,
      monto_pagado: 0,
      estado: 'Programada',
    });
  }

  const rutaId = ctx.rutaCache.get(fila.cobrador_id);
  let orden =
    fila.orden_visita != null && Number.isFinite(fila.orden_visita)
      ? Math.floor(fila.orden_visita)
      : null;
  if (orden == null) {
    const next = (ctx.rutaOrden.get(rutaId) || 0) + 1;
    ctx.rutaOrden.set(rutaId, next);
    orden = next;
  }
  await conn.execute(
    `DELETE FROM Ruta_Clientes WHERE cliente_id = ? AND ruta_id != ?`,
    [clienteId, rutaId]
  );
  await conn.execute(
    `INSERT INTO Ruta_Clientes (ruta_id, cliente_id, orden_visita)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE orden_visita = VALUES(orden_visita)`,
    [rutaId, clienteId, orden]
  );

  return {
    cliente_id: clienteId,
    prestamo_id: prestamoId,
    cliente_nuevo: clienteNuevo,
    ruta_id: rutaId,
    cobrador_id: fila.cobrador_id,
    monto_pagado_historico,
    fecha_ultimo_abono,
  };
}

async function importarFilas(filasRaw, queryFn, getConnection, opciones = {}) {
  await initSecuenciaCliente(queryFn);

  const mapa = await cargarMapaCobradores(queryFn);
  const optimizar_rutas = opciones.optimizar_rutas === true;

  const preparadas = [];
  const erroresPrev = [];
  const cedulasVistas = new Set();

  for (let i = 0; i < filasRaw.length; i += 1) {
    const raw = filasRaw[i];
    if (!raw || (typeof raw === 'object' && Object.values(raw).every((v) => v === '' || v == null))) continue;
    const fila = normalizarFila(raw, i);
    if (fila._omitir) continue;
    const camposErr = validarFilaCampos(fila);
    if (camposErr.length) {
      erroresPrev.push({ fila: fila._fila, cedula: fila.cedula, error: camposErr.join('; ') });
      continue;
    }
    if (fila.cedula && cedulasVistas.has(fila.cedula)) {
      erroresPrev.push({
        fila: fila._fila,
        cedula: fila.cedula,
        error: 'Cédula duplicada en el archivo',
      });
      continue;
    }
    if (fila.cedula) cedulasVistas.add(fila.cedula);
    const cobrador = resolverCobrador(fila, mapa);
    if (!cobrador) {
      erroresPrev.push({ fila: fila._fila, cedula: fila.cedula, error: 'Cobrador no encontrado' });
      continue;
    }
    const preview = calcularPreview(fila);
    if (preview.error) {
      erroresPrev.push({ fila: fila._fila, cedula: fila.cedula, error: preview.error });
      continue;
    }
    preparadas.push({ ...fila, cobrador_id: cobrador.id });
  }

  const exitos = [];
  const fallos = [...erroresPrev];
  const conn = await getConnection();
  let rutasOptimizar = new Set();

  try {
    await conn.beginTransaction();
    const lote = await importarFilasEnLote(conn, preparadas, mapa);
    exitos.push(...lote.exitos);
    rutasOptimizar = lote.rutasOptimizar;
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    return {
      importados: 0,
      fallidos: preparadas.length + erroresPrev.length,
      detalle_exitos: [],
      detalle_fallos: [
        ...erroresPrev,
        { fila: 0, cedula: null, error: e.message || 'Error de transaccion' },
      ],
    };
  } finally {
    conn.release();
  }

  if (optimizar_rutas) {
    for (const rutaId of rutasOptimizar) {
      try {
        await optimizarOrdenRuta(rutaId);
      } catch {
        /* no bloquear import */
      }
    }
  }

  return {
    importados: exitos.length,
    fallidos: fallos.length,
    detalle_exitos: exitos.slice(0, 100),
    detalle_fallos: fallos.slice(0, 100),
  };
}

module.exports = {
  normalizarFila,
  validarFilas,
  importarFilas,
  resolverImportacionFinanciera,
  calcularPreview,
  PLANTILLA_COLUMNAS: [
    'cedula',
    'primer_nombre',
    'primer_apellido',
    'segundo_nombre',
    'segundo_apellido',
    'nombre_completo',
    'telefono',
    'direccion',
    'actividad_economica',
    'cobrador_email',
    'monto_desembolsado',
    'plazo_semanas',
    'tasa_mensual',
    'dias_cobro',
    'fecha_desembolso',
    'saldo_pendiente',
    'monto_pagado_historico',
    'fecha_ultimo_abono',
    'semanas_pagadas',
    'latitud',
    'longitud',
    'orden_visita',
  ],
};
