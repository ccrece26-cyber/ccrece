require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');
const { buildAgendaCobrador } = require('../utils/agendaCobrador');
const { rangoDiaLocal } = require('../utils/fechasSql');
const { hoyISO } = require('../utils/zonaHoraria');

async function main() {
  const hoy = hoyISO();
  const { inicio, fin } = rangoDiaLocal(hoy);
  console.log('Fecha:', hoy);

  const [vielka] = await query(`SELECT id, nombre_completo, email FROM Usuarios WHERE email = 'cobrador1' LIMIT 1`);
  if (!vielka) return console.log('cobrador1 no encontrado');

  const pagos = await query(
    `SELECT pg.id, pg.monto_pagado, pg.fecha_pago, pg.registrado_por_admin, c.nombre_completo, p.saldo_pendiente
     FROM Pagos pg
     JOIN Prestamos p ON p.id = pg.prestamo_id
     JOIN Clientes c ON c.id = p.cliente_id
     WHERE pg.cobrador_id = ? AND pg.deleted_at IS NULL
       AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
     ORDER BY pg.fecha_pago`,
    [vielka.id, inicio, fin]
  );
  const total = pagos.reduce((s, p) => s + Number(p.monto_pagado || 0), 0);
  console.log(`\nPagos nube hoy Vielka: ${pagos.length} | total C$${total.toFixed(2)}`);
  pagos.forEach((p) =>
    console.log(
      `  ${String(p.nombre_completo).slice(0, 28)} | C$${p.monto_pagado} | saldo_act=${p.saldo_pendiente}`
    )
  );

  const agenda = await buildAgendaCobrador(query, vielka.id, hoy);
  console.log('\nAgenda resumen nube:', agenda.resumen);

  const saldo2475 = await query(
    `SELECT c.nombre_completo, p.id, p.saldo_pendiente, p.monto_total_pagar
     FROM Prestamos p JOIN Clientes c ON c.id = p.cliente_id
     WHERE c.cobrador_id = ? AND p.estado = 'Activo' AND p.deleted_at IS NULL
       AND ABS(p.saldo_pendiente - 2475) < 2`,
    [vielka.id]
  );
  console.log('\nPréstamos Vielka con saldo ~2475:', saldo2475.length);
  saldo2475.forEach((r) => console.log(' ', r.nombre_completo, r.saldo_pendiente));

  const [cierre] = await query(
    `SELECT * FROM Cierre_Caja WHERE cobrador_id = ? AND DATE(fecha_cierre) = DATE(?) AND deleted_at IS NULL`,
    [vielka.id, hoy]
  );
  console.log('\nCierre caja nube:', cierre || 'ninguno');

  const cobs = await query(
    `SELECT u.id, u.nombre_completo FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id WHERE r.nombre = 'COBRADOR' AND u.activo = 1`
  );
  const { buildCumplimientoBatch } = require('../utils/agendaCobrador');
  const batch = await buildCumplimientoBatch(query, cobs, hoy);
  let totV = 0;
  let totM = 0;
  for (const f of batch.cobradores) {
    totV += f.visitadas || 0;
    totM += f.monto_cobrado || 0;
    if (String(f.cobrador).includes('Vielka')) {
      console.log('\nCumplimiento Vielka (admin):', {
        porcentaje: f.porcentaje,
        monto_cobrado: f.monto_cobrado,
        visitadas: f.visitadas,
        total_visitas: f.total_visitas,
      });
    }
  }
  const pctGlobal = batch.cobradores.reduce((s, f) => s + (f.total_visitas || 0), 0);
  console.log('\nGlobal admin (todos cobradores):', {
    visitadas: totV,
    total_visitas: pctGlobal,
    porcentaje: pctGlobal ? Math.round((totV / pctGlobal) * 100) : 0,
    monto_cobrado: totM,
  });
}

main().finally(() => pool.end());
