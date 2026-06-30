require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

async function main() {
  const rows = await query(`
    SELECT p.id, c.nombre_completo, p.saldo_pendiente, p.cuota_semanal_base, p.monto_total_pagar,
           (SELECT COALESCE(SUM(GREATEST(0, cc.monto_programado - cc.monto_pagado)), 0)
            FROM Cuotas_Calendario cc
            WHERE cc.prestamo_id = p.id AND cc.estado IN ('Programada','Parcial') AND cc.deleted_at IS NULL) AS saldo_calendario,
           (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS pagos
    FROM Prestamos p
    JOIN Clientes c ON c.id = p.cliente_id
    WHERE p.estado = 'Activo' AND p.deleted_at IS NULL
    HAVING ABS(p.saldo_pendiente - saldo_calendario) > 5
    ORDER BY ABS(p.saldo_pendiente - saldo_calendario) DESC
    LIMIT 20`);
  console.log('Prestamos activos con saldo != calendario (>5 diff):', rows.length);
  rows.forEach((r) =>
    console.log(
      `  ${String(r.nombre_completo).slice(0, 28)} | saldo=${r.saldo_pendiente} | cal=${Number(r.saldo_calendario).toFixed(2)} | pagos=${r.pagos} | cuota=${r.cuota_semanal_base}`
    )
  );

  const [tot] = await query(`
    SELECT COUNT(*) n FROM Prestamos p
    WHERE p.estado='Activo' AND p.deleted_at IS NULL
      AND ABS(p.saldo_pendiente - (
        SELECT COALESCE(SUM(GREATEST(0, cc.monto_programado - cc.monto_pagado)), 0)
        FROM Cuotas_Calendario cc
        WHERE cc.prestamo_id = p.id AND cc.estado IN ('Programada','Parcial') AND cc.deleted_at IS NULL
      )) > 5`);
  console.log('\nTotal descuadrados:', tot.n);
}

main().finally(() => pool.end());
