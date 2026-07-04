const { v4: uuidv4 } = require('uuid');
const { query, getConnection } = require('../config/db');
const { leerParametrosFinancieros } = require('../utils/parametrosFinancieros');
const { nombreCompleto } = require('../utils/cliente');
const { normalizarCedula, validarCedula } = require('../utils/cedulaNic');
const { nextClienteId, esIdClienteOficial, initSecuenciaCliente } = require('../utils/clienteId');
const {
  diaCobroHoy,
  montoVisitaHoy,
  debeSugerirCobroEnFecha,
  esCuotaDiaDesembolso,
  fechaCalendarioISO,
} = require('../utils/diasCobro');
const { upsertFiadorEnNube, verificarFiadorEnNube, repararFiadoresHistoricos } = require('../utils/fiadoresNube');
const { insertMany } = require('../utils/bulkSql');
const { buildRutaDiariaAdmin } = require('../utils/rutaDiariaAdmin');
const { rangoDiaLocal, whereCierreCalendarioDia, desdeCorreccionesUnix } = require('../utils/fechasSql');
const { hoyISO } = require('../utils/zonaHoraria');
const { ensureRutaForCobrador, sincronizarRutaClienteAsignado } = require('../utils/rutas');
const { exigirUsuarioActivo, responderErrorUsuario } = require('../utils/assertUsuarioActivo');
const { aplicarMontoACuotas } = require('../utils/registrarPagoNube');
const { capMontoAlSaldo } = require('../utils/cobroMontos');
const { sincronizarCuotasTrasCierrePagado } = require('../utils/cuotasCalendario');
const { calcularLiquidacionAnticipada } = require('../utils/finanzasNube');
const { aplicarProrrogaEnNube } = require('../utils/prorrogasNube');
const { notificarAdminsCobrosCobrador } = require('../utils/expoPush');

/**
 * Clientes asignados al cobrador + ruta del dia.
 * Query ?admin=1 → todos los clientes activos (modo campo administrador).
 */
