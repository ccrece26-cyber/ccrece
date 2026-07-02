/**
 * Audita préstamos activos: remanentes parciales, residuos y cuota agenda incorrecta.
 * Uso: node src/scripts/auditar-cuotas-cartera.js [--apply]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool, getConnection } = require('../config/db');
const { montoVisitaHoy } = require('../utils/diasCobro');
const {
  seleccionarCuotaAgenda,
  montoCobroDelDia,
  pendienteCuota,
  esRemanenteParcialAgenda,
  absorberResiduosCuotas,
} = require('../utils/cuotasCalendario');
const { esCuotaDiaDesembolso } = require('../utils/diasCobro');
const { hoyISO } = require('../utils/zonaHoraria');
const { prestamoEstaVencido } = require('../utils/finanzasNube');

const apply = process.argv.includes('--apply');

async function main() {
  const hoy = hoyISO();
  const prestamos = await query(
    `SELECT p.*, c.nombre_completo, c.cedula
     FROM Prestamos p
     JOIN Clientes c ON c.id = p.cliente_id AND c.deleted_at IS NULL
     WHERE p.estado = 'Activo' AND p.deleted_at IS NULL AND p.saldo_pendiente > 0.01
     ORDER BY c.nombre_completo`
  );

  const problemas = [];
  let remanentes = 0;
  let residuos = 0;
  let agendaVieja = 0;

  for (const p of prestamos) {
    let dias = p.dias_de_cobro;
    try {
      dias = typeof dias === 'string' ? JSON.parse(dias) : dias;
    } catch {
      dias = ['LUNES'];
    }
    const visita = montoVisitaHoy(p.cuota_semanal_base, dias);

    const cuotas = await query(
      `SELECT id, fecha_programada, monto_programado, monto_pagado, estado
       FROM Cuotas_Calendario
       WHERE prestamo_id = ? AND deleted_at IS NULL
         AND estado IN ('Programada', 'Parcial')
         AND fecha_programada <= ?
       ORDER BY fecha_programada`,
      [p.id, hoy]
    );

    const parciales = cuotas.filter((c) => esRemanenteParcialAgenda(c, visita));
    const fantasmas = cuotas.filter((c) => {
      const pend = pendienteCuota(c);
      return pend > 0.009 && pend < 1 && visita >= 5;
    });

    const cuotaSel = seleccionarCuotaAgenda(cuotas, p, hoy, esCuotaDiaDesembolso, montoVisitaHoy);
    const montoAgenda = montoCobroDelDia(cuotaSel, p, montoVisitaHoy);

    const cuotaVieja = cuotas.find((c) => !esCuotaDiaDesembolso(c, p));
    const montoViejo = cuotaVieja ? pendienteCuota(cuotaVieja) : visita;
    const diffAgenda = Math.abs(montoAgenda - montoViejo) > 0.02 && montoViejo < visita - 0.5;

    if (parciales.length) remanentes += parciales.length;
    if (fantasmas.length) residuos += fantasmas.length;
    if (diffAgenda) agendaVieja += 1;

    if (parciales.length || fantasmas.length || diffAgenda) {
      problemas.push({
        nombre: p.nombre_completo,
        prestamo_id: p.id,
        saldo: p.saldo_pendiente,
        visita,
        vencido: prestamoEstaVencido(p),
        parciales: parciales.map((c) => ({
          fecha: c.fecha_programada,
          pend: pendienteCuota(c),
          pag: c.monto_pagado,
        })),
        fantasmas: fantasmas.length,
        monto_agenda_nuevo: montoAgenda,
        monto_agenda_viejo: montoViejo,
      });
    }
  }

  console.log('=== Auditoría cartera activa ===');
  console.log('Préstamos activos:', prestamos.length);
  console.log('Con remanentes parciales:', problemas.filter((x) => x.parciales.length).length);
  console.log('Con residuos < C$1:', problemas.filter((x) => x.fantasmas).length);
  console.log('Agenda mostraría monto bajo (sin fix):', agendaVieja);
  console.log('Vencidos en cartera:', prestamos.filter((p) => prestamoEstaVencido(p)).length);

  if (problemas.length) {
    console.log('\n--- Detalle (primeros 25) ---');
    problemas.slice(0, 25).forEach((x) => {
      console.log(
        `\n${x.nombre}${x.vencido ? ' [VENCIDO]' : ''} | saldo C$${x.saldo} | visita C$${x.visita}`
      );
      if (x.parciales.length) console.log('  Remanentes:', x.parciales);
      if (x.fantasmas) console.log('  Residuos fantasma:', x.fantasmas);
      if (Math.abs(x.monto_agenda_nuevo - x.monto_agenda_viejo) > 0.02) {
        console.log(`  Agenda: viejo C$${x.monto_agenda_viejo} → correcto C$${x.monto_agenda_nuevo}`);
      }
    });
    if (problemas.length > 25) console.log(`\n... y ${problemas.length - 25} más`);
  }

  if (apply && problemas.length) {
    const conn = await getConnection();
    try {
      await conn.beginTransaction();
      let cerrados = 0;
      for (const p of prestamos) {
        await absorberResiduosCuotas(conn, p.id);
        const [cuotas] = await conn.execute(
          `SELECT id, monto_programado, monto_pagado, estado FROM Cuotas_Calendario
           WHERE prestamo_id = ? AND estado = 'Parcial' AND deleted_at IS NULL
             AND COALESCE(monto_pagado, 0) > 0`,
          [p.id]
        );
        const visita = montoVisitaHoy(p.cuota_semanal_base, p.dias_de_cobro);
        for (const c of cuotas) {
          if (!esRemanenteParcialAgenda(c, visita)) continue;
          await conn.execute(
            `UPDATE Cuotas_Calendario SET monto_pagado = monto_programado, estado = 'Pagada',
              updated_at = NOW(), is_synced = 1 WHERE id = ?`,
            [c.id]
          );
          cerrados += 1;
        }
      }
      await conn.commit();
      console.log(`\n[APPLY] Cuotas remanente cerradas como Pagada: ${cerrados}`);
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } else if (problemas.length) {
    console.log('\nPara cerrar remanentes en BD: node src/scripts/auditar-cuotas-cartera.js --apply');
  }
}

main().finally(() => pool.end());
