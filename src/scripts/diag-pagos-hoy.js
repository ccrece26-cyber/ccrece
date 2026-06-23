require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');

const fecha = process.argv[2] || '2026-06-23';

(async () => {
  const rows = await query(
    `SELECT c.nombre_completo, c.cobrador_id AS cliente_cobrador,
            pg.id, pg.monto_pagado, pg.cobrador_id AS pago_cobrador,
            pg.registrado_por_admin, pg.fecha_pago, u.nombre_completo AS operador
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     LEFT JOIN Usuarios u ON pg.operador_id = u.id
     WHERE DATE(pg.fecha_pago) = DATE(?) AND pg.deleted_at IS NULL
       AND (c.nombre_completo LIKE '%Ana Beatriz%' OR c.nombre_completo LIKE '%Oscar Danilo%')
     ORDER BY pg.fecha_pago`,
    [fecha]
  );
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