async function rutaDiaria(req, res) {
  if (req.query.admin === '1') {
    return buildRutaDiariaAdmin(req, res);
  }
  try {
    const { cobradorId } = req.params;
    const hoy = fechaCalendarioISO();
    const { inicio: diaIni, fin: diaFin } = rangoDiaLocal(hoy);

    await initSecuenciaCliente(query);
    const secRows = await query(`SELECT valor FROM Parametros_Globales WHERE clave = 'SEC_CLIENTE'`);
    const secuencia = secRows[0]?.valor || '0';

    const rutas = await query(
      `SELECT * FROM Rutas WHERE cobrador_id = ? AND activa = 1 AND deleted_at IS NULL`,
      [cobradorId]
    );

    const rutaIds = rutas.map((r) => r.id);
    let ruta_clientes = [];
    if (rutaIds.length) {
      const ph = rutaIds.map(() => '?').join(',');
      ruta_clientes = await query(
        `SELECT rc.ruta_id, rc.cliente_id, rc.orden_visita
         FROM Ruta_Clientes rc WHERE rc.ruta_id IN (${ph})`,
        rutaIds
      );
    }

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
    let fiadores = [];
    let garantias = [];
    let prestamo_garantias = [];

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
      if (prestamoIds.length) {
        const phPg = prestamoIds.map(() => '?').join(',');
        prestamo_garantias = await query(
          `SELECT prestamo_id, garantia_id FROM Prestamo_Garantias WHERE prestamo_id IN (${phPg})`,
          prestamoIds
        );
        const garIds = [...new Set(prestamo_garantias.map((pg) => pg.garantia_id).filter(Boolean))];
        if (garIds.length) {
          const phG = garIds.map(() => '?').join(',');
          garantias = await query(
            `SELECT * FROM Garantias WHERE id IN (${phG}) AND deleted_at IS NULL`,
            garIds
          );
        }
      }
      const fiadorIds = [...new Set(prestamos.map((p) => p.fiador_id).filter(Boolean))];
      if (fiadorIds.length) {
        const phF = fiadorIds.map(() => '?').join(',');
        fiadores = await query(`SELECT * FROM Fiadores WHERE id IN (${phF}) AND deleted_at IS NULL`, fiadorIds);
      } else if (clienteIds.length) {
        const phC = clienteIds.map(() => '?').join(',');
        fiadores = await query(
          `SELECT * FROM Fiadores WHERE cliente_id IN (${phC}) AND deleted_at IS NULL`,
          clienteIds
        );
      }
    }

    const hoyDia = diaCobroHoy();
    const agenda = [];

    let pagos_hoy = [];
    let gestiones_hoy = [];
    if (clienteIds.length) {
      const ph2 = clienteIds.map(() => '?').join(',');
      pagos_hoy = await query(
        `SELECT pg.*, p.cliente_id,
                COALESCE(pg.registrado_por_admin, 0) AS registrado_por_admin,
                pg.operador_id
         FROM Pagos pg
         INNER JOIN Prestamos p ON pg.prestamo_id = p.id
         WHERE pg.fecha_pago >= ? AND pg.fecha_pago < ?
           AND pg.deleted_at IS NULL
           AND p.cliente_id IN (${ph2})`,
        [diaIni, diaFin, ...clienteIds]
      );
      gestiones_hoy = await query(
        `SELECT g.*, p.cliente_id
         FROM Gestiones_No_Pago g
         INNER JOIN Prestamos p ON g.prestamo_id = p.id
         WHERE g.cobrador_id = ?
           AND g.fecha_gestion >= ? AND g.fecha_gestion < ?
           AND g.deleted_at IS NULL
           AND p.cliente_id IN (${ph2})`,
        [cobradorId, diaIni, diaFin, ...clienteIds]
      );
    }

    const pagoPorPrestamo = new Map(pagos_hoy.map((pg) => [pg.prestamo_id, pg]));
    const gestionPorPrestamo = new Map(gestiones_hoy.map((g) => [g.prestamo_id, g]));
    const prestamosEnAgenda = new Set();
    const prestamoPorId = new Map(prestamos.map((p) => [p.id, p]));

    const prestamoIdsPagos = [...new Set(
      pagos_hoy.map((pg) => pg.prestamo_id).filter((id) => id && !prestamoPorId.has(id))
    )];
    if (prestamoIdsPagos.length) {
      const phP = prestamoIdsPagos.map(() => '?').join(',');
      const extraPrestamos = await query(
        `SELECT * FROM Prestamos WHERE id IN (${phP}) AND deleted_at IS NULL`,
        prestamoIdsPagos
      );
      for (const p of extraPrestamos) {
        prestamoPorId.set(p.id, p);
        if (!prestamos.some((x) => x.id === p.id)) prestamos.push(p);
      }
    }

    const pushAgendaItem = (c, p, cuotaPend, extra = {}) => {
      if (!p?.id || prestamosEnAgenda.has(p.id)) return;
      prestamosEnAgenda.add(p.id);
      const montoDiaRaw = cuotaPend
        ? Math.max(0, Number(cuotaPend.monto_programado) - Number(cuotaPend.monto_pagado || 0))
        : montoVisitaHoy(p.cuota_semanal_base, p.dias_de_cobro);
      const montoDia = capMontoAlSaldo(montoDiaRaw, p.saldo_pendiente);
      agenda.push({
        cuota_id: cuotaPend?.id || `visita-${p.id}`,
        prestamo_id: p.id,
        monto_programado: extra.monto_programado ?? montoDia,
        monto_pagado: cuotaPend?.monto_pagado || extra.monto_pagado || 0,
        fecha_programada: cuotaPend?.fecha_programada || hoy,
        estado_cuota: cuotaPend?.estado || extra.estado_cuota || 'Programada',
        cliente_id: c.id,
        nombre_completo: c.nombre_completo,
        telefono: c.telefono,
        direccion: c.direccion,
        cedula: c.cedula,
        latitud: c.latitud,
        longitud: c.longitud,
        orden_visita: c.orden_visita,
        saldo_pendiente: p.saldo_pendiente,
        cuota_semanal_base: p.cuota_semanal_base,
        dias_de_cobro: p.dias_de_cobro,
        monto_total_pagar: p.monto_total_pagar,
        estado_prestamo: p.estado,
        dia_cobro: hoyDia,
        tipo_visita: extra.tipo_visita || 'activo',
        estado_visita: extra.estado_visita
          ?? (pagoPorPrestamo.has(p.id)
            ? Number(pagoPorPrestamo.get(p.id).registrado_por_admin) === 1
              ? 'cobrado_admin'
              : 'cobrado'
            : gestionPorPrestamo.has(p.id)
              ? 'no_pago'
              : 'pendiente'),
        etiqueta_visita:
          extra.etiqueta_visita
          ?? (pagoPorPrestamo.has(p.id) && Number(pagoPorPrestamo.get(p.id).registrado_por_admin) === 1
            ? 'Cobrado por administrador'
            : null),
        pago_hoy_id: extra.pago_hoy_id ?? pagoPorPrestamo.get(p.id)?.id ?? null,
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

      const pagosCliente = pagos_hoy.filter((pg) => pg.cliente_id === c.id);
      for (const pg of pagosCliente) {
        if (prestamosEnAgenda.has(pg.prestamo_id)) continue;
        const p = prestamoPorId.get(pg.prestamo_id);
        if (!p) continue;
        const esLiquidacion = p.estado === 'Pagado' || Number(p.saldo_pendiente || 0) <= 0;
        const evPg = Number(pg.registrado_por_admin) === 1 ? 'cobrado_admin' : 'cobrado';
        pushAgendaItem(c, p, null, {
          monto_programado: Number(pg.monto_pagado),
          monto_pagado: Number(pg.monto_pagado),
          estado_cuota: 'Pagada',
          tipo_visita: esLiquidacion ? 'liquidado' : 'cobrado',
          etiqueta_visita: esLiquidacion
            ? 'Liquidación'
            : evPg === 'cobrado_admin'
              ? 'Cobrado por administrador'
              : 'Cobro registrado',
          estado_visita: evPg,
          pago_hoy_id: pg.id,
        });
      }
    }

    agenda.sort((a, b) => {
      const o = (a.orden_visita ?? 999) - (b.orden_visita ?? 999);
      if (o !== 0) return o;
      if (a.tipo_visita === 'liquidado' && b.tipo_visita === 'activo') return -1;
      if (a.tipo_visita === 'activo' && b.tipo_visita === 'liquidado') return 1;
      return String(a.prestamo_id).localeCompare(String(b.prestamo_id));
    });

    let pagos_anulados_hoy = [];
    if (clienteIds.length) {
      pagos_anulados_hoy = await query(
        `SELECT pg.id, pg.prestamo_id, pg.cobrador_id, pg.deleted_at, pg.editado_por_admin_at
         FROM Pagos pg
         INNER JOIN Prestamos p ON pg.prestamo_id = p.id
         INNER JOIN Clientes c ON p.cliente_id = c.id
         WHERE pg.deleted_at IS NOT NULL
           AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
           AND (pg.cobrador_id = ? OR c.cobrador_id = ?)`,
        [diaIni, diaFin, cobradorId, cobradorId]
      );
    }

    return res.json({
      success: true,
      serverTime: new Date().toISOString(),
      secuencia,
      dia_cobro: hoyDia,
      parametros_financieros: await leerParametrosFinancieros(query),
      data: {
        rutas,
        ruta_clientes,
        clientes,
        prestamos,
        cuotas,
        fiadores,
        garantias,
        prestamo_garantias,
        agenda,
        pagos_hoy,
        gestiones_hoy,
        pagos_anulados_hoy,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

const n = (v, fallback = 0) => (v === null || v === undefined || v === '' ? fallback : v);

const coord = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
};

const txt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
};

const registrarFiadorSync = async (
  conn,
  clienteId,
  f,
  prestamoId,
  ctx
) => {
  const fid = await upsertFiadorEnNube(conn, clienteId, f, prestamoId);
  if (!fid || !(await verificarFiadorEnNube(conn, fid))) return null;

  const localId = txt(f.id || f.fiador_id) || fid;
  if (localId !== fid) ctx.idMapFiadores[localId] = fid;
  if (!ctx.syncedFiadorIds.has(localId)) {
    ctx.syncedFiadorIds.add(localId);
    ctx.synced.fiadores.push(localId);
  }
  if (prestamoId) ctx.fiadorIdPorPrestamo[prestamoId] = fid;
  return fid;
};

/** Resuelve id de cliente en TiDB (id local, mapa o cédula). */
async function resolverClienteIdEnNube(conn, localId, idMapClientes, { cedula, cobradorId } = {}) {
  const candidatos = [];
  if (localId) {
    if (idMapClientes[localId]) candidatos.push(idMapClientes[localId]);
    candidatos.push(localId);
  }
  for (const cid of candidatos) {
    const [r] = await conn.execute(
      'SELECT id FROM Clientes WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [cid]
    );
    if (r.length) return r[0].id;
  }
  if (cedula) {
    const val = validarCedula(cedula);
    if (val.ok) {
      const [r] = await conn.execute(
        'SELECT id FROM Clientes WHERE cedula = ? AND deleted_at IS NULL LIMIT 1',
        [val.cedula]
      );
      if (r.length) {
        if (localId) idMapClientes[localId] = r[0].id;
        return r[0].id;
      }
    }
  }
  if (cobradorId && localId && esIdClienteOficial(localId)) {
    const [r] = await conn.execute(
      `SELECT id FROM Clientes WHERE id = ? AND cobrador_id = ? AND deleted_at IS NULL LIMIT 1`,
      [localId, cobradorId]
    );
    if (r.length) return r[0].id;
  }
  return null;
}

/** Si el préstamo local no existe en nube, busca el activo del cliente (p. ej. tras recarga de cartera). */
async function resolverPrestamoIdEnNube(
  conn,
  prestamoId,
  { clienteId, clienteCedula, cobradorId, idMapClientes, idMapPrestamos } = {}
) {
  if (idMapPrestamos?.[prestamoId]) return idMapPrestamos[prestamoId];
  const [ex] = await conn.execute(
    'SELECT id FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [prestamoId]
  );
  if (ex.length) return ex[0].id;

  let cid = clienteId;
  if (!cid && clienteCedula) {
    cid = await resolverClienteIdEnNube(conn, null, idMapClientes || {}, {
      cedula: clienteCedula,
      cobradorId,
    });
  }
  if (cid) {
    const [activo] = await conn.execute(
      `SELECT id FROM Prestamos
       WHERE cliente_id = ? AND estado = 'Activo' AND deleted_at IS NULL
       ORDER BY fecha_desembolso DESC LIMIT 1`,
      [cid]
    );
    if (activo.length) {
      if (idMapPrestamos && prestamoId) idMapPrestamos[prestamoId] = activo[0].id;
      return activo[0].id;
    }
  }
  return null;
}

/**
 * Push desde cobrador: clientes/prestamos primero, luego pagos y gestiones.
 */
async function pushSync(req, res) {
  const conn = await getConnection();
  let procesados = 0;
  const errores = [];
  const idMapClientes = {};
  const idMapPrestamos = {};
  const synced = {
    clientes: [],
    fiadores: [],
    prestamos: [],
    cuotas: [],
    garantias: [],
    prestamo_garantias: [],
    pagos: [],
    gestiones: [],
    renovaciones: [],
    solicitudes_correccion: [],
    cierres: [],
  };
  const idMapFiadores = {};
  const fiadorIdPorPrestamo = {};
  const syncedFiadorIds = new Set();
  const cobrosParaNotificar = [];

  try {
    await conn.beginTransaction();
    const {
      pagos = [],
      gestiones = [],
      clientes = [],
      fiadores = [],
      prestamos = [],
      cuotas = [],
      garantias = [],
      prestamo_garantias = [],
      renovaciones = [],
      cobradorId,
      cierres = [],
    } = req.body;

    await exigirUsuarioActivo(cobradorId || req.operadorId, conn);

    const hoySync = hoyISO();

    const prestamoIdsConPagos = new Set(
      pagos.map((p) => p.prestamo_id).filter(Boolean)
    );

    const prestamosNuevos = [];
    const prestamosCerrados = [];
    for (const p of prestamos) {
      if (p.estado && String(p.estado).includes('Renov')) {
        prestamosCerrados.push(p);
      } else {
        prestamosNuevos.push(p);
      }
    }

    const fiadorPorId = new Map(fiadores.filter((f) => f?.id).map((f) => [f.id, f]));

    for (const c of clientes) {
      try {
        const valCed = validarCedula(c.cedula);
        if (!valCed.ok) {
          errores.push({ tipo: 'cliente', id: c.id, error: valCed.error });
          continue;
        }
        c.cedula = valCed.cedula;
        const nc = nombreCompleto(c);
        let cobId = c.cobrador_id || cobradorId || null;
        if (cobId) {
          const [cobOk] = await conn.execute(
            'SELECT id, nombre_completo FROM Usuarios WHERE id = ? AND activo = 1 LIMIT 1',
            [cobId]
          );
          if (!cobOk.length) cobId = null;
        }

        const [byCedula] = await conn.execute('SELECT id FROM Clientes WHERE cedula = ? LIMIT 1', [c.cedula]);
        const [byId] = c.id
          ? await conn.execute('SELECT id FROM Clientes WHERE id = ? LIMIT 1', [c.id])
          : [[]];

        if (byCedula.length || byId.length) {
          const cloudId = byCedula[0]?.id || byId[0]?.id;
          await conn.execute(
            `UPDATE Clientes SET
              primer_nombre = ?, segundo_nombre = ?, primer_apellido = ?, segundo_apellido = ?,
              nombre_completo = ?, telefono = ?, direccion = ?, actividad_economica = ?,
              latitud = COALESCE(?, latitud), longitud = COALESCE(?, longitud),
              latitud_cobro = COALESCE(?, latitud_cobro), longitud_cobro = COALESCE(?, longitud_cobro),
              cobrador_id = COALESCE(?, cobrador_id), is_synced = 1, updated_at = NOW()
             WHERE id = ?`,
            [
              c.primer_nombre || null, c.segundo_nombre || null,
              c.primer_apellido || null, c.segundo_apellido || null,
              nc, c.telefono || null, c.direccion || null, c.actividad_economica || null,
              coord(c.latitud), coord(c.longitud), coord(c.latitud_cobro), coord(c.longitud_cobro),
              cobId, cloudId,
            ]
          );
          idMapClientes[c.id] = cloudId;
        } else {
          let clientId = esIdClienteOficial(c.id) ? c.id : await nextClienteId(conn);
          const [idTaken] = await conn.execute('SELECT id FROM Clientes WHERE id = ?', [clientId]);
          if (idTaken.length) clientId = await nextClienteId(conn);

          await conn.execute(
            `INSERT INTO Clientes (
              id, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
              nombre_completo, cedula, telefono, direccion, actividad_economica,
              latitud, longitud, cobrador_id, is_synced
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              clientId,
              c.primer_nombre || null, c.segundo_nombre || null,
              c.primer_apellido || null, c.segundo_apellido || null,
              nc, c.cedula, c.telefono || null, c.direccion || null, c.actividad_economica || null,
              coord(c.latitud), coord(c.longitud), cobId,
            ]
          );
          idMapClientes[c.id] = clientId;

          if (cobId) {
            const [cobRow] = await conn.execute(
              'SELECT nombre_completo FROM Usuarios WHERE id = ? LIMIT 1',
              [cobId]
            );
            await sincronizarRutaClienteAsignado(clientId, cobId, cobRow[0]?.nombre_completo, conn);
          }
        }
        synced.clientes.push(c.id);
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'cliente', id: c.id, message: err.message });
      }
    }

    for (const p of prestamosCerrados) {
      try {
        await conn.execute(
          `UPDATE Prestamos SET estado = ?, saldo_pendiente = 0, is_synced = 1, updated_at = NOW() WHERE id = ?`,
          [p.estado || 'Cerrado por Renovación', p.id]
        );
        synced.prestamos.push(p.id);
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'prestamo_cierre', id: p.id, message: err.message });
      }
    }

    for (const p of prestamosNuevos) {
      try {
        const clienteId = await resolverClienteIdEnNube(conn, p.cliente_id, idMapClientes, {
          cedula: p.cliente_cedula,
          cobradorId,
        });
        if (!clienteId) {
          throw new Error(
            `Cliente ${p.cliente_id || p.cliente_cedula || '?'} no existe en TiDB. Sincronice el cliente primero.`
          );
        }

        const tieneFiador = !!txt(p.fiador_id);
        let fiadorId = null;
        if (tieneFiador) {
          const datosFiador = fiadorPorId.get(p.fiador_id) || { id: p.fiador_id, fiador_id: p.fiador_id };
          fiadorId = await registrarFiadorSync(conn, clienteId, datosFiador, p.id, {
            synced,
            idMapFiadores,
            fiadorIdPorPrestamo,
            syncedFiadorIds,
          });
          if (!fiadorId) {
            fiadorId = await upsertFiadorEnNube(conn, clienteId, datosFiador, p.id);
            if (fiadorId && (await verificarFiadorEnNube(conn, fiadorId))) {
              const localId = txt(p.fiador_id) || fiadorId;
              if (localId !== fiadorId) idMapFiadores[localId] = fiadorId;
              syncedFiadorIds.add(localId);
              synced.fiadores.push(localId);
              fiadorIdPorPrestamo[p.id] = fiadorId;
            } else {
              fiadorId = null;
            }
          }
        }
        if (tieneFiador && !fiadorId) {
          throw new Error('No se pudo guardar el fiador en la tabla Fiadores de TiDB.');
        }
        const dias =
          typeof p.dias_de_cobro === 'string' ? p.dias_de_cobro : JSON.stringify(p.dias_de_cobro || ['LUNES']);

        const estadoPrestamo = p.estado || 'Activo';
        if (estadoPrestamo === 'Activo') {
          const [otroActivo] = await conn.execute(
            `SELECT id FROM Prestamos
             WHERE cliente_id = ? AND estado = 'Activo' AND id != ? AND deleted_at IS NULL
             LIMIT 1`,
            [clienteId, p.id]
          );
          if (otroActivo.length) {
            throw new Error('Este cliente ya tiene un credito activo. No puede tener dos prestamos pendientes.');
          }
        }

        const [ex] = await conn.execute('SELECT id FROM Prestamos WHERE id = ?', [p.id]);
        if (ex.length) {
          const omitirSaldo = prestamoIdsConPagos.has(p.id);
          if (omitirSaldo) {
            await conn.execute(
              `UPDATE Prestamos SET
                cliente_id = ?, fiador_id = ?,
                monto_desembolsado = COALESCE(?, monto_desembolsado),
                plazo_semanas = COALESCE(?, plazo_semanas),
                tasa_interes_aplicada = COALESCE(?, tasa_interes_aplicada),
                cuota_semanal_base = COALESCE(?, cuota_semanal_base),
                monto_total_pagar = COALESCE(?, monto_total_pagar),
                frecuencia_semana = COALESCE(?, frecuencia_semana),
                dias_de_cobro = COALESCE(?, dias_de_cobro),
                estado = COALESCE(?, estado),
                fecha_desembolso = COALESCE(?, fecha_desembolso),
                renovacion_previa_id = COALESCE(?, renovacion_previa_id),
                numero_recibo_fisico = COALESCE(?, numero_recibo_fisico),
                cobrador_registro_id = COALESCE(?, cobrador_registro_id),
                cobrador_entrega_id = COALESCE(?, cobrador_entrega_id),
                is_synced = 1, updated_at = NOW()
               WHERE id = ?`,
              [
                clienteId,
                fiadorId,
                p.monto_desembolsado,
                p.plazo_semanas,
                p.tasa_interes_aplicada,
                p.cuota_semanal_base,
                p.monto_total_pagar,
                p.frecuencia_semana,
                dias,
                p.estado || 'Activo',
                p.fecha_desembolso,
                p.renovacion_previa_id || null,
                p.numero_recibo_fisico || null,
                p.cobrador_registro_id || null,
                p.cobrador_entrega_id || null,
                p.id,
              ]
            );
          } else {
            await conn.execute(
              `UPDATE Prestamos SET
                cliente_id = ?, fiador_id = ?,
                monto_desembolsado = COALESCE(?, monto_desembolsado),
                plazo_semanas = COALESCE(?, plazo_semanas),
                tasa_interes_aplicada = COALESCE(?, tasa_interes_aplicada),
                cuota_semanal_base = COALESCE(?, cuota_semanal_base),
                monto_total_pagar = COALESCE(?, monto_total_pagar),
                saldo_pendiente = COALESCE(?, saldo_pendiente),
                frecuencia_semana = COALESCE(?, frecuencia_semana),
                dias_de_cobro = COALESCE(?, dias_de_cobro),
                estado = COALESCE(?, estado),
                fecha_desembolso = COALESCE(?, fecha_desembolso),
                renovacion_previa_id = COALESCE(?, renovacion_previa_id),
                numero_recibo_fisico = COALESCE(?, numero_recibo_fisico),
                cobrador_registro_id = COALESCE(?, cobrador_registro_id),
                cobrador_entrega_id = COALESCE(?, cobrador_entrega_id),
                is_synced = 1, updated_at = NOW()
               WHERE id = ?`,
              [
                clienteId,
                fiadorId,
                p.monto_desembolsado,
                p.plazo_semanas,
                p.tasa_interes_aplicada,
                p.cuota_semanal_base,
                p.monto_total_pagar,
                p.saldo_pendiente,
                p.frecuencia_semana,
                dias,
                p.estado || 'Activo',
                p.fecha_desembolso,
                p.renovacion_previa_id || null,
                p.numero_recibo_fisico || null,
                p.cobrador_registro_id || null,
                p.cobrador_entrega_id || null,
                p.id,
              ]
            );
          }
        } else {
          await conn.execute(
            `INSERT INTO Prestamos (
              id, cliente_id, fiador_id,
              monto_desembolsado, plazo_semanas, tasa_interes_aplicada,
              cuota_semanal_base, monto_total_pagar, saldo_pendiente, frecuencia_semana,
              dias_de_cobro, periodicidad, estado, fecha_desembolso, renovacion_previa_id,
              numero_recibo_fisico, cobrador_registro_id, cobrador_entrega_id, is_synced
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SEMANAL', ?, ?, ?, ?, ?, ?, 1)`,
            [
              p.id,
              clienteId,
              fiadorId,
              p.monto_desembolsado,
              p.plazo_semanas,
              p.tasa_interes_aplicada,
              p.cuota_semanal_base || 0,
              p.monto_total_pagar,
              p.saldo_pendiente,
              p.frecuencia_semana || 1,
              dias,
              p.estado || 'Activo',
              p.fecha_desembolso,
              p.renovacion_previa_id || null,
              p.numero_recibo_fisico || null,
              p.cobrador_registro_id || null,
              p.cobrador_entrega_id || null,
            ]
          );
        }
        synced.prestamos.push(p.id);
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'prestamo', id: p.id, message: err.message });
      }
    }

    for (const f of fiadores) {
      try {
        const clienteId = await resolverClienteIdEnNube(conn, f.cliente_id, idMapClientes, {
          cedula: f.cliente_cedula,
          cobradorId,
        });
        if (!clienteId) {
          throw new Error(`Cliente ${f.cliente_id || f.cliente_cedula || '?'} no existe en TiDB para fiador.`);
        }
        const localKey = txt(f.id) || `tmp-${f.cedula}`;
        if (syncedFiadorIds.has(localKey) || (f.id && syncedFiadorIds.has(f.id))) {
          procesados++;
          continue;
        }
        const fid = await registrarFiadorSync(conn, clienteId, f, null, {
          synced,
          idMapFiadores,
          fiadorIdPorPrestamo,
          syncedFiadorIds,
        });
        if (!fid) {
          throw new Error('No se pudo crear el fiador en TiDB.');
        }
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'fiador', id: f.id, message: err.message });
      }
    }

    if (cuotas.length) {
      const existentes = new Set();
      const idsCuota = cuotas.map((c) => c.id).filter(Boolean);
      for (let i = 0; i < idsCuota.length; i += 200) {
        const slice = idsCuota.slice(i, i + 200);
        const ph = slice.map(() => '?').join(',');
        const [rows] = await conn.execute(
          `SELECT id FROM Cuotas_Calendario WHERE id IN (${ph})`,
          slice
        );
        for (const r of rows) existentes.add(r.id);
      }
      const nuevas = [];
      for (const cc of cuotas) {
        if (existentes.has(cc.id)) {
          synced.cuotas.push(cc.id);
          continue;
        }
        nuevas.push(cc);
      }
      try {
        await insertMany(
          conn,
          {
            insert:
              'INSERT INTO Cuotas_Calendario (id, prestamo_id, fecha_programada, monto_programado, estado, is_synced)',
            placeholder: '(?, ?, ?, ?, ?, 1)',
            values: (cc) => [
              cc.id,
              cc.prestamo_id,
              cc.fecha_programada,
              cc.monto_programado,
              cc.estado || 'Programada',
            ],
          },
          nuevas,
          120
        );
        for (const cc of nuevas) {
          synced.cuotas.push(cc.id);
          procesados += 1;
        }
      } catch (err) {
        errores.push({ tipo: 'cuota_bulk', id: null, message: err.message });
      }
    }

    for (const g of garantias) {
      try {
        const [ex] = await conn.execute('SELECT id FROM Garantias WHERE id = ?', [g.id]);
        if (ex.length) {
          synced.garantias.push(g.id);
          continue;
        }
        const clienteId = idMapClientes[g.cliente_id] || g.cliente_id;
        await conn.execute(
          `INSERT INTO Garantias (id, cliente_id, tipo_articulo, marca, numero_serie, valor_estimado, estado, is_synced)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            g.id,
            clienteId,
            g.tipo_articulo,
            g.marca || null,
            g.numero_serie || null,
            g.valor_estimado,
            g.estado || 'Comprometida',
          ]
        );
        synced.garantias.push(g.id);
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'garantia', id: g.id, message: err.message });
      }
    }

    for (const pg of prestamo_garantias) {
      try {
        const [prestamoOk] = await conn.execute('SELECT id FROM Prestamos WHERE id = ? LIMIT 1', [
          pg.prestamo_id,
        ]);
        const [garantiaOk] = await conn.execute('SELECT id FROM Garantias WHERE id = ? LIMIT 1', [
          pg.garantia_id,
        ]);
        if (!prestamoOk.length || !garantiaOk.length) {
          errores.push({
            tipo: 'prestamo_garantia',
            id: `${pg.prestamo_id}-${pg.garantia_id}`,
            message: 'Prestamo o garantia aun no estan en nube; se omitio el vinculo.',
          });
          continue;
        }
        await conn.execute(
          `INSERT INTO Prestamo_Garantias (prestamo_id, garantia_id) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE prestamo_id = prestamo_id`,
          [pg.prestamo_id, pg.garantia_id]
        );
        synced.prestamo_garantias.push(`${pg.prestamo_id}-${pg.garantia_id}`);
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'prestamo_garantia', id: `${pg.prestamo_id}-${pg.garantia_id}`, message: err.message });
      }
    }

    for (const p of pagos) {
      try {
        const [ex] = await conn.execute(
          'SELECT id, deleted_at, prestamo_id FROM Pagos WHERE id = ?',
          [p.id]
        );
        if (ex.length) {
          if (ex[0].deleted_at) {
            errores.push({
              tipo: 'pago',
              id: p.id,
              code: 'pago_anulado_en_nube',
              prestamo_id: ex[0].prestamo_id || p.prestamo_id,
              message: 'Este cobro fue anulado por el administrador.',
            });
          } else {
            synced.pagos.push(p.id);
          }
          continue;
        }

        const prestamoIdNube = await resolverPrestamoIdEnNube(conn, p.prestamo_id, {
          clienteId: idMapClientes[p.cliente_id] || p.cliente_id,
          clienteCedula: p.cliente_cedula,
          cobradorId: p.cobrador_id || cobradorId,
          idMapClientes,
          idMapPrestamos,
        });
        if (!prestamoIdNube) {
          throw new Error(`Prestamo ${p.prestamo_id} no existe en TiDB aun.`);
        }
        const [prestamoOk] = await conn.execute(
          'SELECT * FROM Prestamos WHERE id = ? AND deleted_at IS NULL LIMIT 1',
          [prestamoIdNube]
        );
        if (!prestamoOk.length) {
          throw new Error(`Prestamo ${p.prestamo_id} no existe en TiDB aun.`);
        }
        const prestamo = prestamoOk[0];
        const prestamoIdPago = prestamoIdNube;

        const { inicio, fin } = rangoDiaLocal(p.fecha_pago || new Date());
        const [cobroHoy] = await conn.execute(
          `SELECT id, registrado_por_admin, operador_id FROM Pagos
           WHERE prestamo_id = ? AND cobrador_id = ? AND deleted_at IS NULL
             AND fecha_pago >= ? AND fecha_pago < ?
           LIMIT 1`,
          [prestamoIdPago, p.cobrador_id, inicio, fin]
        );
        if (cobroHoy.length) {
          errores.push({
            tipo: 'pago',
            id: p.id,
            code: 'cobro_ya_registrado',
            message:
              Number(cobroHoy[0].registrado_por_admin) === 1
                ? 'Este credito ya fue cobrado hoy por el administrador.'
                : 'Este credito ya tiene un cobro registrado hoy.',
            prestamo_id: prestamoIdPago,
            pago_existente_id: cobroHoy[0].id,
          });
          continue;
        }

        const montoEfectivo = Number(p.monto_pagado);
        if (montoEfectivo <= 0) throw new Error('Monto invalido');

        const [pagadoRows] = await conn.execute(
          `SELECT COALESCE(SUM(monto_pagado), 0) AS total FROM Pagos
           WHERE prestamo_id = ? AND deleted_at IS NULL`,
          [prestamoIdPago]
        );
        const pagadoAcumulado = Number(pagadoRows[0]?.total || 0);
        const liq = calcularLiquidacionAnticipada(prestamo, new Date(p.fecha_pago || new Date()), {
          pagadoAcumulado,
        });
        const esLiquidacion = Math.abs(montoEfectivo - liq.montoLiquidacion) < 0.02;

        if (!esLiquidacion && montoEfectivo > Number(prestamo.saldo_pendiente) + 0.01) {
          errores.push({
            tipo: 'pago',
            id: p.id,
            code: 'monto_supera_saldo',
            prestamo_id: p.prestamo_id,
            saldo_nube: Number(prestamo.saldo_pendiente),
            message: `Monto supera saldo pendiente (C$ ${Number(prestamo.saldo_pendiente).toFixed(2)})`,
          });
          continue;
        }

        await conn.execute(
          `INSERT INTO Pagos (id, prestamo_id, cobrador_id, monto_pagado, fecha_pago, latitud, longitud,
            registrado_por_admin, operador_id, is_synced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            p.id,
            prestamoIdPago,
            p.cobrador_id,
            montoEfectivo,
            p.fecha_pago,
            n(p.latitud, 0),
            n(p.longitud, 0),
            p.registrado_por_admin ? 1 : 0,
            p.operador_id || p.cobrador_id,
          ]
        );

        if (esLiquidacion) {
          await aplicarMontoACuotas(conn, prestamoIdPago, montoEfectivo);
          await conn.execute(
            `UPDATE Prestamos SET saldo_pendiente = 0,
              monto_total_pagar = ?,
              estado = 'Pagado', updated_at = NOW(), is_synced = 1
             WHERE id = ?`,
            [
              Number(
                (
                  Number(prestamo.monto_total_pagar) -
                  Number(prestamo.saldo_pendiente) +
                  montoEfectivo
                ).toFixed(2)
              ),
              prestamoIdPago,
            ]
          );
          await sincronizarCuotasTrasCierrePagado(conn, prestamoIdPago);
        } else {
          await aplicarMontoACuotas(conn, prestamoIdPago, montoEfectivo);
          const nuevoSaldo = Math.max(
            0,
            Number((Number(prestamo.saldo_pendiente) - montoEfectivo).toFixed(2))
          );
          const estadoPrestamo = nuevoSaldo <= 0 ? 'Pagado' : 'Activo';
          await conn.execute(
            `UPDATE Prestamos SET saldo_pendiente = ?, estado = ?, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
            [nuevoSaldo, estadoPrestamo, prestamoIdPago]
          );
          if (estadoPrestamo === 'Pagado') {
            await sincronizarCuotasTrasCierrePagado(conn, prestamoIdPago);
          }
        }

        synced.pagos.push(p.id);
        if (!Number(p.registrado_por_admin)) {
          cobrosParaNotificar.push({
            prestamo_id: prestamoIdPago,
            cobrador_id: p.cobrador_id,
            monto: montoEfectivo,
            liquidacion: esLiquidacion,
          });
        }
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'pago', id: p.id, message: err.message });
      }
    }

    for (const g of gestiones) {
      try {
        const [ex] = await conn.execute('SELECT id FROM Gestiones_No_Pago WHERE id = ?', [g.id]);
        if (ex.length) {
          synced.gestiones.push(g.id);
          continue;
        }
        await conn.execute(
          `INSERT INTO Gestiones_No_Pago (id, prestamo_id, cobrador_id, motivo, fecha_gestion, latitud, longitud,
            registrado_por_admin, operador_id, is_synced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            g.id,
            g.prestamo_id,
            g.cobrador_id,
            g.motivo,
            g.fecha_gestion,
            n(g.latitud, 0),
            n(g.longitud, 0),
            g.registrado_por_admin ? 1 : 0,
            g.operador_id || g.cobrador_id,
          ]
        );
        synced.gestiones.push(g.id);
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'gestion', id: g.id, message: err.message });
      }
    }

    for (const r of renovaciones) {
      try {
        const [ex] = await conn.execute('SELECT id FROM Renovaciones_Log WHERE id = ?', [r.id]);
        if (ex.length) {
          await conn.execute(
            `UPDATE Renovaciones_Log SET
              cobrador_opero_id = COALESCE(?, cobrador_opero_id),
              cobrador_entrega_id = COALESCE(?, cobrador_entrega_id),
              plazo_semanas = COALESCE(?, plazo_semanas),
              efectivo_entregar = COALESCE(?, efectivo_entregar),
              is_synced = 1, updated_at = NOW()
             WHERE id = ?`,
            [
              r.cobrador_opero_id || null,
              r.cobrador_entrega_id || null,
              r.plazo_semanas ?? null,
              r.efectivo_entregar ?? null,
              r.id,
            ]
          );
          synced.renovaciones.push(r.id);
          continue;
        }
        await conn.execute(
          `INSERT INTO Renovaciones_Log (
            id, prestamo_anterior_id, prestamo_nuevo_id, saldo_pendiente_anterior,
            nuevo_desembolso, base_nominal, tasa_aplicada, monto_total_a_pagar,
            cuota_semanal, fecha_renovacion, cobrador_opero_id, cobrador_entrega_id,
            plazo_semanas, efectivo_entregar, is_synced
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            r.id,
            r.prestamo_anterior_id,
            r.prestamo_nuevo_id,
            r.saldo_pendiente_anterior,
            r.nuevo_desembolso,
            r.base_nominal,
            r.tasa_aplicada,
            r.monto_total_a_pagar,
            r.cuota_semanal,
            r.fecha_renovacion,
            r.cobrador_opero_id || null,
            r.cobrador_entrega_id || null,
            r.plazo_semanas ?? null,
            r.efectivo_entregar ?? null,
          ]
        );
        synced.renovaciones.push(r.id);
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'renovacion', id: r.id, message: err.message });
      }
    }

    const reparadosFiadores = await repararFiadoresHistoricos(conn);
    if (reparadosFiadores > 0) {
      procesados += reparadosFiadores;
    }

    for (const cc of cierres) {
      try {
        const cobId = cc.cobrador_id || cobradorId;
        const [ex] = await conn.execute('SELECT id FROM Cierre_Caja WHERE id = ? LIMIT 1', [cc.id]);
        if (ex.length) {
          synced.cierres.push(cc.id);
          continue;
        }
        const fechaCierre = String(cc.fecha_cierre || hoySync).slice(0, 10);
        const [dupDia] = await conn.execute(
          `SELECT id, monto_efectivo, transacciones FROM Cierre_Caja
           WHERE cobrador_id = ? AND deleted_at IS NULL
             AND ${whereCierreCalendarioDia('fecha_cierre')}
           LIMIT 1`,
          [cobId, fechaCierre]
        );
        if (dupDia.length) {
          errores.push({
            tipo: 'cierre_caja',
            id: cc.id,
            message: `Ya existe un cierre de caja registrado para ${fechaCierre}.`,
            cierre_existente: dupDia[0],
          });
          continue;
        }
        await conn.execute(
          `INSERT INTO Cierre_Caja (id, cobrador_id, fecha_cierre, monto_efectivo, transacciones, observaciones, latitud, longitud, is_synced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            cc.id,
            cc.cobrador_id || cobradorId,
            fechaCierre,
            cc.monto_efectivo,
            cc.transacciones || 0,
            cc.observaciones || null,
            cc.latitud ?? null,
            cc.longitud ?? null,
          ]
        );
        synced.cierres.push(cc.id);
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'cierre_caja', id: cc.id, message: err.message });
      }
    }

    for (const s of req.body.solicitudes_correccion || []) {
      try {
        const [ex] = await conn.execute(
          'SELECT id FROM Solicitudes_Correccion_Cobro WHERE id = ? LIMIT 1',
          [s.id]
        );
        if (ex.length) {
          synced.solicitudes_correccion.push(s.id);
          continue;
        }
        const [pagoOk] = await conn.execute(
          'SELECT id, cobrador_id FROM Pagos WHERE id = ? AND deleted_at IS NULL LIMIT 1',
          [s.pago_id]
        );
        if (!pagoOk.length) {
          throw new Error(`Pago ${s.pago_id} no existe en nube.`);
        }
        await conn.execute(
          `INSERT INTO Solicitudes_Correccion_Cobro
            (id, pago_id, cobrador_id, prestamo_id, cliente_nombre, monto_registrado, motivo, estado)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDIENTE')`,
          [
            s.id,
            s.pago_id,
            s.cobrador_id || pagoOk[0].cobrador_id,
            s.prestamo_id || null,
            s.cliente_nombre || null,
            s.monto_registrado ?? null,
            s.motivo,
          ]
        );
        synced.solicitudes_correccion.push(s.id);
        procesados++;
      } catch (err) {
        errores.push({ tipo: 'solicitud_correccion', id: s.id, message: err.message });
      }
    }

    await conn.commit();

    if (cobrosParaNotificar.length) {
      const lote = [...cobrosParaNotificar];
      setImmediate(() => {
        void (async () => {
          try {
            const ids = [...new Set(lote.map((c) => c.prestamo_id))];
            const ph = ids.map(() => '?').join(',');
            const meta = await query(
              `SELECT p.id AS prestamo_id, c.nombre_completo AS cliente_nombre, u.nombre_completo AS cobrador_nombre
               FROM Prestamos p
               INNER JOIN Clientes c ON p.cliente_id = c.id
               LEFT JOIN Usuarios u ON u.id = (
                 SELECT pg.cobrador_id FROM Pagos pg WHERE pg.prestamo_id = p.id ORDER BY pg.fecha_pago DESC LIMIT 1
               )
               WHERE p.id IN (${ph})`,
              ids
            );
            const mapMeta = new Map(meta.map((r) => [r.prestamo_id, r]));
            const enriched = lote.map((c) => {
              const m = mapMeta.get(c.prestamo_id);
              return {
                monto: c.monto,
                liquidacion: c.liquidacion,
                clienteNombre: m?.cliente_nombre,
                cobradorNombre: m?.cobrador_nombre,
              };
            });
            await notificarAdminsCobrosCobrador(query, enriched);
          } catch (e) {
            console.warn('[notify admins cobro]', e.message);
          }
        })();
      });
    }

    return res.json({
      success: errores.length === 0,
      procesados,
      idMapClientes,
      idMapFiadores: Object.keys(idMapFiadores).length ? idMapFiadores : undefined,
      idMapPrestamos: Object.keys(idMapPrestamos).length ? idMapPrestamos : undefined,
      fiadorIdPorPrestamo: Object.keys(fiadorIdPorPrestamo).length ? fiadorIdPorPrestamo : undefined,
      synced,
      errores: errores.length ? errores : undefined,
      message: errores.length ? errores[0].message : undefined,
    });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'cuenta_inactiva' || e.status === 403) {
      return responderErrorUsuario(res, e);
    }
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

