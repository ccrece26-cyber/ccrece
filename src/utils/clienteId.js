const { v4: uuidv4 } = require('uuid');

async function obtenerMaxSecuencia(queryFn) {
  const rows = await queryFn(
    `SELECT MAX(CAST(SUBSTRING(id, 4) AS UNSIGNED)) AS m FROM Clientes WHERE id LIKE 'CC-%'`
  );
  return Number(rows[0]?.m || 0);
}

async function initSecuenciaCliente(queryFn) {
  const max = await obtenerMaxSecuencia(queryFn);
  await queryFn(
    `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
     VALUES (?, 'SEC_CLIENTE', ?, 'Secuencia clientes CC-N', 1)
     ON DUPLICATE KEY UPDATE valor = GREATEST(CAST(valor AS UNSIGNED), CAST(VALUES(valor) AS UNSIGNED))`,
    [uuidv4(), String(max)]
  );
}

async function bumpSecuenciaCliente(conn, increment = 1) {
  const n = Math.max(1, Math.floor(Number(increment) || 1));
  await conn.execute(
    `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
     VALUES (?, 'SEC_CLIENTE', '0', 'Secuencia clientes CC-N', 1)
     ON DUPLICATE KEY UPDATE id = id`,
    [uuidv4()]
  );
  await conn.execute(
    `UPDATE Parametros_Globales SET valor = CAST(valor AS UNSIGNED) + ? WHERE clave = 'SEC_CLIENTE'`,
    [n]
  );
  const [rows] = await conn.execute(
    `SELECT valor FROM Parametros_Globales WHERE clave = 'SEC_CLIENTE'`
  );
  return parseInt(rows[0].valor, 10);
}

async function nextClienteId(conn) {
  const end = await bumpSecuenciaCliente(conn, 1);
  return `CC-${end}`;
}

/** Reserva N ids CC- con una sola actualización de secuencia. */
async function reserveClienteIds(conn, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return [];
  const end = await bumpSecuenciaCliente(conn, n);
  const start = end - n + 1;
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push(`CC-${start + i}`);
  return ids;
}

/**
 * Asegura que SEC_CLIENTE >= minVal (p. ej. tras importar CC-1..CC-252,
 * los nuevos clientes empiezan en CC-253).
 */
async function asegurarSecuenciaAlMenos(conn, minVal) {
  const min = Math.max(0, Math.floor(Number(minVal) || 0));
  if (!min) return;
  await conn.execute(
    `INSERT INTO Parametros_Globales (id, clave, valor, descripcion, is_synced)
     VALUES (?, 'SEC_CLIENTE', ?, 'Secuencia clientes CC-N', 1)
     ON DUPLICATE KEY UPDATE valor = GREATEST(CAST(valor AS UNSIGNED), ?)`,
    [uuidv4(), String(min), min]
  );
}

/**
 * Acepta: 5 | "5" | "CC-5" | "cc-5" → { id: "CC-5", n: 5 }
 * Vacío → null
 */
function parseCodigoCliente(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  const m = s.match(/^CC-?(\d+)$/) || s.match(/^(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return { id: `CC-${n}`, n };
}

function esIdClienteOficial(id) {
  return /^CC-\d+$/.test(id || '');
}

module.exports = {
  nextClienteId,
  reserveClienteIds,
  bumpSecuenciaCliente,
  initSecuenciaCliente,
  asegurarSecuenciaAlMenos,
  parseCodigoCliente,
  esIdClienteOficial,
  obtenerMaxSecuencia,
};
