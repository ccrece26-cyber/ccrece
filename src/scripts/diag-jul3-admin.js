require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');
const { rangoDiaLocal } = require('../utils/fechasSql');

(async () => {
  const { inicio, fin } = rangoDiaLocal('2026-07-03');
  const jul3 = await query(
    `SELECT COALESCE(registrado_por_admin,0) admin, COUNT(*) n, ROUND(SUM(monto_pagado),2) m,
            MIN(created_at) min_c, MAX(created_at) max_c
     FROM Pagos WHERE deleted_at IS NULL AND fecha_pago >= ? AND fecha_pago < ?
     GROUP BY COALESCE(registrado_por_admin,0)`,
    [inicio, fin]
  );
  console.log('Jul 3 Nicaragua:', { inicio, fin }, jul3);

  const muestra = await query(
    `SELECT pg.id, pg.monto_pagado, pg.fecha_pago, pg.created_at, pg.registrado_por_admin,
            c.nombre_completo, u.email
     FROM Pagos pg
     JOIN Prestamos p ON p.id=pg.prestamo_id
     JOIN Clientes c ON c.id=p.cliente_id
     LEFT JOIN Usuarios u ON u.id=pg.cobrador_id
     WHERE pg.deleted_at IS NULL AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
     ORDER BY pg.created_at LIMIT 8`,
    [inicio, fin]
  );
  console.log('\nMuestra Jul 3:', muestra);

  const dupHist = await query(
    `SELECT c.cedula, c.nombre_completo, COUNT(*) n, ROUND(SUM(pg.monto_pagado),2) m
     FROM Pagos pg
     JOIN Prestamos p ON p.id=pg.prestamo_id
     JOIN Clientes c ON c.id=p.cliente_id
     WHERE pg.deleted_at IS NULL AND pg.registrado_por_admin=1
     GROUP BY c.id HAVING n > 2
     ORDER BY n DESC LIMIT 10`
  );
  console.log('\nClientes con 3+ pagos histórico admin:', dupHist);

  const liq = await query(
    `SELECT c.nombre_completo, p.estado, p.saldo_pendiente, p.monto_total_pagar,
            (SELECT SUM(monto_pagado) FROM Pagos WHERE prestamo_id=p.id AND deleted_at IS NULL) pagos
     FROM Prestamos p JOIN Clientes c ON c.id=p.cliente_id
     WHERE p.estado='Pagado' AND p.deleted_at IS NULL`
  );
  console.log('\nLiquidados:', liq);

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
