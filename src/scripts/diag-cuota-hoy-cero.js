require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');
const { hoyISO } = require('../utils/zonaHoraria');
const { montoVisitaHoy, debeSugerirCobroEnFecha } = require('../utils/diasCobro');
const { buildAgendaCobrador } = require('../utils/agendaCobrador');

async function main() {
  const hoy = hoyISO();
  console.log('Fecha hoy:', hoy);

  const cobradores = await query(`SELECT id, email FROM Usuarios WHERE email IN ('cobrador1','cobrador2')`);
  for (const cob of cobradores) {
    const agenda = await buildAgendaCobrador(query, cob.id);
    const sospechosos = agenda.agenda.filter(
      (a) => Number(a.saldo_pendiente || 0) > 100 && Number(a.monto_programado || 0) < 1
    );
    console.log(`\n=== ${cob.email} — agenda hoy monto < C$1 con saldo > C$100: ${sospechosos.length} ===`);
    for (const a of sospechosos.slice(0, 8)) {
      const prox = await query(
        `SELECT id, fecha_programada, monto_programado, monto_pagado, estado
         FROM Cuotas_Calendario
         WHERE prestamo_id = ? AND deleted_at IS NULL AND estado IN ('Programada','Parcial')
         ORDER BY fecha_programada LIMIT 5`,
        [a.prestamo_id]
      );
      const pagos = await query(
        `SELECT COALESCE(SUM(monto_pagado),0) AS total FROM Pagos WHERE prestamo_id = ? AND deleted_at IS NULL`,
        [a.prestamo_id]
      );
      const prest = await query(
        `SELECT monto_total_pagar, cuota_semanal_base, dias_de_cobro, fecha_desembolso
         FROM Prestamos WHERE id = ?`,
        [a.prestamo_id]
      );
      const p = prest[0] || {};
      const visita = montoVisitaHoy(p.cuota_semanal_base, p.dias_de_cobro);
      console.log({
        nombre: a.nombre_completo,
        agenda_monto: a.monto_programado,
        saldo: a.saldo_pendiente,
        total_pagar: p.monto_total_pagar,
        sum_pagos: pagos[0]?.total,
        visita_teorica: visita,
        cuotas_pendientes: prox,
      });
    }
  }

  const [ghost] = await query(`
    SELECT COUNT(DISTINCT p.id) AS n FROM Prestamos p
    JOIN Cuotas_Calendario cc ON cc.prestamo_id = p.id
    WHERE p.estado = 'Activo' AND p.deleted_at IS NULL AND cc.deleted_at IS NULL
      AND cc.estado = 'Parcial'
      AND (cc.monto_programado - cc.monto_pagado) BETWEEN 0.01 AND 4.99
      AND p.saldo_pendiente > 100`);
  console.log('\nPréstamos con cuota parcial atascada (C$0.01–4.99 pendiente):', ghost.n);
}

main().finally(() => pool.end());
