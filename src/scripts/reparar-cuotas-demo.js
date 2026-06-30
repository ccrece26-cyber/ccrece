/**
 * Corrige saldos vs pagos/cuotas (carga masiva) y cuotas de visita demasiado bajas (< C$5).
 * Uso: node src/scripts/reparar-cuotas-demo.js
 *      node src/scripts/reparar-cuotas-demo.js --dry-run
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, getConnection, pool } = require('../config/db');
const { aplicarMontoACuotas } = require('../utils/registrarPagoNube');
const { montoVisitaHoy } = require('../utils/diasCobro');

const TOLERANCIA = 1.5;
const MIN_CUOTA_VISITA = 5;
const dryRun = process.argv.includes('--dry-run');

function n(v) {
  return Number(v || 0);
}

async function listarDescuadrados() {
  const rows = await query(`
    SELECT p.id AS prestamo_id, p.estado, p.monto_total_pagar, p.saldo_pendiente,
           p.cuota_semanal_base, p.dias_de_cobro,
           c.cedula, c.nombre_completo,
           (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg
            WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS total_pagos,
           (SELECT COALESCE(SUM(monto_pagado), 0) FROM Cuotas_Calendario cc
            WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL) AS sum_cuotas
    FROM Prestamos p
    JOIN Clientes c ON p.cliente_id = c.id
    WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL AND p.estado IN ('Activo', 'Pagado')
    ORDER BY c.nombre_completo`);
  return rows
    .map((row) => {
      const total = n(row.monto_total_pagar);
      const saldo = n(row.saldo_pendiente);
      const pagos = n(row.total_pagos);
      const cuotas = n(row.sum_cuotas);
      const saldoPorPagos = Math.max(0, Number((total - pagos).toFixed(2)));
      const saldoPorCuotas = Math.max(0, Number((total - cuotas).toFixed(2)));
      const cerradoMal = row.estado === 'Pagado' && pagos + TOLERANCIA < total;
      const tienePagos = pagos > TOLERANCIA;
      let modo = null;
      if (cerradoMal) modo = 'pagos';
      else if (tienePagos && (Math.abs(saldo - saldoPorPagos) > TOLERANCIA || Math.abs(pagos - cuotas) > TOLERANCIA)) {
        modo = 'pagos';
      } else if (!tienePagos && Math.abs(saldo - saldoPorCuotas) > TOLERANCIA) {
        modo = 'cuotas';
      }
      return {
        ...row,
        modo,
        saldoNuevo: modo === 'pagos' ? saldoPorPagos : modo === 'cuotas' ? saldoPorCuotas : saldo,
        estadoNuevo: modo && (modo === 'pagos' ? saldoPorPagos : saldoPorCuotas) <= 0.01 ? 'Pagado' : 'Activo',
      };
    })
    .filter((r) => r.modo);
}

async function repararSaldos(conn, items) {
  let ok = 0;
  for (const item of items) {
    if (dryRun) {
      ok++;
      continue;
    }
    if (item.modo === 'pagos') {
      await conn.execute(
        `UPDATE Cuotas_Calendario SET monto_pagado = 0, estado = 'Programada', updated_at = NOW(), is_synced = 1
         WHERE prestamo_id = ? AND deleted_at IS NULL`,
        [item.prestamo_id]
      );
      const [pagosRows] = await conn.execute(
        `SELECT monto_pagado FROM Pagos WHERE prestamo_id = ? AND deleted_at IS NULL ORDER BY fecha_pago ASC, id ASC`,
        [item.prestamo_id]
      );
      for (const pg of pagosRows) {
        await aplicarMontoACuotas(conn, item.prestamo_id, n(pg.monto_pagado));
      }
    }
    await conn.execute(
      `UPDATE Prestamos SET saldo_pendiente = ?, estado = ?, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
      [item.saldoNuevo, item.estadoNuevo, item.prestamo_id]
    );
    ok++;
  }
  return ok;
}

async function repararCuotasBajas(conn) {
  const prestamos = await query(`
    SELECT p.id, p.saldo_pendiente, p.cuota_semanal_base, p.dias_de_cobro, p.estado
    FROM Prestamos p WHERE p.estado = 'Activo' AND p.deleted_at IS NULL AND p.saldo_pendiente > 0.01`);
  let ajustadas = 0;
  for (const p of prestamos) {
    const visita = montoVisitaHoy(p.cuota_semanal_base, p.dias_de_cobro);
    if (visita < MIN_CUOTA_VISITA) continue;
    const [cuotas] = dryRun
      ? await query(
          `SELECT id, monto_programado, monto_pagado, estado, fecha_programada
           FROM Cuotas_Calendario WHERE prestamo_id = ? AND estado IN ('Programada','Parcial') AND deleted_at IS NULL
           ORDER BY fecha_programada ASC`,
          [p.id]
        )
      : await conn.execute(
          `SELECT id, monto_programado, monto_pagado, estado, fecha_programada
           FROM Cuotas_Calendario WHERE prestamo_id = ? AND estado IN ('Programada','Parcial') AND deleted_at IS NULL
           ORDER BY fecha_programada ASC`,
          [p.id]
        );
    let saldoRest = n(p.saldo_pendiente);
    for (const cc of cuotas) {
      const pend = Math.max(0, n(cc.monto_programado) - n(cc.monto_pagado));
      if (pend > 0 && pend < MIN_CUOTA_VISITA && saldoRest >= MIN_CUOTA_VISITA) {
        const nuevo = Number(Math.min(visita, saldoRest).toFixed(2));
        if (nuevo >= MIN_CUOTA_VISITA || (saldoRest <= MIN_CUOTA_VISITA && nuevo > pend)) {
          const montoProg = Number((n(cc.monto_pagado) + nuevo).toFixed(2));
          if (!dryRun) {
            await conn.execute(
              `UPDATE Cuotas_Calendario SET monto_programado = ?, estado = 'Programada', updated_at = NOW(), is_synced = 1 WHERE id = ?`,
              [montoProg, cc.id]
            );
          }
          ajustadas++;
          saldoRest = Math.max(0, saldoRest - nuevo);
        }
      } else {
        saldoRest = Math.max(0, saldoRest - pend);
      }
    }
  }
  return ajustadas;
}

async function main() {
  const descuadrados = await listarDescuadrados();
  console.log(`${dryRun ? 'DRY-RUN' : 'REPARAR'} — ${descuadrados.length} préstamos con saldo desfasado`);

  const conn = await getConnection();
  try {
    if (!dryRun) await conn.beginTransaction();
    const saldosOk = await repararSaldos(conn, descuadrados);
    const cuotasOk = await repararCuotasBajas(conn);
    if (!dryRun) await conn.commit();
    console.log(`✅ Saldos reparados: ${saldosOk}`);
    console.log(`✅ Cuotas de visita ajustadas (< C$${MIN_CUOTA_VISITA}): ${cuotasOk}`);

    const cob = await query(`SELECT id FROM Usuarios WHERE email='cobrador2' LIMIT 1`);
    if (cob[0]?.id) {
      const { buildAgendaCobrador } = require('../utils/agendaCobrador');
      const agenda = await buildAgendaCobrador(query, cob[0].id);
      const bajos = agenda.agenda.filter((a) => Number(a.monto_programado || 0) < MIN_CUOTA_VISITA);
      console.log(`Agenda cobrador2 con monto < ${MIN_CUOTA_VISITA}: ${bajos.length} / ${agenda.agenda.length}`);
      bajos.slice(0, 5).forEach((a) =>
        console.log(`  ${a.nombre_completo?.slice(0, 32)} monto=${a.monto_programado} saldo=${a.saldo_pendiente}`)
      );
    }
  } catch (e) {
    if (!dryRun) await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

main()
  .catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
