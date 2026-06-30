require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');

const id = process.argv[2] || 'c488ba61-9068-4de8-8f5b-8b69abebc87e';

(async () => {
  const [p] = await query('SELECT * FROM Prestamos WHERE id = ?', [id]);
  console.log('PRESTAMO', {
    estado: p.estado,
    saldo: Number(p.saldo_pendiente),
    plazo: p.plazo_semanas,
    cuota_semanal: Number(p.cuota_semanal_base),
    dias: p.dias_de_cobro,
    desembolso: p.fecha_desembolso,
  });
  const cuotas = await query(
    `SELECT fecha_programada, monto_programado, monto_pagado, estado
     FROM Cuotas_Calendario WHERE prestamo_id = ? AND deleted_at IS NULL
     ORDER BY fecha_programada`,
    [id]
  );
  const pend = cuotas.filter((c) => ['Programada', 'Parcial'].includes(c.estado));
  const saldoCal = pend.reduce(
    (s, c) => s + Math.max(0, Number(c.monto_programado) - Number(c.monto_pagado || 0)),
    0
  );
  console.log('CUOTAS total:', cuotas.length, 'pendientes:', pend.length, 'saldo_cal:', saldoCal);
  pend.slice(0, 5).forEach((c) =>
    console.log(' ', String(c.fecha_programada).slice(0, 10), c.monto_programado, c.estado)
  );
  if (pend.length > 5) console.log(' ...', pend.length - 5, 'más');
  const pr = await query('SELECT * FROM Historial_Prorrogas WHERE prestamo_id = ?', [id]);
  console.log('PRORROGAS', pr);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
