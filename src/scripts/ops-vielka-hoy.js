require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');
const { hoyISO, rangoDiaNicaragua } = require('../utils/zonaHoraria');

const fecha = process.argv[2] || hoyISO();
const reabrir = process.argv.includes('--reabrir');

(async () => {
  const { inicio, fin } = rangoDiaNicaragua(fecha);
  console.log('Fecha:', fecha);

  const vielka = await query(
    `SELECT u.id, u.nombre_completo FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id WHERE u.nombre_completo LIKE '%Vielka%' LIMIT 1`
  );
  if (!vielka.length) {
    console.log('Cobrador Vielka no encontrado');
    process.exit(1);
  }
  const cobId = vielka[0].id;
  console.log('Cobrador:', vielka[0].nombre_completo, cobId);

  const pagos = await query(
    `SELECT c.nombre_completo, pg.id, pg.monto_pagado, pg.latitud, pg.longitud,
            pg.fecha_pago, pg.registrado_por_admin, pg.cobrador_id
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE pg.deleted_at IS NULL AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
       AND (pg.cobrador_id = ? OR c.cobrador_id = ?)
     ORDER BY pg.fecha_pago`,
    [inicio, fin, cobId, cobId]
  );
  console.log('\n=== PAGOS HOY (GPS) ===');
  for (const p of pagos) {
    console.log(
      p.nombre_completo,
      '| C$',
      Number(p.monto_pagado).toFixed(2),
      '| GPS:',
      p.latitud,
      p.longitud,
      '| admin:',
      p.registrado_por_admin
    );
  }

  const cierres = await query(
    `SELECT id, fecha_cierre, monto_efectivo, deleted_at FROM Cierre_Caja
     WHERE cobrador_id = ? AND DATE(fecha_cierre) = DATE(?)
     ORDER BY fecha_cierre DESC`,
    [cobId, fecha]
  );
  console.log('\n=== CIERRE CAJA ===');
  console.log(cierres.length ? cierres : '(ninguno)');

  const admins = await query(
    `SELECT u.nombre_completo, u.expo_push_token FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id
     WHERE r.nombre = 'ADMIN' AND u.activo = 1 AND u.deleted_at IS NULL`
  );
  console.log('\n=== ADMINS PUSH TOKEN ===');
  for (const a of admins) {
    const t = a.expo_push_token ? `${String(a.expo_push_token).slice(0, 35)}...` : '(sin token)';
    console.log(a.nombre_completo, '->', t);
  }

  const vika = await query(
    `SELECT c.nombre_completo, p.id AS prestamo_id, p.estado, p.saldo_pendiente, c.cobrador_id
     FROM Clientes c JOIN Prestamos p ON p.cliente_id = c.id
     WHERE c.nombre_completo LIKE '%Vika%' AND p.deleted_at IS NULL
     ORDER BY p.fecha_desembolso DESC LIMIT 1`
  );
  if (vika.length) {
    const v = vika[0];
    console.log('\n=== VIKA SALGADO ===');
    console.log('Estado:', v.estado, '| saldo:', v.saldo_pendiente, '| cobrador cliente:', v.cobrador_id);
    const pagosVika = await query(
      `SELECT id, monto_pagado, fecha_pago, registrado_por_admin, cobrador_id, deleted_at
       FROM Pagos WHERE prestamo_id = ? ORDER BY fecha_pago DESC LIMIT 3`,
      [v.prestamo_id]
    );
    console.log('Ultimos pagos:', pagosVika);
  }

  if (reabrir) {
    const { whereCierreCalendarioDia } = require('../utils/fechasSql');
    const r = await query(
      `UPDATE Cierre_Caja SET deleted_at = NOW(), updated_at = NOW()
       WHERE cobrador_id = ? AND deleted_at IS NULL AND ${whereCierreCalendarioDia('fecha_cierre')}`,
      [cobId, fecha]
    );
    console.log('\n>>> Cierre reabierto para', fecha, '| filas:', r.affectedRows ?? r);
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
