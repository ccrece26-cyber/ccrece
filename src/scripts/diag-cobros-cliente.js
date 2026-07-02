require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

const buscar = process.argv.slice(2).filter((a) => !/^\d+(\.\d+)?$/.test(a)).join(' ') || 'andrea isabel gonzalez';
const montoFiltro = process.argv.slice(2).find((a) => /^\d+(\.\d+)?$/.test(a));

async function main() {
  const clientes = await query(
    `SELECT c.id, c.nombre_completo, c.cedula
     FROM Clientes c
     WHERE LOWER(c.nombre_completo) LIKE ? AND c.deleted_at IS NULL`,
    [`%${buscar.toLowerCase()}%`]
  );

  if (!clientes.length) {
    console.log('Cliente no encontrado:', buscar);
    return;
  }

  for (const c of clientes) {
    const prestamos = await query(
      `SELECT id, estado, saldo_pendiente, cuota_semanal_base, fecha_desembolso
       FROM Prestamos WHERE cliente_id = ? AND deleted_at IS NULL ORDER BY fecha_desembolso DESC`,
      [c.id]
    );

    console.log('\n===', c.nombre_completo, '|', c.cedula, '===');

    for (const p of prestamos) {
      console.log('\nPrestamo:', p.id);
      console.log('  Estado:', p.estado, '| Saldo:', p.saldo_pendiente, '| Cuota sem:', p.cuota_semanal_base);

      let sql = `
        SELECT pg.id, pg.monto_pagado, pg.fecha_pago,
               pg.registrado_por_admin, pg.cobrador_id, pg.operador_id,
               pg.latitud, pg.longitud, pg.deleted_at, pg.updated_at,
               uc.nombre_completo AS cobrador_nombre, uc.email AS cobrador_email,
               uo.nombre_completo AS operador_nombre, uo.email AS operador_email,
               r.nombre AS rol_operador
        FROM Pagos pg
        LEFT JOIN Usuarios uc ON pg.cobrador_id = uc.id
        LEFT JOIN Usuarios uo ON pg.operador_id = uo.id
        LEFT JOIN Roles r ON uo.rol_id = r.id
        WHERE pg.prestamo_id = ?
      `;
      const params = [p.id];
      if (montoFiltro) {
        sql += ` AND ABS(pg.monto_pagado - ?) < 0.02`;
        params.push(Number(montoFiltro));
      }
      sql += ` ORDER BY pg.fecha_pago DESC`;

      const pagos = await query(sql, params);
      console.log(`\n  Pagos${montoFiltro ? ` ~C$${montoFiltro}` : ''} (${pagos.length}):`);
      for (const pg of pagos) {
        const quien =
          Number(pg.registrado_por_admin) === 1
            ? `ADMIN campo: ${pg.operador_nombre || pg.operador_id || '?'}`
            : `Cobrador: ${pg.cobrador_nombre || pg.cobrador_id || '?'}`;
        const anulado = pg.deleted_at ? ` [ANULADO ${pg.deleted_at}]` : '';
        console.log(`  - C$${pg.monto_pagado} | ${pg.fecha_pago} | ${quien}${anulado}`);
        console.log(`    id=${pg.id} operador=${pg.operador_nombre || '-'} rol=${pg.rol_operador || '-'} upd=${pg.updated_at || '-'}`);
      }

      const parciales = await query(
        `SELECT fecha_programada, monto_programado, monto_pagado, estado, updated_at
         FROM Cuotas_Calendario
         WHERE prestamo_id = ? AND deleted_at IS NULL
           AND estado IN ('Programada','Parcial') AND monto_pagado > 0
         ORDER BY fecha_programada`,
        [p.id]
      );
      if (parciales.length) {
        console.log('\n  Cuotas con abono parcial:');
        parciales.forEach((cc) => {
          const pend = +(Number(cc.monto_programado) - Number(cc.monto_pagado)).toFixed(2);
          console.log(`  - ${cc.fecha_programada} prog=${cc.monto_programado} pag=${cc.monto_pagado} pend=${pend} | ${cc.estado} | upd=${cc.updated_at}`);
        });
      }
    }
  }
}

main().finally(() => pool.end());
