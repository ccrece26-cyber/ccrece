/**
 * Auditoría integral TiDB Cloud: saldos, pagos, cuotas, rutas, estados.
 * Uso: node src/scripts/auditar-integridad-nube.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');

const TOLERANCIA = 1.5;

function n(v) {
  return Number(v || 0);
}

function seccion(titulo) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(titulo);
  console.log('='.repeat(60));
}

async function auditarSaldosActivos() {
  const rows = await query(
    `SELECT p.id, c.cedula, c.nombre_completo, p.estado,
            p.monto_desembolsado, p.monto_total_pagar, p.saldo_pendiente, p.cuota_semanal_base,
            (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS total_pagos,
            (SELECT COUNT(*) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS n_pagos,
            (SELECT COALESCE(SUM(cc.monto_pagado), 0) FROM Cuotas_Calendario cc
             WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL) AS sum_cuotas_pagado,
            (SELECT COUNT(*) FROM Cuotas_Calendario cc
             WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL
               AND (cc.estado = 'Pagada' OR cc.monto_pagado >= cc.monto_programado - 0.01)) AS cuotas_pagadas,
            (SELECT COUNT(*) FROM Cuotas_Calendario cc
             WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL) AS cuotas_total
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL AND p.estado = 'Activo'
     ORDER BY c.nombre_completo`
  );

  const criticos = [];
  const ok = [];

  for (const r of rows) {
    const total = n(r.monto_total_pagar);
    const saldo = n(r.saldo_pendiente);
    const totalPagos = n(r.total_pagos);
    const saldoPorPagos = Math.max(0, Number((total - totalPagos).toFixed(2)));
    const saldoPorCalendario = Math.max(0, Number((total - n(r.sum_cuotas_pagado)).toFixed(2)));
    const diffPagos = Number((saldo - saldoPorPagos).toFixed(2));
    const diffCalendario = Number((saldo - saldoPorCalendario).toFixed(2));

    const issues = [];

    if (saldo < -0.01) issues.push(`Saldo negativo: C$ ${saldo.toFixed(2)}`);
    if (saldo > total + TOLERANCIA) issues.push(`Saldo C$ ${saldo.toFixed(2)} supera total a pagar C$ ${total.toFixed(2)}`);

    if (Math.abs(diffPagos) > TOLERANCIA) {
      issues.push(
        `Saldo vs pagos: registrado C$ ${saldo.toFixed(2)}, esperado C$ ${saldoPorPagos.toFixed(2)} (diff C$ ${diffPagos.toFixed(2)}) — ${totalPagos.toFixed(2)} en ${r.n_pagos} pago(s)`
      );
    }

    if (Math.abs(diffCalendario) > TOLERANCIA) {
      issues.push(
        `Saldo vs calendario: registrado C$ ${saldo.toFixed(2)}, por cuotas C$ ${saldoPorCalendario.toFixed(2)} (diff C$ ${diffCalendario.toFixed(2)})`
      );
    }

    const item = {
      cedula: r.cedula,
      nombre: r.nombre_completo,
      saldo,
      total,
      total_pagos: totalPagos,
      n_pagos: Number(r.n_pagos),
      cuotas_pagadas: Number(r.cuotas_pagadas),
      cuotas_total: Number(r.cuotas_total),
      issues,
    };

    if (issues.length) criticos.push(item);
    else ok.push(item);
  }

  return { total: rows.length, ok: ok.length, criticos };
}

async function auditarEstadosPrestamos() {
  const inconsistentes = await query(
    `SELECT p.id, c.cedula, c.nombre_completo, p.estado, p.saldo_pendiente, p.monto_total_pagar,
            (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS total_pagos
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL
       AND (
         (p.estado = 'Pagado' AND p.saldo_pendiente > 1.5)
         OR (p.estado = 'Activo' AND p.saldo_pendiente <= 0.01 AND p.monto_total_pagar > 0)
         OR (p.estado = 'Pagado' AND p.saldo_pendiente <= 0.01
             AND ABS(p.monto_total_pagar - (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos pg
                  WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL)) > 1.5)
       )
     ORDER BY c.nombre_completo`
  );
  return inconsistentes;
}

async function auditarPagosDuplicadosHoy() {
  return query(
    `SELECT p.id AS prestamo_id, c.nombre_completo, c.cedula, DATE(pg.fecha_pago) AS dia,
            COUNT(*) AS n_pagos, SUM(pg.monto_pagado) AS monto_total,
            GROUP_CONCAT(pg.id ORDER BY pg.fecha_pago SEPARATOR ', ') AS pago_ids
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE pg.deleted_at IS NULL AND p.deleted_at IS NULL
     GROUP BY p.id, c.nombre_completo, c.cedula, DATE(pg.fecha_pago)
     HAVING COUNT(*) > 1
     ORDER BY dia DESC, c.nombre_completo
     LIMIT 50`
  );
}

async function auditarPagosVsCuotas() {
  return query(
    `SELECT p.id, c.cedula, c.nombre_completo, p.estado,
            (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS sum_pagos,
            (SELECT COALESCE(SUM(monto_pagado),0) FROM Cuotas_Calendario cc
             WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL) AS sum_cuotas,
            ABS(
              (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos pg
               WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL)
              - (SELECT COALESCE(SUM(monto_pagado),0) FROM Cuotas_Calendario cc
                 WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL)
            ) AS diff
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL AND p.estado IN ('Activo','Pagado')
     HAVING diff > ${TOLERANCIA}
     ORDER BY diff DESC
     LIMIT 40`
  );
}

async function auditarRutasClientes() {
  const dupes = await query(
    `SELECT c.id, c.nombre_completo, c.cedula, c.cobrador_id,
            GROUP_CONCAT(DISTINCT u.nombre_completo ORDER BY u.nombre_completo SEPARATOR ' | ') AS en_rutas_de,
            COUNT(DISTINCT r.cobrador_id) AS n_cobradores
     FROM Clientes c
     JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
     JOIN Rutas r ON rc.ruta_id = r.id AND r.activa = 1 AND r.deleted_at IS NULL
     LEFT JOIN Usuarios u ON r.cobrador_id = u.id
     WHERE c.deleted_at IS NULL
     GROUP BY c.id, c.nombre_completo, c.cedula, c.cobrador_id
     HAVING COUNT(DISTINCT r.cobrador_id) > 1
     ORDER BY c.nombre_completo`
  );

  const desalineados = await query(
    `SELECT c.id, c.nombre_completo, c.cedula,
            uc.nombre_completo AS cobrador_asignado,
            ur.nombre_completo AS cobrador_ruta
     FROM Clientes c
     JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
     JOIN Rutas r ON rc.ruta_id = r.id AND r.activa = 1 AND r.deleted_at IS NULL
     LEFT JOIN Usuarios uc ON c.cobrador_id = uc.id
     LEFT JOIN Usuarios ur ON r.cobrador_id = ur.id
     WHERE c.deleted_at IS NULL AND c.cobrador_id IS NOT NULL
       AND r.cobrador_id IS NOT NULL AND c.cobrador_id <> r.cobrador_id
     ORDER BY c.nombre_completo`
  );

  return { dupes, desalineados };
}

async function auditarClientesMultiplesActivos() {
  return query(
    `SELECT c.cedula, c.nombre_completo, COUNT(*) AS prestamos_activos,
            GROUP_CONCAT(p.id ORDER BY p.fecha_desembolso SEPARATOR ', ') AS prestamo_ids
     FROM Clientes c
     JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
     WHERE c.deleted_at IS NULL
     GROUP BY c.id, c.cedula, c.nombre_completo
     HAVING COUNT(*) > 1
     ORDER BY c.nombre_completo`
  );
}

async function resumenGeneral() {
  const [row] = await query(
    `SELECT
       (SELECT COUNT(*) FROM Clientes WHERE deleted_at IS NULL) AS clientes,
       (SELECT COUNT(*) FROM Prestamos WHERE deleted_at IS NULL AND estado = 'Activo') AS prestamos_activos,
       (SELECT COUNT(*) FROM Prestamos WHERE deleted_at IS NULL AND estado = 'Pagado') AS prestamos_pagados,
       (SELECT COUNT(*) FROM Pagos WHERE deleted_at IS NULL) AS total_pagos,
       (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos WHERE deleted_at IS NULL) AS monto_total_pagos,
       (SELECT COALESCE(SUM(saldo_pendiente),0) FROM Prestamos WHERE deleted_at IS NULL AND estado = 'Activo') AS cartera_activa,
       (SELECT COUNT(*) FROM Pagos WHERE deleted_at IS NULL AND DATE(fecha_pago) = CURDATE()) AS pagos_hoy,
       (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos WHERE deleted_at IS NULL AND DATE(fecha_pago) = CURDATE()) AS monto_pagos_hoy`
  );
  return row;
}

async function auditarPagosHoyNicaragua() {
  const { rangoDiaLocal } = require('../utils/fechasSql');
  const { inicio, fin } = rangoDiaLocal(new Date());
  return query(
    `SELECT pg.id, c.nombre_completo, c.cedula, pg.monto_pagado, pg.fecha_pago,
            u.nombre_completo AS cobrador, p.estado AS estado_prestamo, p.saldo_pendiente
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     LEFT JOIN Usuarios u ON pg.cobrador_id = u.id
     WHERE pg.deleted_at IS NULL AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
     ORDER BY pg.fecha_pago DESC`,
    [inicio, fin]
  );
}

async function main() {
  console.log('\n🔍 AUDITORÍA DE INTEGRIDAD — TiDB Cloud');
  console.log(`Fecha: ${new Date().toISOString()}\n`);

  const resumen = await resumenGeneral();
  seccion('RESUMEN GENERAL');
  console.log(`  Clientes:           ${resumen.clientes}`);
  console.log(`  Préstamos activos:  ${resumen.prestamos_activos}`);
  console.log(`  Préstamos pagados:  ${resumen.prestamos_pagados}`);
  console.log(`  Cartera activa:     C$ ${n(resumen.cartera_activa).toLocaleString('es-NI', { minimumFractionDigits: 2 })}`);
  console.log(`  Total pagos hist.:  ${resumen.total_pagos} (C$ ${n(resumen.monto_total_pagos).toLocaleString('es-NI', { minimumFractionDigits: 2 })})`);
  console.log(`  Pagos hoy (UTC día): ${resumen.pagos_hoy} (C$ ${n(resumen.monto_pagos_hoy).toLocaleString('es-NI', { minimumFractionDigits: 2 })})`);

  const saldos = await auditarSaldosActivos();
  seccion(`SALDOS PRÉSTAMOS ACTIVOS (${saldos.total})`);
  console.log(`  ✓ OK: ${saldos.ok}  |  ⚠ Con descuadre: ${saldos.criticos.length}`);
  if (saldos.criticos.length) {
    for (const c of saldos.criticos) {
      console.log(`\n  ${c.nombre} (${c.cedula})`);
      console.log(`    Saldo C$ ${c.saldo.toFixed(2)} / Total C$ ${c.total.toFixed(2)} | Pagos: ${c.n_pagos} (C$ ${c.total_pagos.toFixed(2)}) | Cuotas: ${c.cuotas_pagadas}/${c.cuotas_total}`);
      for (const iss of c.issues) console.log(`    ⚠ ${iss}`);
    }
  }

  const estados = await auditarEstadosPrestamos();
  seccion(`ESTADOS INCONSISTENTES (${estados.length})`);
  if (!estados.length) console.log('  ✓ Ninguno');
  for (const e of estados) {
    console.log(
      `  ⚠ ${e.nombre_completo} (${e.cedula}) — estado=${e.estado}, saldo=C$ ${n(e.saldo_pendiente).toFixed(2)}, pagos=C$ ${n(e.total_pagos).toFixed(2)}`
    );
  }

  const pagosCuotas = await auditarPagosVsCuotas();
  seccion(`PAGOS ≠ CUOTAS (suma acumulada, diff > C$ ${TOLERANCIA}) — ${pagosCuotas.length}`);
  if (!pagosCuotas.length) console.log('  ✓ Ninguno');
  for (const p of pagosCuotas.slice(0, 15)) {
    console.log(
      `  ⚠ ${p.nombre_completo} (${p.cedula}) [${p.estado}] pagos=C$ ${n(p.sum_pagos).toFixed(2)} cuotas=C$ ${n(p.sum_cuotas).toFixed(2)} diff=C$ ${n(p.diff).toFixed(2)}`
    );
  }
  if (pagosCuotas.length > 15) console.log(`  … y ${pagosCuotas.length - 15} más`);

  const dupPagos = await auditarPagosDuplicadosHoy();
  seccion(`MÚLTIPLES PAGOS MISMO DÍA / PRÉSTAMO — ${dupPagos.length}`);
  if (!dupPagos.length) console.log('  ✓ Ninguno');
  for (const d of dupPagos) {
    console.log(
      `  ⚠ ${d.nombre_completo} (${d.dia}) — ${d.n_pagos} pagos, C$ ${n(d.monto_total).toFixed(2)} [${d.pago_ids}]`
    );
  }

  const rutas = await auditarRutasClientes();
  seccion(`RUTAS Y COBRADORES`);
  console.log(`  Clientes en 2+ rutas activas: ${rutas.dupes.length}`);
  for (const d of rutas.dupes) console.log(`    ⚠ ${d.nombre_completo} — rutas: ${d.en_rutas_de}`);
  console.log(`  Cliente asignado ≠ cobrador de ruta: ${rutas.desalineados.length}`);
  for (const d of rutas.desalineados.slice(0, 10)) {
    console.log(`    ⚠ ${d.nombre_completo} — asignado: ${d.cobrador_asignado}, ruta: ${d.cobrador_ruta}`);
  }
  if (rutas.desalineados.length > 10) console.log(`    … y ${rutas.desalineados.length - 10} más`);

  const multiActivos = await auditarClientesMultiplesActivos();
  seccion(`CLIENTES CON 2+ PRÉSTAMOS ACTIVOS — ${multiActivos.length}`);
  if (!multiActivos.length) console.log('  ✓ Ninguno');
  for (const m of multiActivos) {
    console.log(`  ⚠ ${m.nombre_completo} (${m.cedula}) — ${m.prestamos_activos} activos`);
  }

  const pagosHoy = await auditarPagosHoyNicaragua();
  seccion(`PAGOS HOY (zona Nicaragua) — ${pagosHoy.length}`);
  for (const p of pagosHoy) {
    console.log(
      `  ${p.nombre_completo} — C$ ${n(p.monto_pagado).toFixed(2)} | ${p.cobrador || '—'} | préstamo ${p.estado_prestamo} saldo C$ ${n(p.saldo_pendiente).toFixed(2)}`
    );
  }

  seccion('VEREDICTO');
  const problemas =
    saldos.criticos.length +
    estados.length +
    pagosCuotas.length +
    dupPagos.length +
    rutas.dupes.length +
    multiActivos.length;

  if (problemas === 0) {
    console.log('  ✅ Integridad general: BUENA — no se detectaron descuadres relevantes.');
  } else {
    console.log(`  ⚠ Se encontraron ${problemas} hallazgo(s) que revisar.`);
    console.log('  Recomendación: corregir manualmente casos críticos o ejecutar reparar-descuadres-saldo.js por cédula.');
  }

  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
