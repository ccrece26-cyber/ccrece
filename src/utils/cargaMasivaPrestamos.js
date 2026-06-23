const { v4: uuidv4 } = require('uuid');
const { nombreCompleto } = require('./cliente');
const { normalizarCedula, validarCedula } = require('./cedulaNic');
const { reserveClienteIds, initSecuenciaCliente } = require('./clienteId');
const { insertMany } = require('./bulkSql');
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

function calcularPreview(fila) {
  const fin = calcularCuotaYDistribucion(
    fila.monto_desembolsado,
    fila.plazo_semanas,
    fila.dias_de_cobro,
    fila.tasa_mensual
  );
  let saldo = fila.saldo_pendiente;
  if (saldo == null || saldo <= 0) saldo = fin.montoTotalPagar;
  if (saldo > fin.montoTotalPagar + 0.02) {
    return { error: `saldo_pendiente (${saldo}) mayor que total a pagar (${fin.montoTotalPagar})` };
  }
  const agenda = generarAgendaDeCobro(
    fila.fecha_desembolso,
    fila.plazo_semanas,
    fila.dias_de_cobro,
    fin.cuotaPorDiaDeCobro
  );
  const cuotasPorSemana = fila.dias_de_cobro.length || 1;
  const cuotasAPagar = Math.min(
    agenda.length,
    Math.max(0, fila.semanas_pagadas) * cuotasPorSemana
  );
  if (
    fila.semanas_pagadas > 0 &&
    fila.saldo_pendiente != null &&
    fila.saldo_pendiente > 0
  ) {
    const montoPagadoEst = cuotasAPagar * fin.cuotaPorDiaDeCobro;
    const saldoEsperado = Math.max(0, Number((fin.montoTotalPagar - montoPagadoEst).toFixed(2)));
    const diff = Math.abs(saldo - saldoEsperado);
    if (diff > fin.cuotaPorDiaDeCobro * 1.5 && diff > fin.montoTotalPagar * 0.08) {
      return {
        error: `saldo_pendiente (${saldo}) no cuadra con semanas_pagadas (${fila.semanas_pagadas}); esperado ~${saldoEsperado}`,
      };
    }
  }
  if (cuotasAPagar >= agenda.length && saldo > 0.02) {
    return { error: 'semanas_pagadas cubren el plazo pero saldo_pendiente sigue > 0' };
  }
  return {
    ...fin,
    saldo_pendiente: Number(saldo.toFixed(2)),
    cuotas_agenda: agenda.length,
    cuotas_marcar_pagadas: cuotasAPagar,
  };
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
      cuota_semanal: preview.cuotaSemanalBase,
      monto_total: preview.montoTotalPagar,
      dias_de_cobro: fila.dias_de_cobro.join(','),
      fecha_desembolso: fila.fecha_desembolso,
      cuotas_pagadas: preview.cuotas_marcar_pagadas,
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

async function precargarRutas(conn, cobradorIds, mapa) {
  const cache = new Map();
  for (const cobId of cobradorIds) {
    const [rows] = await conn.execute(
      `SELECT id FROM Rutas WHERE cobrador_id = ? AND activa = 1 AND deleted_at IS NULL LIMIT 1`,
      [cobId]
    );
    if (rows[0]?.id) {
      cache.set(cobId, rows[0].id);
      continue;
    }
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
    100
  );
}

async function importarUnaFila(conn, fila, ctx) {
  const fin = calcularCuotaYDistribucion(
    fila.monto_desembolsado,
    fila.plazo_semanas,
    fila.dias_de_cobro,
    fila.tasa_mensual
  );

  let saldo = fila.saldo_pendiente;
  if (saldo == null || saldo <= 0) saldo = fin.montoTotalPagar;
  saldo = Number(Math.min(saldo, fin.montoTotalPagar).toFixed(2));

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

  const agenda = generarAgendaDeCobro(
    fila.fecha_desembolso,
    fila.plazo_semanas,
    fila.dias_de_cobro,
    fin.cuotaPorDiaDeCobro
  );
  const cuotasPorSemana = fila.dias_de_cobro.length || 1;
  const pagarHasta = Math.min(agenda.length, Math.max(0, fila.semanas_pagadas) * cuotasPorSemana);

  for (let i = 0; i < agenda.length; i += 1) {
    const c = agenda[i];
    const pagada = i < pagarHasta;
    ctx.cuotasBuffer.push({
      id: uuidv4(),
      prestamo_id: prestamoId,
      fecha_programada: c.fecha_programada,
      monto_programado: c.monto_programado,
      monto_pagado: pagada ? c.monto_programado : 0,
      estado: pagada ? 'Pagada' : 'Programada',
    });
  }

  if (saldo <= 0.01) {
    await conn.execute(`UPDATE Prestamos SET estado = 'Pagado', saldo_pendiente = 0 WHERE id = ?`, [prestamoId]);
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
  const rutasOptimizar = new Set();
  const conn = await getConnection();
  const cuotasBuffer = [];
  const rutaOrden = new Map();

  try {
    await conn.beginTransaction();

    const cedulaMap = await precargarCedulas(
      conn,
      preparadas.map((p) => p.cedula)
    );
    const nuevos = preparadas.filter((p) => !cedulaMap.has(p.cedula)).length;
    const newIds = await reserveClienteIds(conn, nuevos);
    let newIdIdx = 0;

    const cobIds = [...new Set(preparadas.map((p) => p.cobrador_id))];
    const rutaCache = await precargarRutas(conn, cobIds, mapa);

    const ctx = { cedulaMap, newIds, newIdIdx, rutaCache, cuotasBuffer, rutaOrden, mapa };

    for (const fila of preparadas) {
      try {
        ctx.newIdIdx = newIdIdx;
        const r = await importarUnaFila(conn, fila, ctx);
        newIdIdx = ctx.newIdIdx;
        exitos.push({ fila: fila._fila, cedula: fila.cedula, ...r });
        rutasOptimizar.add(r.ruta_id);
      } catch (e) {
        fallos.push({ fila: fila._fila, cedula: fila.cedula, error: e.message });
      }
    }

    await insertarCuotasBulk(conn, cuotasBuffer);
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
    'semanas_pagadas',
    'latitud',
    'longitud',
    'orden_visita',
  ],
};