/** Parche ligero: pagos corregidos o registrados por admin + préstamos/cuotas afectados. */
async function cargarCorreccionesAdmin(cobradorId, desde) {
  const desdeTs = desdeCorreccionesUnix(desde);
  const pagos = await query(
    `SELECT pg.id, pg.prestamo_id, pg.cobrador_id, pg.monto_pagado, pg.fecha_pago,
            pg.latitud, pg.longitud, pg.registrado_por_admin, pg.operador_id,
            pg.updated_at, pg.editado_por_admin_at, pg.deleted_at
     FROM Pagos pg
     INNER JOIN Prestamos p ON pg.prestamo_id = p.id
     INNER JOIN Clientes c ON p.cliente_id = c.id
     WHERE (pg.cobrador_id = ? OR c.cobrador_id = ?)
       AND (
         UNIX_TIMESTAMP(COALESCE(pg.editado_por_admin_at, pg.deleted_at)) > ?
         OR (pg.registrado_por_admin = 1 AND UNIX_TIMESTAMP(pg.updated_at) > ?)
         OR (pg.deleted_at IS NOT NULL AND UNIX_TIMESTAMP(pg.deleted_at) > ?)
       )
     ORDER BY COALESCE(pg.editado_por_admin_at, pg.deleted_at, pg.updated_at) ASC`,
    [cobradorId, cobradorId, desdeTs, desdeTs, desdeTs]
  );

  if (!pagos.length) {
    return { pagos: [], prestamos: [], cuotas: [] };
  }

  const prestamoIds = [...new Set(pagos.map((p) => p.prestamo_id))];
  const ph = prestamoIds.map(() => '?').join(',');

  const prestamos = await query(
    `SELECT p.id, p.cliente_id, p.saldo_pendiente, p.estado, p.cuota_semanal_base,
            p.monto_total_pagar, p.monto_desembolsado, p.plazo_semanas,
            p.tasa_interes_aplicada, p.dias_de_cobro, p.frecuencia_semana,
            p.fecha_desembolso, p.fiador_id, p.cobrador_registro_id, p.cobrador_entrega_id,
            p.numero_recibo_fisico, p.updated_at
     FROM Prestamos p
     WHERE p.id IN (${ph}) AND p.deleted_at IS NULL`,
    prestamoIds
  );

  const cuotas = await query(
    `SELECT id, prestamo_id, fecha_programada, monto_programado, monto_pagado,
            estado, cobrador_id, updated_at
     FROM Cuotas_Calendario
     WHERE prestamo_id IN (${ph}) AND deleted_at IS NULL
     ORDER BY fecha_programada ASC`,
    prestamoIds
  );

  return { pagos, prestamos, cuotas };
}

