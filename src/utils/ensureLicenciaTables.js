const { query } = require('../config/db');

let listo = false;

async function migrarColumnasLicencia() {
  const alters = [
    'ALTER TABLE Licencias_Codigos ADD COLUMN solicitud_ip VARCHAR(45) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN device_marca VARCHAR(60) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN device_modelo VARCHAR(80) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN device_os VARCHAR(40) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN app_version VARCHAR(40) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN geo_ciudad VARCHAR(80) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN geo_region VARCHAR(80) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN geo_pais VARCHAR(80) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN geo_isp VARCHAR(80) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN email_enviado_at DATETIME DEFAULT NULL',
  ];
  for (const sql of alters) {
    try {
      await query(sql);
    } catch {
      /* columna ya existe */
    }
  }
}

async function ensureLicenciaTables() {
  if (listo) return;
  const sqls = [
    `CREATE TABLE IF NOT EXISTS Licencias_Codigos (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      device_id VARCHAR(64) NOT NULL,
      codigo_hash VARCHAR(120) NOT NULL,
      etiqueta VARCHAR(120) DEFAULT NULL,
      solicitud_ip VARCHAR(45) DEFAULT NULL,
      device_marca VARCHAR(60) DEFAULT NULL,
      device_modelo VARCHAR(80) DEFAULT NULL,
      device_os VARCHAR(40) DEFAULT NULL,
      app_version VARCHAR(40) DEFAULT NULL,
      geo_ciudad VARCHAR(80) DEFAULT NULL,
      geo_region VARCHAR(80) DEFAULT NULL,
      geo_pais VARCHAR(80) DEFAULT NULL,
      geo_isp VARCHAR(80) DEFAULT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_lic_cod_device (device_id),
      KEY idx_lic_cod_exp (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS Licencias_Activados (
      device_id VARCHAR(64) NOT NULL PRIMARY KEY,
      activado_at DATETIME NOT NULL,
      KEY idx_lic_act_fecha (activado_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  ];
  for (const sql of sqls) {
    await query(sql);
  }
  await migrarColumnasLicencia();
  listo = true;
}

module.exports = { ensureLicenciaTables };
