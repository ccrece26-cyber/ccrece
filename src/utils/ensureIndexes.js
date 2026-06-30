const { query } = require('../config/db');

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_clientes_cobrador_upd ON Clientes (cobrador_id, updated_at, deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_prestamos_cliente_estado ON Prestamos (cliente_id, estado, deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_prestamos_updated ON Prestamos (updated_at, deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_cuotas_prestamo_estado ON Cuotas_Calendario (prestamo_id, estado, fecha_programada, deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_pagos_cobrador_fecha ON Pagos (cobrador_id, fecha_pago, deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_gestiones_cobrador_fecha ON Gestiones_No_Pago (cobrador_id, fecha_gestion, deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_fiadores_cliente ON Fiadores (cliente_id, updated_at, deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_castigos_fecha ON Castigos_Perdida (fecha_castigo, deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_prorrogas_prestamo ON Historial_Prorrogas (prestamo_id, fecha_prorroga)',
  'CREATE INDEX IF NOT EXISTS idx_pagos_prestamo ON Pagos (prestamo_id, deleted_at)',
];

async function ensurePerformanceIndexes() {
  let creados = 0;
  for (const sql of INDEXES) {
    try {
      await query(sql);
      creados += 1;
    } catch {
      /* índice existente o versión sin IF NOT EXISTS */
    }
  }
  return creados;
}

module.exports = { ensurePerformanceIndexes };
