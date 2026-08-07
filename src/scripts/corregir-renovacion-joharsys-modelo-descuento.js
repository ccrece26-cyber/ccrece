/**
 * Corrige renovación de Joharsys (CC-235) al modelo nuevo:
 * - Recibo / base = monto de renovación (efectivo solicitado, p.ej. 15,000) — sin sumar arrastre
 * - Interés sobre ese recibo
 * - Efectivo en mano = recibo − saldo anterior
 * - Pago del saldo anterior en el crédito viejo (cumplimiento cobrador) + estado Pagado
 *
 *   CONFIRM_CORREGIR_JOHARSYS=yes node src/scripts/corregir-renovacion-joharsys-modelo-descuento.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { v4: uuidv4 } = require('uuid');
const { query, getConnection, pool } = require('../config/db');
const { calcularCuotaYDistribucion } = require('../utils/finanzasNube');
const { resolverFrecuenciaCobro } = require('../utils/frecuenciaCobro');
const { bumpCarteraVersion } = require('../utils/carteraVersion');

const APPLY = process.env.CONFIRM_CORREGIR_JOHARSYS === 'yes';
const COD = 'CC-235';
const TASA_MENSUAL = 0.1;

const money = (n) => Number(Number(n).toFixed(2));

async function main() {
  const rows = await query(
    `SELECT c.id AS codigo, c.nombre_completo, c.cobrador_id,
            pa.id AS ant_id, pa.estado AS ant_estado, pa.saldo_pendiente AS ant_saldo,
            pa.monto_total_pagar AS ant_total, pa.monto_desembolsado AS ant_desemb,
            pn.id AS nue_id, pn.estado AS nue_estado, pn.monto_desembolsado AS nue_desemb,
            pn.monto_total_pagar AS nue_total, pn.saldo_pendiente AS nue_saldo,
            pn.plazo_semanas, pn.tasa_interes_aplicada, pn.cuota_semanal_base,
            pn.fecha_desembolso, pn.dias_de_cobro, pn.cobrador_registro_id, pn.cobrador_entrega_id,
            r.id AS log_id, r.saldo_pendiente_anterior, r.nuevo_desembolso, r.base_nominal,
            r.efectivo_entregar, r.fecha_renovacion,
            (SELECT COALESCE(SUM(pg.monto_pagado),0) FROM Pagos pg
              WHERE pg.prestamo_id = pn.id AND pg.deleted_at IS NULL) AS pagado_nuevo,
            (SELECT COALESCE(SUM(pg.monto_pagado),0) FROM Pagos pg
              WHERE pg.prestamo_id = pa.id AND pg.deleted_at IS NULL) AS pagado_ant
     FROM Clientes c
     JOIN Prestamos pn ON pn.cliente_id = c.id AND pn.deleted_at IS NULL AND pn.estado = 'Activo'
     LEFT JOIN Renovaciones_Log r ON r.prestamo_nuevo_id = pn.id AND (r.deleted_at IS NULL OR r.deleted_at = 0)
     LEFT JOIN Prestamos pa ON pa.id = COALESCE(r.prestamo_anterior_id, pn.renovacion_previa_id)
     WHERE c.id = ?
     ORDER BY r.fecha_renovacion DESC
     LIMIT 1`,
    [COD]
  );

  if (!rows.length) {
    console.error('No hay préstamo activo de renovación para', COD);
    process.exit(1);
  }
  const r = rows[0];
  console.log('Antes:', {
    ant_id: r.ant_id,
    ant_estado: r.ant_estado,
    ant_saldo: r.ant_saldo,
    pagado_ant: r.pagado_ant,
    nue_id: r.nue_id,
    nue_desemb: r.nue_desemb,
    nue_total: r.nue_total,
    nue_saldo: r.nue_saldo,
    pagado_nuevo: r.pagado_nuevo,
    log: {
      saldo_ant: r.saldo_pendiente_anterior,
      nuevo_desembolso: r.nuevo_desembolso,
      base: r.base_nominal,
      efectivo: r.efectivo_entregar,
    },
  });

  // Monto de recibo/renovación = efectivo solicitado originalmente (no base con arrastre)
  // Preferir log.nuevo_desembolso si era el efectivo; si log y desemb son iguales a base antigua,
  // derivar: si base ≈ saldo+X, X es el recibo.
  let saldoAnt = money(r.saldo_pendiente_anterior);
  if (!(saldoAnt > 0) && r.ant_id) {
    // reconstruir desde diferencia base vieja - desembolso viejo típico 2900
    const base = money(r.base_nominal || r.nue_desemb);
    const cand = money(r.nuevo_desembolso);
    if (cand > 0 && money(base - cand) > 0) saldoAnt = money(base - cand);
  }
  if (!(saldoAnt > 0)) saldoAnt = 2900; // valor de la operación Joharsys conocida

  let montoRecibo = money(r.nuevo_desembolso);
  const baseLog = money(r.base_nominal || 0);
  // si nuevo_desembolso era el efectivo y base era arrastre+efectivo
  if (baseLog > montoRecibo + 0.5 && money(baseLog - montoRecibo) === money(saldoAnt)) {
    // modelo viejo: nuevo_desembolso = efectivo, recibo deseado = efectivo (ex: 15000)
    montoRecibo = money(r.nuevo_desembolso);
  } else if (baseLog > 0 && Math.abs(baseLog - money(r.nue_desemb)) < 0.05) {
    // modelo viejo con monto_desembolsado = base: recibo = base - saldo
    montoRecibo = money(baseLog - saldoAnt);
  }
  if (!(montoRecibo > 0)) montoRecibo = 15000;

  const plazo = Number(r.plazo_semanas) || 12;
  const freq = resolverFrecuenciaCobro({ dias_cobro: r.dias_de_cobro || 'SABADO' });
  const calc = calcularCuotaYDistribucion(montoRecibo, plazo, freq.diasParaAgenda, TASA_MENSUAL, {
    tipo_frecuencia: freq.tipo,
    dias_mes: freq.diasMes,
  });
  const efectivo = money(montoRecibo - saldoAnt);
  const totalNuevo = money(calc.montoTotalPagar);
  const pagadoNuevo = money(r.pagado_nuevo);
  const nuevoSaldo = Math.max(0, money(totalNuevo - pagadoNuevo));

  const preview = {
    saldo_anterior: saldoAnt,
    monto_recibo: montoRecibo,
    efectivo_mano: efectivo,
    tasa: calc.tasaInteresAplicada,
    total_nuevo: totalNuevo,
    cuota: calc.cuotaSemanalBase,
    saldo_nuevo_tras: nuevoSaldo,
    pagado_nuevo: pagadoNuevo,
  };
  console.log('Objetivo modelo descuento:', preview);

  if (!APPLY) {
    console.log('Dry-run. CONFIRM_CORREGIR_JOHARSYS=yes para aplicar.');
    await pool.end();
    return;
  }

  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    // 1) Pago del saldo en el crédito anterior (si no existe ya un pago de ese monto en la fecha)
    if (r.ant_id && saldoAnt > 0.01) {
      const [dup] = await conn.execute(
        `SELECT id FROM Pagos
         WHERE prestamo_id = ? AND deleted_at IS NULL
           AND ABS(monto_pagado - ?) < 0.05
           AND fecha_pago >= DATE_SUB(?, INTERVAL 1 DAY)
           AND fecha_pago < DATE_ADD(?, INTERVAL 2 DAY)
         LIMIT 1`,
        [r.ant_id, saldoAnt, r.fecha_desembolso || r.fecha_renovacion, r.fecha_desembolso || r.fecha_renovacion]
      );
      if (!dup.length) {
        const pagoId = uuidv4();
        const diaRaw = String(r.fecha_desembolso || r.fecha_renovacion || '2026-08-03').slice(0, 10);
        const diaISO = /^\d{4}-\d{2}-\d{2}$/.test(diaRaw)
          ? diaRaw
          : new Date(r.fecha_desembolso || r.fecha_renovacion).toISOString().slice(0, 10);
        const fechaPago = `${diaISO} 18:00:00`;
        await conn.execute(
          `INSERT INTO Pagos (
            id, prestamo_id, cobrador_id, monto_pagado, fecha_pago, latitud, longitud,
            registrado_por_admin, operador_id, is_synced
          ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 1)`,
          [
            pagoId,
            r.ant_id,
            r.cobrador_id || r.cobrador_entrega_id || r.cobrador_registro_id,
            saldoAnt,
            fechaPago,
            r.cobrador_registro_id && r.cobrador_id && r.cobrador_registro_id !== r.cobrador_id ? 1 : 0,
            r.cobrador_registro_id || r.cobrador_id,
          ]
        );
        console.log('Pago saldo insertado', pagoId, saldoAnt);
      } else {
        console.log('Pago saldo ya existía', dup[0].id);
      }

      await conn.execute(
        `UPDATE Prestamos SET estado = 'Pagado', saldo_pendiente = 0, updated_at = NOW(), is_synced = 1 WHERE id = ?`,
        [r.ant_id]
      );
    }

    // 2) Ajustar préstamo nuevo: recibo = montoRecibo, total recalculado, saldo = total - pagado
    await conn.execute(
      `UPDATE Prestamos SET
         monto_desembolsado = ?,
         tasa_interes_aplicada = ?,
         cuota_semanal_base = ?,
         monto_total_pagar = ?,
         saldo_pendiente = ?,
         updated_at = NOW(),
         is_synced = 1
       WHERE id = ?`,
      [
        montoRecibo,
        calc.tasaInteresAplicada,
        calc.cuotaSemanalBase,
        totalNuevo,
        nuevoSaldo,
        r.nue_id,
      ]
    );

    // 3) Log
    if (r.log_id) {
      await conn.execute(
        `UPDATE Renovaciones_Log SET
           saldo_pendiente_anterior = ?,
           nuevo_desembolso = ?,
           base_nominal = ?,
           tasa_aplicada = ?,
           monto_total_a_pagar = ?,
           cuota_semanal = ?,
           efectivo_entregar = ?,
           is_synced = 1,
           updated_at = NOW()
         WHERE id = ?`,
        [
          saldoAnt,
          montoRecibo,
          montoRecibo,
          calc.tasaInteresAplicada,
          totalNuevo,
          calc.cuotaSemanalBase,
          efectivo,
          r.log_id,
        ]
      );
    }

    await conn.commit();
    try {
      await bumpCarteraVersion(conn);
    } catch {
      /* optional */
    }
    console.log('OK Joharsys corregido', preview);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {
    /* */
  }
  process.exit(1);
});
