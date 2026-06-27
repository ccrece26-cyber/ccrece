const { query } = require('../config/db');

/** Orden de inserción respetando FKs (padres antes que hijos). */
const ORDEN_TABLAS = [
  'Roles',
  'Usuarios',
  'Parametros_Globales',
  'Clientes',
  'Fiadores',
  'Garantias',
  'Prestamos',
  'Prestamo_Garantias',
  'Cuotas_Calendario',
  'Pagos',
  'Gestiones_No_Pago',
  'Castigos_Perdida',
  'Historial_Prorrogas',
  'Renovaciones_Log',
  'Rutas',
  'Ruta_Clientes',
  'Cierre_Caja',
  'Solicitudes_Correccion_Cobro',
];

/** Filas por sentencia INSERT (solo tablas grandes). */
const INSERT_CHUNK = 400;

function escapeSqlValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (val instanceof Date) {
    const iso = val.toISOString().slice(0, 19).replace('T', ' ');
    return `'${iso}'`;
  }
  if (Buffer.isBuffer(val)) return `X'${val.toString('hex')}'`;
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (typeof val === 'bigint') return String(val);
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
  const s = String(val);
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

function safeName(nombre) {
  return nombre.replace(/`/g, '');
}

function ordenarTablas(nombres) {
  const set = new Set(nombres);
  const ordered = [];
  for (const t of ORDEN_TABLAS) {
    if (set.has(t)) {
      ordered.push(t);
      set.delete(t);
    }
  }
  return [...ordered, ...[...set].sort((a, b) => a.localeCompare(b))];
}

async function listarTablas() {
  const rows = await query(
    `SELECT TABLE_NAME AS nombre
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
  );
  if (rows.length) return rows.map((r) => r.nombre);
  const fallback = await query('SHOW TABLES');
  const key = Object.keys(fallback[0] || {})[0] || 'Tables_in_db';
  return fallback.map((r) => r[key]).filter(Boolean);
}

/** Una consulta: conteos exactos de todas las tablas en paralelo (pool). */
async function contarFilasTablas(tablas) {
  const pairs = await Promise.all(
    tablas.map(async (tabla) => {
      const safe = safeName(tabla);
      const rows = await query(`SELECT COUNT(*) AS n FROM \`${safe}\``);
      return [tabla, Number(rows[0]?.n || 0)];
    })
  );
  return Object.fromEntries(pairs);
}

/** DDL en paralelo (evita 17 viajes secuenciales a TiDB). */
async function ddlTablasParalelo(tablas) {
  const pairs = await Promise.all(
    tablas.map(async (tabla) => {
      const safe = safeName(tabla);
      try {
        const rows = await query(`SHOW CREATE TABLE \`${safe}\``);
        const row = rows[0] || {};
        return [tabla, row['Create Table'] || row['Create View'] || null];
      } catch {
        return [tabla, null];
      }
    })
  );
  return Object.fromEntries(pairs);
}

/** SELECT * una sola vez por tabla (sin OFFSET). */
async function leerFilasTabla(tabla) {
  const safe = safeName(tabla);
  return query(`SELECT * FROM \`${safe}\``);
}

function sqlInserts(tabla, rows) {
  if (!rows.length) return '';
  const safe = safeName(tabla);
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `\`${safeName(c)}\``).join(', ');
  const chunks = [];

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const slice = rows.slice(i, i + INSERT_CHUNK);
    const values = slice.map((row) => {
      const vals = cols.map((c) => escapeSqlValue(row[c]));
      return `(${vals.join(', ')})`;
    });
    chunks.push(`INSERT INTO \`${safe}\` (${colList}) VALUES\n${values.join(',\n')};\n`);
  }
  return chunks.join('\n');
}

/**
 * Genera .sql con estructura + datos. Optimizado: paralelo, sin OFFSET, omite tablas vacías.
 */
async function generarRespaldoSql() {
  const t0 = Date.now();
  const [dbRows, tablasRaw] = await Promise.all([
    query('SELECT DATABASE() AS db'),
    listarTablas(),
  ]);
  const database = dbRows[0]?.db || process.env.DB_NAME || process.env.TIDB_DATABASE || 'microfinanzas';
  const tablas = ordenarTablas(tablasRaw);
  const generadoAt = new Date().toISOString();
  const filename = `CrediCrece_respaldo_${generadoAt.slice(0, 10)}.sql`;

  const [conteos, ddls] = await Promise.all([contarFilasTablas(tablas), ddlTablasParalelo(tablas)]);

  const tablasConDatos = tablas.filter((t) => conteos[t] > 0);
  const filasPorTabla = await Promise.all(
    tablasConDatos.map(async (tabla) => [tabla, await leerFilasTabla(tabla)])
  );
  const datosMap = Object.fromEntries(filasPorTabla);

  const partes = [
    '-- Respaldo Credi Crece (TiDB Cloud)\n',
    `-- Generado: ${generadoAt}\n`,
    `-- Base: ${database}\n\n`,
    'SET NAMES utf8mb4;\n',
    'SET FOREIGN_KEY_CHECKS = 0;\n\n',
  ];

  let totalFilas = 0;
  let tablasConDatosN = 0;

  for (const tabla of tablas) {
    const n = conteos[tabla] || 0;
    const ddl = ddls[tabla];
    partes.push(`-- ${tabla}${n ? ` (${n} filas)` : ''}\n`);
    if (ddl) {
      partes.push(`DROP TABLE IF EXISTS \`${safeName(tabla)}\`;\n${ddl};\n\n`);
    }
    const rows = datosMap[tabla];
    if (rows?.length) {
      partes.push(sqlInserts(tabla, rows));
      partes.push('\n');
      totalFilas += rows.length;
      tablasConDatosN += 1;
    }
  }

  partes.push('SET FOREIGN_KEY_CHECKS = 1;\n');
  const ms = Date.now() - t0;
  partes.push(`-- ${totalFilas} filas, ${tablasConDatosN} tablas con datos, ${ms} ms\n`);

  return {
    sql: partes.join(''),
    meta: {
      filename,
      database,
      generado_at: generadoAt,
      tablas: tablas.length,
      filas: totalFilas,
      tablas_con_datos: tablasConDatosN,
      ms,
    },
  };
}

module.exports = { generarRespaldoSql };
