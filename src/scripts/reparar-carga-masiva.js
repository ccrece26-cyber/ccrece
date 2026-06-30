/**
 * Repara saldos y calendario desfasados por carga masiva inicial.
 *
 * Reglas:
 * - Con pagos reales en Pagos: fuente de verdad = suma(Pagos). Resetea cuotas y reaplica.
 * - Sin pagos (solo historial virtual en cuotas): saldo = total − suma(cuotas pagadas).
 * - Cerrado (Pagado) con pagos < total: reabre como Activo.
 *
 * Uso:
 *   node src/scripts/reparar-carga-masiva.js              # vista previa
 *   node src/scripts/reparar-carga-masiva.js --apply      # aplicar todos
 *   node src/scripts/reparar-carga-masiva.js --apply 0019900080008H
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query, getConnection } = require('../config/db');
const { aplicarMontoACuotas } = require('../utils/registrarPagoNube');

const TOLERANCIA = 1.5;
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const cedulaFiltro = args.find((a) => !a.startsWith('--')) || null;

function n(v) {
  return Number(v || 0);
}

function analizar(row) {
  const total = n(row.monto_total_pagar);
  const saldo = n(row.saldo_pendiente);
  const pagos = n(row.total_pagos);
  const cuotas = n(row.sum_cuotas);
  const saldoPorPagos = Math.max(0, Number((total - pagos).toFixed(2)));
  const saldoPorCuotas = Math.max(0, Number((total - cuotas).toFixed(2)));
  const cerradoMal = row.estado === 'Pagado' && pagos + TOLERANCIA < total;
  const tienePagosReales = pagos > TOLERANCIA;

  let modo = null;
  let motivo = '';

  if (cerradoMal) {
    modo = 'pagos';
    motivo = 'Cerrado como Pagado pero faltan abonos reales';
  } else if (tienePagosReales) {
    if (Math.abs(saldo - saldoPorPagos) > TOLERANCIA || Math.abs(pagos - cuotas) > TOLERANCIA) {
      modo = 'pagos';
      motivo = 'Saldo/cuotas no coinciden con pagos registrados';
    }
  } else if (Math.abs(saldo - saldoPorCuotas) > TOLERANCIA) {
    modo = 'cuotas';
    motivo = 'Saldo no coincide con calendario (sin pagos en app aún)';
  }

  return {
    ...row,
    total,
    saldo,
    pagos,
    cuotas,
    saldoPorPagos,
    saldoPorCuotas,
    modo,
    motivo,
    saldoNuevo: modo === 'pagos' ? saldoPorPagos : modo === 'cuotas' ? saldoPorCuotas : saldo,
    estadoNuevo:
      modo && (modo === 'pagos' ? saldoPorPagos : saldoPorCuotas) <= 0.01 ? 'Pagado' : 'Activo',
  };
}

async function listarAfectados() {
  let sql = `
    SELECT p.id AS prestamo_id, p.estado, p.monto_total_pagar, p.saldo_pendiente,
           c.cedula, c.nombre_completo,
           (SELECT COALESCE(SUM(monto_pagado), 0) FROM Pagos pg
            WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS total_pagos,
           (SELECT COALESCE(SUM(monto_pagado), 0) FROM Cuotas_Calendario cc
            WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL) AS sum_cuotas
    FROM Prestamos p
    JOIN Clientes c ON p.cliente_id = c.id
    WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL
      AND p.estado IN ('Activo', 'Pagado')
  `;
  const params = [];
  if (cedulaFiltro) {
    sql += ' AND c.cedula = ?';
    params.push(cedulaFiltro);
  }
  sql += ' ORDER BY c.nombre_completo';
  const rows = await query(sql, params);
  return rows.map(analizar).filter((r) => r.modo);
}

async function resetearCuotas(conn, prestamoId) {
  await conn.execute(
    `UPDATE Cuotas_Calendario
     SET monto_pagado = 0, estado = 'Programada', updated_at = NOW(), is_synced = 1
     WHERE prestamo_id = ? AND deleted_at IS NULL`,
    [prestamoId]
  );
}

async function repararPrestamo(conn, item) {
  const prestamoId = item.prestamo_id;

  if (APPLY) {
    if (item.modo === 'pagos') {
      await resetearCuotas(conn, prestamoId);
      const [pagosRows] = await conn.execute(
        `SELECT monto_pagado FROM Pagos
         WHERE prestamo_id = ? AND deleted_at IS NULL
         ORDER BY fecha_pago ASC, id ASC`,
        [prestamoId]
      );
      for (const pg of pagosRows) {
        await aplicarMontoACuotas(conn, prestamoId, n(pg.monto_pagado));
      }
    }
    await conn.execute(
      `UPDATE Prestamos
       SET saldo_pendiente = ?, estado = ?, updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [item.saldoNuevo, item.estadoNuevo, prestamoId]
    );
  }

  return {
    cedula: item.cedula,
    nombre: item.nombre_completo,
    modo: item.modo,
    motivo: item.motivo,
    estado_antes: item.estado,
    estado_despues: item.estadoNuevo,
    saldo_antes: item.saldo,
    saldo_despues: item.saldoNuevo,
    pagos_reales: item.pagos,
    cuotas_antes: item.cuotas,
    ajuste: Number((item.saldoNuevo - item.saldo).toFixed(2)),
  };
}

async function main() {
  const afectados = await listarAfectados();
  console.log(`\n${APPLY ? '🔧 REPARACIÓN' : '👀 VISTA PREVIA (dry-run)'} — carga masiva`);
  if (cedulaFiltro) console.log(`Filtro cédula: ${cedulaFiltro}`);
  console.log(`Préstamos a corregir: ${afectados.length}\n`);

  if (!afectados.length) {
    console.log('✅ No hay préstamos con descuadre por reparar.\n');
    process.exit(0);
  }

  const conn = await getConnection();
  const resultados = [];
  try {
    if (APPLY) await conn.beginTransaction();
    for (const item of afectados) {
      resultados.push(await repararPrestamo(conn, item));
    }
    if (APPLY) await conn.commit();
  } catch (e) {
    if (APPLY) await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  console.table(resultados);
  const masCobrar = resultados.reduce((s, r) => s + Math.max(0, r.ajuste), 0);
  console.log(
    `\n${APPLY ? '✅ Cambios aplicados en TiDB' : 'ℹ️  Sin cambios (use --apply para ejecutar)'}`
  );
  console.log(`Saldo pendiente adicional en cartera (solo aumentos): C$ ${masCobrar.toFixed(2)}\n`);

  if (!APPLY) {
    console.log('Auditar antes:  node src/scripts/auditar-integridad-nube.js');
    console.log('Aplicar todo:   node src/scripts/reparar-carga-masiva.js --apply');
    console.log('Solo un cliente: node src/scripts/reparar-carga-masiva.js --apply CEDULA\n');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
