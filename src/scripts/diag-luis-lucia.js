require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

const CEDULAS = ['1000000001003V', '1000000001027V'];

(async () => {
  for (const cedula of CEDULAS) {
    const [cli] = await query(
      `SELECT c.*, p.id AS prestamo_id, p.estado, p.monto_desembolsado, p.monto_total_pagar,
              p.saldo_pendiente, p.cuota_semanal_base, p.plazo_semanas, p.fecha_desembolso,
              p.dias_de_cobro
       FROM Clientes c
       JOIN Prestamos p ON p.cliente_id = c.id AND p.deleted_at IS NULL
       WHERE c.cedula = ?`,
      [cedula]
    );
    if (!cli) {
      console.log('No encontrado:', cedula);
      continue;
    }

    const pagos = await query(
      `SELECT id, monto_pagado, fecha_pago, registrado_por_admin, cobrador_id, updated_at
       FROM Pagos WHERE prestamo_id = ? AND deleted_at IS NULL ORDER BY fecha_pago`,
      [cli.prestamo_id]
    );

    const cuotas = await query(
      `SELECT id, fecha_programada, monto_programado, monto_pagado, estado
       FROM Cuotas_Calendario WHERE prestamo_id = ? AND deleted_at IS NULL
       ORDER BY fecha_programada`,
      [cli.prestamo_id]
    );

    const sumPagos = pagos.reduce((s, p) => s + Number(p.monto_pagado), 0);
    const sumCuotasPag = cuotas.reduce((s, c) => s + Number(c.monto_pagado), 0);
    const sumCuotasProg = cuotas.reduce((s, c) => s + Number(c.monto_programado), 0);
    const pagadas = cuotas.filter((c) => c.estado === 'Pagada');
    const parciales = cuotas.filter((c) => c.estado === 'Parcial');
    const programadas = cuotas.filter((c) => ['Programada', 'Parcial'].includes(c.estado));

    console.log('\n' + '='.repeat(70));
    console.log(cli.nombre_completo, `(${cedula})`);
    console.log('='.repeat(70));
    console.log({
      prestamo_id: cli.prestamo_id,
      estado: cli.estado,
      desembolso: cli.monto_desembolsado,
      total_pagar: cli.monto_total_pagar,
      saldo: cli.saldo_pendiente,
      cuota_semanal: cli.cuota_semanal_base,
      plazo: cli.plazo_semanas,
      fecha_desembolso: cli.fecha_desembolso,
      sum_pagos: sumPagos,
      sum_cuotas_pagado: sumCuotasPag,
      sum_cuotas_programado: sumCuotasProg,
      diff_pagos_cuotas: sumPagos - sumCuotasPag,
      cuotas_pagadas: pagadas.length,
      cuotas_parciales: parciales.length,
      cuotas_pendientes: programadas.length,
      saldo_esperado: Math.max(0, Number(cli.monto_total_pagar) - sumPagos),
    });

    console.log('\n--- PAGOS ---');
    for (const p of pagos) {
      console.log(
        `  ${String(p.fecha_pago).slice(0, 19)} | C$${p.monto_pagado} | admin=${p.registrado_por_admin}`
      );
    }

    console.log('\n--- CUOTAS (últimas 5 pagadas + pendientes) ---');
    const ultPagadas = pagadas.slice(-5);
    for (const c of [...ultPagadas, ...programadas.slice(0, 5)]) {
      console.log(
        `  ${String(c.fecha_programada).slice(0, 10)} | prog C$${c.monto_programado} | pag C$${c.monto_pagado} | ${c.estado}`
      );
    }
    if (programadas.length > 5) console.log(`  ... y ${programadas.length - 5} cuotas pendientes más`);
  }

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
