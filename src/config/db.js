require('dotenv').config();
const mysql = require('mysql2/promise');

const REQUIRED_ENV = [
  ['DB_HOST', 'TIDB_HOST'],
  ['DB_USER', 'TIDB_USER'],
  ['DB_PASSWORD', 'TIDB_PASSWORD'],
  ['DB_NAME', 'TIDB_DATABASE'],
];

function envFirst(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function resolveDbConfig() {
  const host = envFirst('DB_HOST', 'TIDB_HOST');
  const user = envFirst('DB_USER', 'TIDB_USER');
  const password = envFirst('DB_PASSWORD', 'TIDB_PASSWORD');
  const database = envFirst('DB_NAME', 'TIDB_DATABASE');
  const port = Number(envFirst('DB_PORT', 'TIDB_PORT') || 4000);

  const missing = [];
  if (!host) missing.push('DB_HOST o TIDB_HOST');
  if (!user) missing.push('DB_USER o TIDB_USER');
  if (!password) missing.push('DB_PASSWORD o TIDB_PASSWORD');
  if (!database) missing.push('DB_NAME o TIDB_DATABASE');

  const sslFlag = envFirst('DB_SSL', 'TIDB_SSL');
  const useSsl =
    sslFlag === 'true' ||
    sslFlag === '1' ||
    (host && host.includes('tidbcloud.com')) ||
    process.env.VERCEL === '1';

  return { host, port, user, password, database, missing, useSsl };
}

/** Diagnóstico sin secretos (para /api/health). */
function checkDbConfig() {
  const cfg = resolveDbConfig();
  const hostPreview = cfg.host
    ? cfg.host.length > 8
      ? `${cfg.host.slice(0, 4)}…${cfg.host.slice(-12)}`
      : cfg.host
    : null;
  return {
    ok: cfg.missing.length === 0,
    missing: cfg.missing,
    hostPreview,
    port: cfg.port,
    database: cfg.database ? '***' : null,
    ssl: cfg.useSsl,
    vercel: process.env.VERCEL === '1',
  };
}

let pool = null;

function getPool() {
  const cfg = resolveDbConfig();
  if (cfg.missing.length) {
    const err = new Error(
      `Variables de entorno faltantes en Vercel/servidor: ${cfg.missing.join(', ')}. ` +
        'Vercel → Settings → Environment Variables (copie desde su .env local).'
    );
    err.code = 'DB_CONFIG_MISSING';
    throw err;
  }

  if (!pool) {
    pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
      queueLimit: 0,
      maxIdle: 5,
      idleTimeout: 60_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      connectTimeout: 15000,
      ssl: cfg.useSsl ? { rejectUnauthorized: true } : undefined,
      timezone: '+00:00',
    });
  }
  return pool;
}

const query = async (sql, params = []) => {
  const [rows] = await getPool().execute(sql, params);
  return rows;
};

const getConnection = () => getPool().getConnection();

async function testDbConnection() {
  const conn = await getConnection();
  try {
    await conn.execute('SELECT 1 AS ok');
  } finally {
    conn.release();
  }
}

module.exports = {
  get pool() {
    return getPool();
  },
  query,
  getConnection,
  checkDbConfig,
  testDbConnection,
  resolveDbConfig,
};
