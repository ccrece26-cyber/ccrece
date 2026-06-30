require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');
const { hoyISO, rangoDiaNicaragua } = require('../utils/zonaHoraria');
const { rangoDiaLocal } = require('../utils/fechasSql');

(async () => {
  const hoy = hoyISO();
  const { inicio, fin } = rangoDiaNicaragua(hoy);
  const { inicio: iniL, fin: finL } = rangoDiaLocal(hoy);
  console.log('Hoy:', hoy);
  console.log('Rango NI:', inicio, '->', fin);
  console.log('Rango admin listPagos:', iniL, '->', finL);

  const pagosRecientes = await query(
    `SELECT c.nombre_completo, pg.monto_pagado, pg.fecha_pago, pg.deleted_at,
            u.nombre_completo AS cobrador, pg.cobrador_id, c.cobrador_id AS cli_cob,
            pg.registrado_por_admin
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
     ORDER BY pg.fecha_pago DESC LIMIT 20`
  );
  console.log('\n=== ULTIMOS 20 PAGOS (incl anulados) ===');
  for (const p of pagosRecientes) {
    console.log(
      String(p.fecha_pago).slice(0, 19),
      p.deleted_at ? '[ANULADO]' : '[OK]',
      p.nombre_completo,
      'C$',
      Number(p.monto_pagado).toFixed(2),
      '| cob pago:',
      p.cobrador || p.cobrador_id,
      '| cli:',
      p.cli_cob
    );
  }

  const pagosHoyAdmin = await query(
    `SELECT c.nombre_completo, pg.monto_pagado, pg.cobrador_id, u.nombre_completo cobrador
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
     WHERE pg.deleted_at IS NULL AND pg.fecha_pago >= ? AND pg.fecha_pago < ?`,
    [iniL, finL]
  );
  console.log('\n=== PAGOS HOY (query admin abonos) ===', pagosHoyAdmin.length);
  pagosHoyAdmin.forEach((p) => console.log(' ', p.nombre_completo, Number(p.monto_pagado).toFixed(2), p.cobrador));

  const cuotasNeg = await query(
    `SELECT c.nombre_completo, cc.monto_programado, cc.monto_pagado,
            (cc.monto_programado - cc.monto_pagado) AS pendiente, cc.estado
     FROM Cuotas_Calendario cc
     JOIN Prestamos p ON cc.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE cc.deleted_at IS NULL AND cc.estado IN ('Programada','Parcial')
       AND cc.monto_pagado > cc.monto_programado + 0.01`
  );
  console.log('\n=== CUOTAS SOBREPAGADAS (monto negativo en ruta) ===', cuotasNeg.length);
  cuotasNeg.forEach((c) =>
    console.log(' ', c.nombre_completo, 'prog', c.monto_programado, 'pag', c.monto_pagado, 'pend', c.pendiente)
  );

  const admins = await query(
    `SELECT u.id, u.nombre_completo, u.email, u.expo_push_token, u.push_token_at
     FROM Usuarios u JOIN Roles r ON u.rol_id = r.id WHERE r.nombre = 'ADMIN'`
  );
  console.log('\n=== ADMINS PUSH ===');
  admins.forEach((a) => console.log(a.nombre_completo, a.expo_push_token ? 'TOKEN OK' : 'SIN TOKEN', a.push_token_at));

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
