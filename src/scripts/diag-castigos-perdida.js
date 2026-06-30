require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');

(async () => {
  const castigos = await query(
    `SELECT cp.id, cp.prestamo_id, cp.cliente_id, cp.admin_id, cp.motivo,
            cp.monto_perdida, cp.fecha_castigo,
            c.nombre_completo, c.cedula,
            p.estado AS estado_prestamo, p.saldo_pendiente, p.monto_total_pagar,
            p.monto_desembolsado, p.fecha_desembolso,
            u.nombre_completo AS admin_nombre
     FROM Castigos_Perdida cp
     JOIN Clientes c ON c.id = cp.cliente_id
     JOIN Prestamos p ON p.id = cp.prestamo_id
     LEFT JOIN Usuarios u ON u.id = cp.admin_id
     ORDER BY cp.fecha_castigo DESC
     LIMIT 5`
  );

  if (!castigos.length) {
    console.log('Sin castigos a pérdida registrados.');
    process.exit(0);
  }

  for (const cp of castigos) {
    const [cuotas] = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN estado IN ('Programada','Parcial') THEN 1 ELSE 0 END), 0) AS pendientes,
         COALESCE(SUM(GREATEST(0, monto_programado - COALESCE(monto_pagado, 0))), 0) AS saldo_calendario
       FROM Cuotas_Calendario
       WHERE prestamo_id = ? AND deleted_at IS NULL`,
      [cp.prestamo_id]
    );
    const [pagos] = await query(
      `SELECT COALESCE(SUM(monto_pagado), 0) AS total
       FROM Pagos WHERE prestamo_id = ? AND deleted_at IS NULL`,
      [cp.prestamo_id]
    );
    const c = cuotas || {};
    console.log('---');
    console.log(
      JSON.stringify(
        {
          cliente: cp.nombre_completo,
          cedula: cp.cedula,
          prestamo_id: cp.prestamo_id,
          fecha_castigo: cp.fecha_castigo,
          admin: cp.admin_nombre || cp.admin_id,
          motivo: cp.motivo,
          monto_castigado: Number(cp.monto_perdida),
          estado_prestamo: cp.estado_prestamo,
          saldo_actual: Number(cp.saldo_pendiente),
          total_pagado_historico: Number(pagos?.total || 0),
          cuotas_pendientes: Number(c.pendientes),
          saldo_en_calendario: Number(c.saldo_calendario),
          ok_estado_perdida: cp.estado_prestamo === 'Perdida',
          ok_saldo_cero: Number(cp.saldo_pendiente) <= 0.01,
          ok_monto_castigo: Number(cp.monto_perdida) > 0,
        },
        null,
        2
      )
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
