require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');
const { buildAgendaCobrador } = require('../utils/agendaCobrador');
const { montoVisitaHoy } = require('../utils/diasCobro');

async function main() {
  const [c1] = await query(`SELECT COUNT(*) n FROM Prestamos p WHERE p.estado='Activo' AND p.deleted_at IS NULL AND (p.cuota_semanal_base IS NULL OR p.cuota_semanal_base < 1)`);
  console.log('Prestamos cuota_semanal_base < 1:', c1.n);

  const [c2] = await query(`
    SELECT COUNT(*) n FROM Prestamos p
    WHERE p.estado='Activo' AND p.deleted_at IS NULL AND p.saldo_pendiente > 100
      AND p.cuota_semanal_base > 0 AND (p.cuota_semanal_base / 3) < 1`);
  console.log('Prestamos visita diaria (cuota/3) < 1:', c2.n);

  const sample = await query(`
    SELECT c.nombre_completo, p.cuota_semanal_base, p.saldo_pendiente, p.dias_de_cobro,
           cc.monto_programado, cc.monto_pagado, cc.estado
    FROM Prestamos p
    JOIN Clientes c ON c.id=p.cliente_id
    LEFT JOIN Cuotas_Calendario cc ON cc.prestamo_id=p.id AND cc.estado IN ('Programada','Parcial') AND cc.deleted_at IS NULL
    WHERE p.estado='Activo' AND p.deleted_at IS NULL
    ORDER BY p.cuota_semanal_base ASC LIMIT 12`);
  console.log('\nPrestamos con menor cuota:');
  for (const r of sample) {
    const visita = montoVisitaHoy(r.cuota_semanal_base, r.dias_de_cobro);
    console.log(`  ${String(r.nombre_completo).slice(0, 32)} | base=${r.cuota_semanal_base} | visita=${visita} | saldo=${r.saldo_pendiente} | cuota_prog=${r.monto_programado}`);
  }

  const cob = await query(`SELECT id FROM Usuarios WHERE email='cobrador2' LIMIT 1`);
  const agenda = await buildAgendaCobrador(query, cob[0]?.id);
  const bajos = agenda.agenda.filter((a) => Number(a.monto_programado || 0) < 10);
  console.log('\nAgenda cobrador2 monto < 10:', bajos.length);
  bajos.slice(0, 15).forEach((a) =>
    console.log(`  ${String(a.nombre_completo).slice(0, 32)} | monto=${a.monto_programado} | saldo=${a.saldo_pendiente}`)
  );
}

main().finally(() => pool.end());
