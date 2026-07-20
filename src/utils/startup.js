const { query } = require('../config/db');
const { repararFiadoresHistoricos, migrarInlineFiadoresPrestamos } = require('./fiadoresNube');
const { migrarCedulasSinGuion } = require('./migrarCedulas');
const { ensurePerformanceIndexes } = require('./ensureIndexes');
const { repararRutasClientesDuplicadas } = require('./rutas');

async function migrarColumnasPrestamo() {
  const alters = ['ALTER TABLE Fiadores MODIFY COLUMN cedula VARCHAR(40) NOT NULL'];
  const drops = [
    'ALTER TABLE Prestamos DROP COLUMN fiador_nombre',
    'ALTER TABLE Prestamos DROP COLUMN fiador_telefono',
    'ALTER TABLE Prestamos DROP COLUMN fiador_cedula',
    'ALTER TABLE Prestamos DROP COLUMN fiador_direccion',
  ];
  for (const sql of alters) {
    try {
      await query(sql);
    } catch {
      /* omitir */
    }
  }
  await migrarInlineFiadoresPrestamos();
  for (const sql of drops) {
    try {
      await query(sql);
    } catch {
      /* omitir */
    }
  }
}

async function migrarTablasSync() {
  const alters = [
    'ALTER TABLE Pagos ADD COLUMN editado_por_admin_at DATETIME DEFAULT NULL',
    'ALTER TABLE Clientes ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
    'ALTER TABLE Clientes ADD COLUMN latitud_cobro DOUBLE DEFAULT NULL',
    'ALTER TABLE Clientes ADD COLUMN longitud_cobro DOUBLE DEFAULT NULL',
    'ALTER TABLE Clientes ADD COLUMN documento_tipo VARCHAR(20) DEFAULT NULL',
    'ALTER TABLE Clientes MODIFY COLUMN cedula VARCHAR(40) NOT NULL',
    'ALTER TABLE Usuarios ADD COLUMN expo_push_token VARCHAR(255) DEFAULT NULL',
    'ALTER TABLE Usuarios ADD COLUMN push_token_at DATETIME DEFAULT NULL',
    `CREATE TABLE IF NOT EXISTS Solicitudes_Correccion_Cobro (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      pago_id VARCHAR(36) NOT NULL,
      cobrador_id VARCHAR(36) NOT NULL,
      prestamo_id VARCHAR(36) DEFAULT NULL,
      cliente_nombre VARCHAR(200) DEFAULT NULL,
      monto_registrado DECIMAL(12,2) DEFAULT NULL,
      motivo TEXT NOT NULL,
      estado VARCHAR(20) DEFAULT 'PENDIENTE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL,
      KEY idx_sol_pago (pago_id),
      KEY idx_sol_cobrador (cobrador_id),
      KEY idx_sol_estado (estado)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    'ALTER TABLE Prestamos ADD COLUMN numero_recibo_fisico VARCHAR(40) DEFAULT NULL',
    'ALTER TABLE Prestamos ADD COLUMN cobrador_registro_id VARCHAR(36) DEFAULT NULL',
    'ALTER TABLE Prestamos ADD COLUMN cobrador_entrega_id VARCHAR(36) DEFAULT NULL',
    'ALTER TABLE Renovaciones_Log ADD COLUMN cobrador_opero_id VARCHAR(36) DEFAULT NULL',
    'ALTER TABLE Renovaciones_Log ADD COLUMN cobrador_entrega_id VARCHAR(36) DEFAULT NULL',
    'ALTER TABLE Renovaciones_Log ADD COLUMN plazo_semanas INT DEFAULT NULL',
    'ALTER TABLE Renovaciones_Log ADD COLUMN efectivo_entregar DECIMAL(12,2) DEFAULT NULL',
    'ALTER TABLE Pagos ADD COLUMN registrado_por_admin TINYINT(1) DEFAULT 0',
    'ALTER TABLE Pagos ADD COLUMN operador_id VARCHAR(36) DEFAULT NULL',
    'ALTER TABLE Gestiones_No_Pago ADD COLUMN registrado_por_admin TINYINT(1) DEFAULT 0',
    'ALTER TABLE Gestiones_No_Pago ADD COLUMN operador_id VARCHAR(36) DEFAULT NULL',
    `CREATE TABLE IF NOT EXISTS Licencias_Codigos (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      device_id VARCHAR(64) NOT NULL,
      codigo_hash VARCHAR(120) NOT NULL,
      etiqueta VARCHAR(120) DEFAULT NULL,
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
    'ALTER TABLE Licencias_Codigos ADD COLUMN solicitud_ip VARCHAR(45) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN device_marca VARCHAR(60) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN device_modelo VARCHAR(80) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN device_os VARCHAR(40) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN app_version VARCHAR(40) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN geo_ciudad VARCHAR(80) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN geo_region VARCHAR(80) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN geo_pais VARCHAR(80) DEFAULT NULL',
    'ALTER TABLE Licencias_Codigos ADD COLUMN geo_isp VARCHAR(80) DEFAULT NULL',
    `CREATE TABLE IF NOT EXISTS Castigos_Perdida (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      prestamo_id VARCHAR(36) NOT NULL,
      cliente_id VARCHAR(36) NOT NULL,
      admin_id VARCHAR(36) DEFAULT NULL,
      motivo TEXT NOT NULL,
      monto_perdida DECIMAL(12,2) NOT NULL,
      monto_desembolsado DECIMAL(12,2) NOT NULL,
      monto_pagado_acumulado DECIMAL(12,2) NOT NULL DEFAULT 0,
      saldo_anterior DECIMAL(12,2) NOT NULL,
      dias_vencido INT DEFAULT 0,
      fecha_vencimiento DATE DEFAULT NULL,
      fecha_castigo DATETIME NOT NULL,
      is_synced TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL,
      KEY idx_castigo_fecha (fecha_castigo, deleted_at),
      KEY idx_castigo_prestamo (prestamo_id),
      KEY idx_castigo_cliente (cliente_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  ];
  for (const sql of alters) {
    try {
      await query(sql);
    } catch {
      /* ya existe */
    }
  }
}

/** Tareas de arranque en segundo plano (no bloquean el listen). */
async function runStartupTasks() {
  if (process.env.SKIP_STARTUP_TASKS === '1') return;
  try {
    await migrarColumnasPrestamo();
    await migrarTablasSync();
    const idx = await ensurePerformanceIndexes();
    if (idx > 0) console.log(`   Índices de rendimiento: ${idx}`);
    const ced = await migrarCedulasSinGuion();
    if (ced.actualizados > 0 || ced.fusionados > 0) {
      console.log(`   Cédulas normalizadas: ${ced.actualizados} | fusionadas: ${ced.fusionados}`);
    }
    const n = await repararFiadoresHistoricos();
    if (n > 0) console.log(`   Fiadores reparados en nube: ${n}`);
    const rutas = await repararRutasClientesDuplicadas();
    if (rutas > 0) console.log(`   Rutas duplicadas corregidas: ${rutas}`);
  } catch (e) {
    console.warn('   Aviso tareas de arranque:', e.message);
  }
}

module.exports = { runStartupTasks };
