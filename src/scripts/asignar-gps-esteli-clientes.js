/**
 * Asigna coordenadas GPS en Estelí a todos los clientes (domicilio + punto de cobro).
 * Uso: node src/scripts/asignar-gps-esteli-clientes.js
 *      node src/scripts/asignar-gps-esteli-clientes.js --dry-run
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

const BARRIOS_ESTELI = [
  { nombre: 'Centro', lat: 13.091, lng: -86.3534 },
  { nombre: 'San Juan', lat: 13.0882, lng: -86.3578 },
  { nombre: 'El Rosario', lat: 13.0948, lng: -86.3485 },
  { nombre: 'La Trinidad', lat: 13.0855, lng: -86.3448 },
  { nombre: 'Carlos Manuel', lat: 13.083, lng: -86.362 },
  { nombre: 'Guadalupe', lat: 13.0785, lng: -86.351 },
  { nombre: 'Miraflores', lat: 13.0965, lng: -86.361 },
  { nombre: 'Puntalapa', lat: 13.074, lng: -86.348 },
  { nombre: 'San Antonio', lat: 13.0925, lng: -86.3595 },
  { nombre: 'Reparto San Luis', lat: 13.087, lng: -86.3495 },
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** ~metros a grados (latitud ~111km/°; longitud ajustada por cos(lat)). */
function offsetMetros(latBase, lngBase, metrosNorte, metrosEste) {
  const dLat = metrosNorte / 111320;
  const dLng = metrosEste / (111320 * Math.cos((latBase * Math.PI) / 180));
  return {
    lat: Number((latBase + dLat).toFixed(6)),
    lng: Number((lngBase + dLng).toFixed(6)),
  };
}

function coordsCliente(clienteId) {
  const h = hashStr(String(clienteId));
  const barrio = BARRIOS_ESTELI[h % BARRIOS_ESTELI.length];
  const jitterN = ((h >> 4) % 400) - 200;
  const jitterE = ((h >> 12) % 400) - 200;
  const domicilio = offsetMetros(barrio.lat, barrio.lng, jitterN, jitterE);

  const angulo = (h >> 8) % 360;
  const distCobro = 60 + (h % 120);
  const rad = (angulo * Math.PI) / 180;
  const cobro = offsetMetros(
    domicilio.lat,
    domicilio.lng,
    Math.round(Math.cos(rad) * distCobro),
    Math.round(Math.sin(rad) * distCobro)
  );

  return { barrio: barrio.nombre, domicilio, cobro };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const clientes = await query(
    `SELECT id, nombre_completo, direccion FROM Clientes WHERE deleted_at IS NULL ORDER BY id`
  );
  console.log(`Clientes a actualizar: ${clientes.length}${dryRun ? ' (dry-run)' : ''}\n`);

  let ok = 0;
  for (const c of clientes) {
    const { barrio, domicilio, cobro } = coordsCliente(c.id);
    const dir =
      c.direccion && /estel[ií]/i.test(c.direccion)
        ? c.direccion
        : `Barrio ${barrio}, Estelí${c.direccion ? ` — ${c.direccion}` : ''}`;

    if (dryRun) {
      console.log(
        `${c.id} | ${c.nombre_completo?.slice(0, 28)} | dom ${domicilio.lat},${domicilio.lng} | cobro ${cobro.lat},${cobro.lng}`
      );
      ok++;
      continue;
    }

    await query(
      `UPDATE Clientes SET
         latitud = ?, longitud = ?,
         latitud_cobro = ?, longitud_cobro = ?,
         direccion = COALESCE(NULLIF(?, ''), direccion),
         is_synced = 1, updated_at = NOW()
       WHERE id = ?`,
      [domicilio.lat, domicilio.lng, cobro.lat, cobro.lng, dir, c.id]
    );
    ok++;
  }

  const [stats] = await query(
    `SELECT
       COUNT(*) AS total,
       SUM(latitud IS NOT NULL AND longitud IS NOT NULL) AS con_domicilio,
       SUM(latitud_cobro IS NOT NULL AND longitud_cobro IS NOT NULL) AS con_cobro
     FROM Clientes WHERE deleted_at IS NULL`
  );

  console.log(`\n✅ ${ok} clientes ${dryRun ? 'simulados' : 'actualizados'}.`);
  console.log(`   Con GPS domicilio: ${stats.con_domicilio}/${stats.total}`);
  console.log(`   Con GPS cobro: ${stats.con_cobro}/${stats.total}`);
  console.log('\nLos cobradores deben volver a descargar la ruta para ver las coordenadas en la app.');
}

main()
  .catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
