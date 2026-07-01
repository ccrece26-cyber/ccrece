require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');
const { rangoDiaLocal } = require('../utils/fechasSql');
const { hoyISO } = require('../utils/zonaHoraria');

async function main() {
  const hoy = hoyISO();
  const { inicio, fin } = rangoDiaLocal(hoy);
  const [vielka] = await query(`SELECT id FROM Usuarios WHERE email='cobrador1' LIMIT 1`);

  const dup = await query(
    `SELECT pg.prestamo_id, c.nombre_completo, COUNT(*) n, SUM(pg.monto_pagado) total,
            p.saldo_pendiente, p.monto_total_pagar
     FROM Pagos pg
     JOIN Prestamos p ON p.id = pg.prestamo_id
     JOIN Clientes c ON c.id = p.cliente_id
     WHERE pg.cobrador_id = ? AND pg.deleted_at IS NULL
       AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
     GROUP BY pg.prestamo_id, c.nombre_completo, p.saldo_pendiente, p.monto_total_pagar
     HAVING COUNT(*) > 1`,
    [vielka.id, inicio, fin]
  );
  console.log('Doble cobro mismo prestamo hoy (nube):', dup.length);
  dup.forEach((d) => console.log(d));

  const ana = await query(
    `SELECT c.nombre_completo, p.id, p.saldo_pendiente, p.monto_total_pagar,
            (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos WHERE prestamo_id=p.id AND deleted_at IS NULL) pagado
     FROM Prestamos p JOIN Clientes c ON c.id=p.cliente_id
     WHERE c.cobrador_id = ? AND p.saldo_pendiente BETWEEN 2470 AND 2480`,
    [vielka.id]
  );
  console.log('\nClientes saldo ~2475:');
  for (const a of ana) {
    const pagosHoy = await query(
      `SELECT monto_pagado FROM Pagos WHERE prestamo_id=? AND deleted_at IS NULL AND fecha_pago >= ? AND fecha_pago < ?`,
      [a.id, inicio, fin]
    );
    console.log({
      nombre: a.nombre_completo,
      saldo: a.saldo_pendiente,
      total_pagar: a.monto_total_pagar,
      pagado_hist: a.pagado,
      pagos_hoy: pagosHoy,
      cuota_visita: Number((Number(a.monto_total_pagar) - Number(a.pagado)) / 10).toFixed(2),
    });
  }

  const lucia500 = await query(
    `SELECT pg.monto_pagado, c.nombre_completo, p.saldo_pendiente
     FROM Pagos pg JOIN Prestamos p ON p.id=pg.prestamo_id JOIN Clientes c ON c.id=p.cliente_id
     WHERE pg.cobrador_id=? AND pg.fecha_pago >= ? AND pg.fecha_pago < ? AND pg.monto_pagado >= 400`,
    [vielka.id, inicio, fin]
  );
  console.log('\nCobros grandes hoy (>=400):', lucia500);
}

main().finally(() => pool.end());