/** IDs de pagos activos/anulados hoy — para reconciliar SQLite del cobrador sin descargar ruta completa. */
async function cargarSnapshotPagosHoy(cobradorId) {
  const hoy = hoyISO();
  const { inicio: diaIni, fin: diaFin } = rangoDiaLocal(hoy);

  const pagos_hoy = await query(
    `SELECT pg.id, pg.prestamo_id, pg.cobrador_id, pg.monto_pagado, pg.fecha_pago,
            pg.registrado_por_admin, pg.operador_id
     FROM Pagos pg
     INNER JOIN Prestamos p ON pg.prestamo_id = p.id
     INNER JOIN Clientes c ON p.cliente_id = c.id
     WHERE pg.fecha_pago >= ? AND pg.fecha_pago < ?
       AND pg.deleted_at IS NULL
       AND (pg.cobrador_id = ? OR c.cobrador_id = ?)`,
    [diaIni, diaFin, cobradorId, cobradorId]
  );

  const pagos_anulados_hoy = await query(
    `SELECT pg.id, pg.prestamo_id, pg.cobrador_id, pg.deleted_at, pg.editado_por_admin_at
     FROM Pagos pg
     INNER JOIN Prestamos p ON pg.prestamo_id = p.id
     INNER JOIN Clientes c ON p.cliente_id = c.id
     WHERE pg.deleted_at IS NOT NULL
       AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
       AND (pg.cobrador_id = ? OR c.cobrador_id = ?)`,
    [diaIni, diaFin, cobradorId, cobradorId]
  );

  return { pagos_hoy, pagos_anulados_hoy };
}

