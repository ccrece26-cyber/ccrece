require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');
const { hoyISO, rangoDiaNicaragua } = require('../utils/zonaHoraria');
const { desdeCorreccionesUnix } = require('../utils/fechasSql');

(async () => {
  const hoy = hoyISO();
  const { inicio, fin } = rangoDiaNicaragua(hoy);
  console.log('Hoy:', hoy);

  const anulados = await query(
    `SELECT pg.id, pg.prestamo_id, pg.cobrador_id, pg.monto_pagado, pg.deleted_at,
            pg.editado_por_admin_at, c.nombre_completo, c.cobrador_id AS cliente_cobrador,
            u.nombre_completo AS cobrador_nombre
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
     WHERE pg.deleted_at IS NOT NULL
       AND pg.deleted_at >= DATE_SUB(NOW(), INTERVAL 3 DAY)
     ORDER BY pg.deleted_at DESC
     LIMIT 15`
  );
  console.log('\n=== PAGOS ANULADOS (ultimos 3 dias) ===');
  for (const p of anulados) {
    console.log('---', p.nombre_completo);
    console.log('  id:', p.id, '| monto:', p.monto_pagado);
    console.log('  cobrador_pago:', p.cobrador_id, p.cobrador_nombre);
    console.log('  cobrador_cliente:', p.cliente_cobrador);
    console.log('  anulado:', String(p.deleted_at).slice(0, 19));
    console.log('  editado_admin:', p.editado_por_admin_at ? String(p.editado_por_admin_at).slice(0, 19) : null);

    const cobId = p.cliente_cobrador || p.cobrador_id;
    if (cobId) {
      const desde = '1970-01-01T00:00:00.000Z';
      const desdeTs = desdeCorreccionesUnix(desde);
      const corr = await query(
        `SELECT COUNT(*) AS n FROM Pagos pg
         INNER JOIN Prestamos pr ON pg.prestamo_id = pr.id
         INNER JOIN Clientes cl ON pr.cliente_id = cl.id
         WHERE (pg.cobrador_id = ? OR cl.cobrador_id = ?)
           AND pg.id = ?
           AND (
             UNIX_TIMESTAMP(COALESCE(pg.editado_por_admin_at, pg.deleted_at)) > ?
             OR (pg.deleted_at IS NOT NULL AND UNIX_TIMESTAMP(pg.deleted_at) > ?)
           )`,
        [cobId, cobId, p.id, desdeTs, desdeTs]
      );
      console.log('  visible en correcciones para cob', cobId, ':', corr[0]?.n > 0 ? 'SI' : 'NO');
    }
  }

  const activosHoy = await query(
    `SELECT c.nombre_completo, pg.id, pg.monto_pagado, pg.cobrador_id, c.cobrador_id AS cli_cob
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE pg.deleted_at IS NULL AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
     ORDER BY pg.fecha_pago DESC LIMIT 10`,
    [inicio, fin]
  );
  console.log('\n=== PAGOS ACTIVOS HOY ===');
  for (const p of activosHoy) {
    console.log(p.nombre_completo, '|', Number(p.monto_pagado).toFixed(2), '| cob:', p.cobrador_id, '| cli:', p.cli_cob);
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
