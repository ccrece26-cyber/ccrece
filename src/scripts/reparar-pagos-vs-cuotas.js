/**
 * Repara préstamos donde suma(Pagos) ≠ suma(cuotas pagadas).
 * Uso: node src/scripts/reparar-pagos-vs-cuotas.js [--dry-run] [--prod]
 */
const path = require('path');
const envPath = process.argv.includes('--prod')
  ? path.join(__dirname, '../../.env.nuevo')
  : path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath });
const { getConnection, pool } = require('../config/db');
const { redistribuirCuotasDesdePagos } = require('../utils/registrarPagoNube');
const { runAuditoriaIntegridad } = require('../utils/auditoriaIntegridad');

const dryRun = process.argv.includes('--dry-run');
const TOLERANCIA = 1.5;

async function listarDescuadres(conn) {
  const [rows] = await conn.execute(
    `SELECT p.id AS prestamo_id, c.cedula, c.nombre_completo, p.estado,
            (SELECT COALESCE(SUM(monto_pagado),0) FROM Pagos pg
             WHERE pg.prestamo_id = p.id AND pg.deleted_at IS NULL) AS sum_pagos,
            (SELECT COALESCE(SUM(monto_pagado),0) FROM Cuotas_Calendario cc
             WHERE cc.prestamo_id = p.id AND cc.deleted_at IS NULL) AS sum_cuotas
     FROM Prestamos p
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL AND p.estado IN ('Activo','Pagado')
     HAVING ABS(sum_pagos - sum_cuotas) > ${TOLERANCIA}
     ORDER BY ABS(sum_pagos - sum_cuotas) DESC`
  );
  return rows.map((r) => ({
    ...r,
    sum_pagos: Number(r.sum_pagos),
    sum_cuotas: Number(r.sum_cuotas),
    diff: Number((Number(r.sum_pagos) - Number(r.sum_cuotas)).toFixed(2)),
  }));
}

async function main() {
  const conn = await getConnection();
  try {
    const antes = await listarDescuadres(conn);
    console.log(`\nPréstamos con pagos ≠ cuotas (>${TOLERANCIA}): ${antes.length}`);
    for (const r of antes) {
      console.log(
        `  ${r.nombre_completo} (${r.cedula}) [${r.estado}] pagos C$${r.sum_pagos.toFixed(2)} cuotas C$${r.sum_cuotas.toFixed(2)} diff C$${r.diff.toFixed(2)}`
      );
    }

    if (!antes.length) {
      console.log('\n✅ Nada que reparar.');
      return;
    }

    if (dryRun) {
      console.log('\n(dry-run — no se modificó la BD)');
      return;
    }

    await conn.beginTransaction();
    for (const r of antes) {
      await redistribuirCuotasDesdePagos(conn, r.prestamo_id);
      console.log(`  ✓ Reparado: ${r.nombre_completo}`);
    }
    await conn.commit();

    const despues = await listarDescuadres(conn);
    const audit = await runAuditoriaIntegridad();
    console.log(`\nTras reparación: ${despues.length} descuadre(s)`);
    console.log(`Auditoría: ${audit.problemas_total} hallazgo(s) — calificación ${audit.calificacion}`);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