async function getCorreccionesAdmin(req, res) {
  try {
    const { cobradorId } = req.params;
    await exigirUsuarioActivo(cobradorId);
    const desde = req.query.desde || '1970-01-01T00:00:00.000Z';

    const { pagos, prestamos, cuotas } = await cargarCorreccionesAdmin(cobradorId, desde);
    const serverTime = new Date().toISOString();
    return res.json({ success: true, serverTime, pagos, prestamos, cuotas });
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

/** Aviso ligero (+ opcional parche correcciones en la misma petición con ?aplicar=1). */
async function syncAviso(req, res) {
  try {
    const { cobradorId } = req.params;
    const desde = req.query.desde || '1970-01-01T00:00:00.000Z';
    const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true';
    const desdeTs = desdeCorreccionesUnix(desde);

    const correcciones = await query(
      `SELECT COUNT(*) AS n FROM Pagos pg
       INNER JOIN Prestamos p ON pg.prestamo_id = p.id
       INNER JOIN Clientes c ON p.cliente_id = c.id
       WHERE (pg.cobrador_id = ? OR c.cobrador_id = ?)
         AND (
           UNIX_TIMESTAMP(COALESCE(pg.editado_por_admin_at, pg.deleted_at)) > ?
           OR (pg.registrado_por_admin = 1 AND UNIX_TIMESTAMP(pg.updated_at) > ?)
           OR (pg.deleted_at IS NOT NULL AND UNIX_TIMESTAMP(pg.deleted_at) > ?)
         )`,
      [cobradorId, cobradorId, desdeTs, desdeTs, desdeTs]
    );

    const n = Number(correcciones[0]?.n || 0);
    const serverTime = new Date().toISOString();
    const base = {
      success: true,
      serverTime,
      correccionesAdmin: n,
      requiereReinicioSesion: false,
      requiereActualizacion: n > 0,
      pagos: [],
      prestamos: [],
      cuotas: [],
    };

    if (aplicar && n > 0) {
      const payload = await cargarCorreccionesAdmin(cobradorId, desde);
      const snapshot = await cargarSnapshotPagosHoy(cobradorId);
      return res.json({ ...base, ...payload, ...snapshot });
    }

    if (aplicar) {
      const snapshot = await cargarSnapshotPagosHoy(cobradorId);
      return res.json({ ...base, ...snapshot });
    }

    return res.json(base);
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

/** Cobrador reporta monto incorrecto — notifica al administrador */
async function crearSolicitudCorreccion(req, res) {
  const conn = await getConnection();
  try {
    const s = req.body;
    if (!s.pago_id || !txt(s.motivo)) {
      return res.status(400).json({ success: false, message: 'pago_id y motivo son requeridos' });
    }

    const [pagoOk] = await conn.execute(
      `SELECT pg.id, pg.cobrador_id, pg.prestamo_id, pg.monto_pagado, c.nombre_completo
       FROM Pagos pg
       JOIN Prestamos p ON pg.prestamo_id = p.id
       JOIN Clientes c ON p.cliente_id = c.id
       WHERE pg.id = ? AND pg.deleted_at IS NULL LIMIT 1`,
      [s.pago_id]
    );
    if (!pagoOk.length) {
      return res.status(404).json({ success: false, message: 'Pago no encontrado' });
    }
    const pago = pagoOk[0];
    const cobradorId = s.cobrador_id || pago.cobrador_id;
    await exigirUsuarioActivo(cobradorId || req.operadorId, conn);
    const id = txt(s.id) || `sol-${Date.now()}`;

    await conn.beginTransaction();
    const [ex] = await conn.execute(
      `SELECT id FROM Solicitudes_Correccion_Cobro
       WHERE pago_id = ? AND estado = 'PENDIENTE' AND deleted_at IS NULL LIMIT 1`,
      [s.pago_id]
    );
    if (ex.length) {
      await conn.execute(
        `UPDATE Solicitudes_Correccion_Cobro SET motivo = ?, updated_at = NOW() WHERE id = ?`,
        [String(s.motivo).trim(), ex[0].id]
      );
      await conn.commit();
      return res.json({ success: true, id: ex[0].id, duplicado: true });
    }

    await conn.execute(
      `INSERT INTO Solicitudes_Correccion_Cobro
        (id, pago_id, cobrador_id, prestamo_id, cliente_nombre, monto_registrado, motivo, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDIENTE')`,
      [
        id,
        s.pago_id,
        cobradorId,
        s.prestamo_id || pago.prestamo_id,
        s.cliente_nombre || pago.nombre_completo,
        s.monto_registrado ?? pago.monto_pagado,
        String(s.motivo).trim(),
      ]
    );
    await conn.commit();
    return res.json({ success: true, id });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'cuenta_inactiva' || e.status === 403) {
      return responderErrorUsuario(res, e);
    }
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function listPrestamosCobrador(req, res) {
  try {
    const { cobradorId } = req.params;
    await exigirUsuarioActivo(cobradorId);
    const rows = await query(
      `SELECT p.*, c.nombre_completo, c.cedula, c.telefono,
              (SELECT COUNT(*) FROM Cuotas_Calendario cc
               WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL
                 AND cc.estado IN ('Programada', 'Parcial')) AS cuotas_pendientes
       FROM Prestamos p
       JOIN Clientes c ON p.cliente_id = c.id AND c.deleted_at IS NULL
       WHERE p.estado = 'Activo' AND p.deleted_at IS NULL AND c.cobrador_id = ?
       ORDER BY c.nombre_completo`,
      [cobradorId]
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

async function aplicarProrrogaCobrador(req, res) {
  const conn = await getConnection();
  try {
    const { cobradorId } = req.params;
    await exigirUsuarioActivo(cobradorId, conn);
    const [prest] = await conn.execute(
      `SELECT p.id FROM Prestamos p
       JOIN Clientes c ON p.cliente_id = c.id
       WHERE p.id = ? AND c.cobrador_id = ? AND p.estado = 'Activo' AND p.deleted_at IS NULL
       LIMIT 1`,
      [req.body.prestamo_id, cobradorId]
    );
    if (!prest.length) {
      return res.status(403).json({ success: false, message: 'Préstamo no asignado a este cobrador.' });
    }
    await conn.beginTransaction();
    const resultado = await aplicarProrrogaEnNube(conn, {
      prestamo_id: req.body.prestamo_id,
      semanas_extra: req.body.semanas_extra,
      comentario: req.body.comentario || 'Prórroga cobrador',
      operador_id: req.operadorId || cobradorId,
    });
    await conn.commit();
    return res.json({ success: true, data: resultado });
  } catch (e) {
    await conn.rollback();
    return res.status(400).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
}

async function pagosPorFecha(req, res) {
  try {
    const { cobradorId } = req.params;
    await exigirUsuarioActivo(cobradorId);
    const fecha = req.query.fecha || hoyISO();
    const { inicio, fin } = rangoDiaLocal(fecha);
    const rows = await query(
      `SELECT pg.id, pg.prestamo_id, pg.cobrador_id, pg.monto_pagado, pg.fecha_pago,
              pg.registrado_por_admin, pg.operador_id, pg.editado_por_admin_at,
              c.id AS cliente_id, c.nombre_completo, c.cedula, c.telefono,
              p.saldo_pendiente, p.fecha_desembolso, p.plazo_semanas, p.dias_de_cobro,
              u.nombre_completo AS cobrador_nombre
       FROM Pagos pg
       INNER JOIN Prestamos p ON pg.prestamo_id = p.id
       INNER JOIN Clientes c ON p.cliente_id = c.id
       LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
       WHERE pg.deleted_at IS NULL AND pg.cobrador_id = ?
         AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
       ORDER BY pg.fecha_pago DESC`,
      [cobradorId, inicio, fin]
    );
    return res.json({ success: true, data: rows, fecha });
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

/** Cierre de caja registrado en nube para el cobrador (fecha opcional). */
async function cierreHoy(req, res) {
  try {
    const { cobradorId } = req.params;
    await exigirUsuarioActivo(cobradorId);
    const fecha = String(req.query.fecha || hoyISO()).slice(0, 10);
    const rows = await query(
      `SELECT id, fecha_cierre, monto_efectivo, transacciones
       FROM Cierre_Caja
       WHERE cobrador_id = ? AND deleted_at IS NULL
         AND ${whereCierreCalendarioDia('fecha_cierre')}
       ORDER BY updated_at DESC
       LIMIT 1`,
      [cobradorId, fecha]
    );
    return res.json({ success: true, cierre: rows[0] || null, ya_cerrado: !!rows[0], fecha });
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

function validarFechaCierre(fechaISO) {
  const hoy = hoyISO();
  const f = String(fechaISO || hoy).slice(0, 10);
  if (f > hoy) return { ok: false, message: 'No puede cerrar caja de un dia futuro.' };
  const limite = new Date(`${hoy}T12:00:00`);
  limite.setDate(limite.getDate() - 30);
  const limiteISO = limite.toISOString().slice(0, 10);
  if (f < limiteISO) return { ok: false, message: 'Solo puede cerrar los ultimos 30 dias.' };
  return { ok: true, fecha: f };
}

/** Resumen de arqueo para una fecha (hoy o dias anteriores). */
async function resumenCierreCaja(req, res) {
  try {
    const { cobradorId } = req.params;
    await exigirUsuarioActivo(cobradorId);
    const val = validarFechaCierre(req.query.fecha);
    if (!val.ok) return res.status(400).json({ success: false, message: val.message });
    const { inicio, fin } = rangoDiaLocal(val.fecha);
    const pagos = await query(
      `SELECT COUNT(id) AS transacciones, COALESCE(SUM(monto_pagado), 0) AS monto_total
       FROM Pagos
       WHERE deleted_at IS NULL AND (cobrador_id = ? OR operador_id = ?)
         AND fecha_pago >= ? AND fecha_pago < ?`,
      [cobradorId, cobradorId, inicio, fin]
    );
    const cierre = await query(
      `SELECT id, fecha_cierre, monto_efectivo, transacciones
       FROM Cierre_Caja
       WHERE cobrador_id = ? AND deleted_at IS NULL
         AND ${whereCierreCalendarioDia('fecha_cierre')}
       LIMIT 1`,
      [cobradorId, val.fecha]
    );
    const row = pagos[0] || {};
    const c = cierre[0] || null;
    return res.json({
      success: true,
      fecha: val.fecha,
      transacciones: c ? Number(c.transacciones) : Number(row.transacciones || 0),
      monto_total: c ? Number(c.monto_efectivo) : Number(row.monto_total || 0),
      ya_cerrado: !!c,
      cierre: c,
    });
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

/** Registra cierre de caja del dia (rechaza duplicados). */
async function registrarCierreCaja(req, res) {
  try {
    const { cobradorId } = req.params;
    await exigirUsuarioActivo(cobradorId);

    const body = req.body || {};
    const val = validarFechaCierre(body.fecha);
    if (!val.ok) return res.status(400).json({ success: false, message: val.message });
    const fechaCierre = val.fecha;

    const existente = await query(
      `SELECT id, fecha_cierre, monto_efectivo, transacciones
       FROM Cierre_Caja
       WHERE cobrador_id = ? AND deleted_at IS NULL
         AND ${whereCierreCalendarioDia('fecha_cierre')}
       ORDER BY updated_at DESC
       LIMIT 1`,
      [cobradorId, fechaCierre]
    );
    if (existente.length) {
      return res.status(409).json({
        success: false,
        ya_cerrado: true,
        message: `Ya registro el cierre de caja del ${fechaCierre}.`,
        cierre: existente[0],
      });
    }

    const monto = Number(body.monto_efectivo);
    const transacciones = Number(body.transacciones ?? 0);
    if (!Number.isFinite(monto) || monto < 0) {
      return res.status(400).json({ success: false, message: 'Monto de cierre invalido.' });
    }
    if (!Number.isFinite(transacciones) || transacciones < 0) {
      return res.status(400).json({ success: false, message: 'Transacciones invalidas.' });
    }

    const id = body.id || uuidv4();
    const latitud = body.latitud != null && body.latitud !== '' ? Number(body.latitud) : null;
    const longitud = body.longitud != null && body.longitud !== '' ? Number(body.longitud) : null;

    await query(
      `INSERT INTO Cierre_Caja (id, cobrador_id, fecha_cierre, monto_efectivo, transacciones, observaciones, latitud, longitud, is_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        cobradorId,
        fechaCierre,
        monto,
        transacciones,
        body.observaciones || null,
        latitud,
        longitud,
      ]
    );

    return res.status(201).json({
      success: true,
      cierre: {
        id,
        fecha_cierre: fechaCierre,
        monto_efectivo: monto,
        transacciones,
      },
    });
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

/** Coordenadas GPS de clientes en ruta (ligero, para sync sin redescargar toda la ruta). */
async function clientesGps(req, res) {
  try {
    const { cobradorId } = req.params;
    await exigirUsuarioActivo(cobradorId);
    const rows = await query(
      `SELECT DISTINCT c.id, c.primer_nombre, c.segundo_nombre, c.primer_apellido, c.segundo_apellido,
              c.nombre_completo, c.cedula, c.telefono, c.direccion,
              c.latitud, c.longitud, c.latitud_cobro, c.longitud_cobro, c.updated_at
       FROM Clientes c
       INNER JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
       INNER JOIN Rutas r ON rc.ruta_id = r.id AND r.cobrador_id = ? AND r.activa = 1
       WHERE c.deleted_at IS NULL AND c.cobrador_id = ?
       ORDER BY c.id`,
      [cobradorId, cobradorId]
    );
    return res.json({ success: true, clientes: rows, serverTime: new Date().toISOString() });
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

/** Versión de cartera demo — la app redescarga ruta si cambió (nombres/cuotas/saldos). */
async function carteraVersion(req, res) {
  try {
    const { cobradorId } = req.params;
    await exigirUsuarioActivo(cobradorId);
    const rows = await query(
      `SELECT valor FROM Parametros_Globales WHERE clave = 'CARTERA_DEMO_VERSION' LIMIT 1`
    );
    return res.json({
      success: true,
      version: rows[0]?.valor || '0',
      serverTime: new Date().toISOString(),
    });
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

async function historialPrestamosCliente(req, res) {
  try {
    const { cobradorId, clienteId } = req.params;
    await exigirUsuarioActivo(cobradorId);
    const cli = await query(
      `SELECT id FROM Clientes WHERE id = ? AND cobrador_id = ? AND deleted_at IS NULL LIMIT 1`,
      [clienteId, cobradorId]
    );
    if (!cli.length) {
      return res.status(403).json({ success: false, message: 'Cliente no asignado a este cobrador' });
    }
    const rows = await query(
      `SELECT p.id, p.estado, p.monto_desembolsado, p.saldo_pendiente, p.monto_total_pagar,
              p.fecha_desembolso, p.plazo_semanas, p.renovacion_previa_id, p.numero_recibo_fisico,
              ur.nombre_completo AS registrado_por, ue.nombre_completo AS entregado_por
       FROM Prestamos p
       LEFT JOIN Usuarios ur ON p.cobrador_registro_id = ur.id
       LEFT JOIN Usuarios ue ON p.cobrador_entrega_id = ue.id
       WHERE p.cliente_id = ? AND p.deleted_at IS NULL
       ORDER BY p.fecha_desembolso DESC, p.id DESC`,
      [clienteId]
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    return responderErrorUsuario(res, e);
  }
}

module.exports = {
  rutaDiaria,
  clientesGps,
  carteraVersion,
  pushSync,
  syncAviso,
  getCorreccionesAdmin,
  crearSolicitudCorreccion,
  cierreHoy,
  resumenCierreCaja,
  registrarCierreCaja,
  listPrestamosCobrador,
  aplicarProrrogaCobrador,
  pagosPorFecha,
  historialPrestamosCliente,
};
