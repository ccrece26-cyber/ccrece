/**
 * Clientes con cobrador asignado pero sin Ruta_Clientes en la ruta de ese cobrador.
 *   node src/scripts/listar-clientes-sin-ruta.js
 *   node src/scripts/listar-clientes-sin-ruta.js --fix
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const path = require('path');
const XLSX = require('xlsx');
const { query, pool } = require('../config/db');
const { sincronizarRutaClienteAsignado, optimizarOrdenRuta } = require('../utils/rutas');
const { bumpCarteraVersion } = require('../utils/carteraVersion');

const OUT = path.join(__dirname, '../../../Clientes_sin_ruta.xlsx');
const FIX = process.argv.includes('--fix');

(async () => {
  const rows = await query(`
    SELECT c.id AS codigo,
           c.nombre_completo,
           c.cobrador_id,
           u.nombre_completo AS cobrador,
           p.id AS prestamo_id,
           p.estado AS prestamo_estado,
           p.saldo_pendiente,
           p.dias_de_cobro,
           p.fecha_desembolso
    FROM Clientes c
    JOIN Usuarios u ON u.id = c.cobrador_id AND u.deleted_at IS NULL
    LEFT JOIN Prestamos p ON p.cliente_id = c.id AND p.deleted_at IS NULL AND p.estado = 'Activo'
    LEFT JOIN Ruta_Clientes rc ON rc.cliente_id = c.id
    LEFT JOIN Rutas r ON r.id = rc.ruta_id AND r.cobrador_id = c.cobrador_id AND r.activa = 1 AND r.deleted_at IS NULL
    WHERE c.deleted_at IS NULL
      AND c.cobrador_id IS NOT NULL
      AND r.id IS NULL
    ORDER BY u.nombre_completo, c.nombre_completo
  `);

  const porCobrador = {};
  for (const r of rows) {
    const k = r.cobrador || r.cobrador_id;
    if (!porCobrador[k]) porCobrador[k] = { n: 0, con_activo: 0, sin_activo: 0 };
    porCobrador[k].n += 1;
    if (r.prestamo_estado === 'Activo') porCobrador[k].con_activo += 1;
    else porCobrador[k].sin_activo += 1;
  }

  if (FIX && rows.length) {
    const cobIds = [...new Set(rows.map((r) => r.cobrador_id))];
    const cobNombres = await query(
      `SELECT id, nombre_completo FROM Usuarios WHERE id IN (${cobIds.map(() => '?').join(',')})`,
      cobIds
    );
    const nomMap = Object.fromEntries(cobNombres.map((c) => [c.id, c.nombre_completo]));
    const rutasTocadas = new Set();

    for (const r of rows) {
      const rutaId = await sincronizarRutaClienteAsignado(r.codigo, r.cobrador_id, nomMap[r.cobrador_id]);
      if (rutaId) rutasTocadas.add(rutaId);
    }
    for (const rutaId of rutasTocadas) {
      await optimizarOrdenRuta(rutaId);
    }
    await bumpCarteraVersion(null, cobIds);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      rows.length
        ? rows.map((r) => ({
            codigo: r.codigo,
            nombre: r.nombre_completo,
            cobrador: r.cobrador,
            prestamo_activo: r.prestamo_estado === 'Activo' ? 'SI' : 'NO',
            saldo: r.saldo_pendiente != null ? Number(r.saldo_pendiente) : null,
            dias_cobro: Array.isArray(r.dias_de_cobro)
              ? r.dias_de_cobro.join(', ')
              : r.dias_de_cobro,
          }))
        : [{ info: 'ninguno' }]
    ),
    'SinRuta'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      Object.entries(porCobrador).map(([cobrador, v]) => ({ cobrador, ...v }))
    ),
    'Resumen'
  );
  XLSX.writeFile(wb, OUT);

  console.log(
    JSON.stringify(
      {
        total_sin_ruta: rows.length,
        por_cobrador: porCobrador,
        fix_aplicado: FIX,
        excel: OUT,
        clientes: rows.map((r) => ({
          codigo: r.codigo,
          nombre: r.nombre_completo,
          cobrador: r.cobrador,
          activo: r.prestamo_estado === 'Activo',
          saldo: r.saldo_pendiente != null ? Number(r.saldo_pendiente) : null,
        })),
      },
      null,
      2
    )
  );
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
