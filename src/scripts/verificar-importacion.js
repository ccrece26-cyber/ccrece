require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query, pool } = require('../config/db');
const { hoyISO } = require('../utils/zonaHoraria');
const { fechaVencimientoCredito } = require('../utils/finanzasNube');

(async () => {
  const hoy = hoyISO();
  const clientes = (await query('SELECT COUNT(*) AS n FROM Clientes WHERE deleted_at IS NULL'))[0].n;
  const prestamos = await query(
    `SELECT estado, COUNT(*) AS n FROM Prestamos WHERE deleted_at IS NULL GROUP BY estado`
  );
  const pagosRow = await query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(monto_pagado),0) AS t FROM Pagos WHERE deleted_at IS NULL`
  );
  const pagos = pagosRow[0];
  const hist = (
    await query(`SELECT COUNT(*) AS n FROM Pagos WHERE deleted_at IS NULL AND registrado_por_admin=1`)
  )[0].n;
  const cuotas = (await query('SELECT COUNT(*) AS n FROM Cuotas_Calendario WHERE deleted_at IS NULL'))[0].n;
  const rutas = (await query('SELECT COUNT(*) AS n FROM Ruta_Clientes'))[0].n;
  const cob = await query(
    `SELECT u.nombre_completo, COUNT(c.id) AS clientes
     FROM Clientes c
     JOIN Usuarios u ON c.cobrador_id = u.id
     WHERE c.deleted_at IS NULL
     GROUP BY u.id, u.nombre_completo`
  );

  const rows = await query(
    `SELECT p.id, c.nombre_completo, c.cedula, p.fecha_desembolso, p.plazo_semanas,
            p.dias_de_cobro, p.saldo_pendiente, p.monto_total_pagar,
            (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos pg WHERE pg.prestamo_id=p.id AND pg.deleted_at IS NULL) AS pagos,
            (SELECT COALESCE(SUM(monto_pagado),0) FROM Cuotas_Calendario cc WHERE cc.prestamo_id=p.id AND cc.deleted_at IS NULL) AS cuotas
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE p.estado = 'Activo' AND p.deleted_at IS NULL`
  );

  const vencidos = [];
  for (const r of rows) {
    let dias = r.dias_de_cobro;
    if (typeof dias === 'string') dias = JSON.parse(dias);
    const v = fechaVencimientoCredito(r.fecha_desembolso, r.plazo_semanas, dias);
    if (v < hoy) vencidos.push({ nombre: r.nombre_completo, cedula: r.cedula, vence: v, saldo: r.saldo_pendiente });
  }

  console.log(JSON.stringify({
    hoy,
    clientes: Number(clientes),
    prestamos,
    pagos_total: Number(pagos.n),
    monto_pagos: Number(pagos.t),
    pagos_historico_import: Number(hist),
    cuotas: Number(cuotas),
    ruta_clientes: Number(rutas),
    cobradores: cob,
    vencidos_count: vencidos.length,
    vencidos_muestra: vencidos.slice(0, 5),
    cuadre_muestra: rows.slice(0, 3).map((r) => ({
      nombre: r.nombre_completo,
      total: Number(r.monto_total_pagar),
      saldo: Number(r.saldo_pendiente),
      pagos: Number(r.pagos),
      cuotas: Number(r.cuotas),
      ok: Math.abs(Number(r.saldo_pendiente) - (Number(r.monto_total_pagar) - Number(r.pagos))) < 0.02,
    })),
  }, null, 2));

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
