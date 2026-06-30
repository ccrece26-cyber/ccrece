require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');

(async () => {
  const rows = await query(
    `SELECT hp.id, hp.prestamo_id, hp.semanas_extra, hp.saldo_anterior, hp.nueva_cuota_semanal,
            hp.fecha_prorroga, hp.comentario,
            p.estado, p.saldo_pendiente, p.plazo_semanas, p.cuota_semanal_base,
            c.nombre_completo, c.cedula
     FROM Historial_Prorrogas hp
     JOIN Prestamos p ON p.id = hp.prestamo_id
     JOIN Clientes c ON c.id = p.cliente_id
     ORDER BY hp.fecha_prorroga DESC
     LIMIT 10`
  );
  if (!rows.length) {
    console.log('Sin prorrogas registradas.');
    process.exit(0);
  }
  for (const r of rows) {
    const [cuotas] = await query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(GREATEST(0, monto_programado - COALESCE(monto_pagado, 0))), 0) AS saldo_cal,
              COALESCE(SUM(CASE WHEN estado IN ('Programada', 'Parcial') THEN 1 ELSE 0 END), 0) AS pend
       FROM Cuotas_Calendario WHERE prestamo_id = ? AND deleted_at IS NULL`,
      [r.prestamo_id]
    );
    const c = cuotas || {};
    console.log('---');
    console.log(
      JSON.stringify(
        {
          cliente: r.nombre_completo,
          cedula: r.cedula,
          prestamo: r.prestamo_id,
          semanas_extra: r.semanas_extra,
          saldo_al_prorrogar: Number(r.saldo_anterior),
          cuota_semanal: Number(r.nueva_cuota_semanal),
          plazo_actual: r.plazo_semanas,
          saldo_actual: Number(r.saldo_pendiente),
          estado: r.estado,
          fecha_prorroga: r.fecha_prorroga,
          cuotas_pendientes: c.pend,
          saldo_en_calendario: Number(c.saldo_cal),
          cuota_sin_cambio: Number(r.nueva_cuota_semanal) === Number(r.cuota_semanal_base),
          comentario: r.comentario,
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
