require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');

(async () => {
  const oscar = await query(
    `SELECT c.id, c.nombre_completo, c.cobrador_id, u.nombre_completo AS cobrador_nombre
     FROM Clientes c
     LEFT JOIN Usuarios u ON c.cobrador_id = u.id
     WHERE c.nombre_completo LIKE '%Oscar%Danilo%' AND c.deleted_at IS NULL`
  );
  console.log('=== Oscar ===');
  console.log(JSON.stringify(oscar, null, 2));

  if (oscar[0]) {
    const rutas = await query(
      `SELECT rc.ruta_id, rc.orden_visita, r.cobrador_id, r.activa, u.nombre_completo AS cobrador
       FROM Ruta_Clientes rc
       JOIN Rutas r ON rc.ruta_id = r.id
       LEFT JOIN Usuarios u ON r.cobrador_id = u.id
       WHERE rc.cliente_id = ?`,
      [oscar[0].id]
    );
    console.log('Rutas Oscar:', JSON.stringify(rutas, null, 2));
  }

  const dupes = await query(
    `SELECT c.id, c.nombre_completo, c.cobrador_id,
            GROUP_CONCAT(DISTINCT u.nombre_completo ORDER BY u.nombre_completo SEPARATOR ' | ') AS en_rutas_de
     FROM Clientes c
     JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
     JOIN Rutas r ON rc.ruta_id = r.id AND r.activa = 1 AND (r.deleted_at IS NULL)
     LEFT JOIN Usuarios u ON r.cobrador_id = u.id
     WHERE c.deleted_at IS NULL
     GROUP BY c.id, c.nombre_completo, c.cobrador_id
     HAVING COUNT(DISTINCT r.cobrador_id) > 1
     ORDER BY c.nombre_completo`
  );
  console.log('\n=== Clientes en 2+ rutas activas ===', dupes.length);
  for (const d of dupes) console.log(`- ${d.nombre_completo} (asignado: ${d.cobrador_id}) → ${d.en_rutas_de}`);

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
