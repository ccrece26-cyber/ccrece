const { v4: uuidv4 } = require('uuid');
const { normalizarCedula, validarCedula } = require('./cedulaNic');

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

function esFilaEjemploGarantia(cedula) {
  return String(cedula || '')
    .trim()
    .toUpperCase()
    .startsWith('EJEMPLO');
}

function normalizarFila(raw) {
  const f = {};
  for (const [k, v] of Object.entries(raw || {})) {
    f[normKey(k)] = v;
  }
  const cedulaRaw = f.cedula ?? f.cedula_cliente ?? f.cliente_cedula;
  return {
    cedula: cedulaRaw ? normalizarCedula(cedulaRaw) : null,
    tipo_articulo: txt(f.tipo_articulo ?? f.tipo ?? f.articulo),
    marca: txt(f.marca),
    numero_serie: txt(f.numero_serie ?? f.serie),
    valor_estimado: num(f.valor_estimado ?? f.valor),
  };
}

async function validarFilas(filas, query) {
  const detalle_errores = [];
  let validas = 0;

  for (let i = 0; i < filas.length; i++) {
    const fila = normalizarFila(filas[i]);
    if (esFilaEjemploGarantia(fila.cedula)) continue;
    const errs = [];

    if (!fila.cedula) errs.push('Cédula requerida');
    else {
      const v = validarCedula(fila.cedula, { requerido: false });
      if (!v.ok) errs.push(v.error);
      else fila.cedula = v.cedula;
    }
    if (!fila.tipo_articulo) errs.push('tipo_articulo requerido');
    if (fila.valor_estimado == null || fila.valor_estimado < 0) {
      errs.push('valor_estimado inválido');
    }

    if (!errs.length) {
      const clientes = await query(
        'SELECT id FROM Clientes WHERE cedula = ? AND deleted_at IS NULL LIMIT 1',
        [fila.cedula]
      );
      if (!clientes.length) errs.push('Cliente no encontrado con esa cédula');
      else {
        const prestamos = await query(
          `SELECT id FROM Prestamos WHERE cliente_id = ? AND estado = 'Activo' AND deleted_at IS NULL LIMIT 1`,
          [clientes[0].id]
        );
        if (!prestamos.length) errs.push('El cliente no tiene préstamo activo');
      }
    }

    if (errs.length) {
      detalle_errores.push({ fila: i + 2, errores: errs });
    } else {
      validas++;
    }
  }

  return {
    total: filas.length,
    validas,
    errores: detalle_errores.length,
    detalle_errores,
  };
}

async function importarFilas(filas, query, getConnection) {
  let importados = 0;
  let fallidos = 0;
  const detalle_fallos = [];
  const conn = await getConnection();

  try {
    await conn.beginTransaction();
    for (let i = 0; i < filas.length; i++) {
      try {
        const fila = normalizarFila(filas[i]);
        if (esFilaEjemploGarantia(fila.cedula)) continue;
        const valCed = validarCedula(fila.cedula, { requerido: false });
        if (!valCed.ok || !valCed.cedula) throw new Error(valCed.error || 'Cédula requerida');
        if (!fila.tipo_articulo) throw new Error('tipo_articulo requerido');
        if (fila.valor_estimado == null || fila.valor_estimado < 0) {
          throw new Error('valor_estimado inválido');
        }

        const [cliente] = await conn.execute(
          'SELECT id FROM Clientes WHERE cedula = ? AND deleted_at IS NULL LIMIT 1',
          [valCed.cedula]
        );
        if (!cliente.length) throw new Error('Cliente no encontrado');

        const [prestamo] = await conn.execute(
          `SELECT id FROM Prestamos WHERE cliente_id = ? AND estado = 'Activo' AND deleted_at IS NULL LIMIT 1`,
          [cliente[0].id]
        );
        if (!prestamo.length) throw new Error('Sin préstamo activo');

        const gid = `GAR-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
        await conn.execute(
          `INSERT INTO Garantias (id, cliente_id, tipo_articulo, marca, numero_serie, valor_estimado, estado, is_synced)
           VALUES (?, ?, ?, ?, ?, ?, 'Comprometida', 1)`,
          [
            gid,
            cliente[0].id,
            fila.tipo_articulo,
            fila.marca,
            fila.numero_serie,
            fila.valor_estimado,
          ]
        );
        await conn.execute(
          `INSERT INTO Prestamo_Garantias (prestamo_id, garantia_id) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE prestamo_id = prestamo_id`,
          [prestamo[0].id, gid]
        );
        importados++;
      } catch (e) {
        fallidos++;
        detalle_fallos.push({ fila: i + 2, error: e.message });
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  return { importados, fallidos, detalle_fallos };
}

module.exports = { normalizarFila, validarFilas, importarFilas };
