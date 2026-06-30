require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');
const { buildAgendaCobrador } = require('../utils/agendaCobrador');

async function main() {
  const cob = await query(
    `SELECT id, nombre_completo, email FROM Usuarios
     WHERE email = 'cobrador2' OR nombre_completo LIKE '%Oscar%Daniel%Mej%'`
  );
  console.log('=== Cobrador ===');
  cob.forEach((c) => console.log(`  ${c.id} | ${c.nombre_completo} | ${c.email}`));
  const cid = cob[0]?.id;
  if (!cid) return;

  const rutas = await query('SELECT id, nombre, activa FROM Rutas WHERE cobrador_id = ?', [cid]);
  console.log('\nRutas:', rutas);

  const [total] = await query(
    `SELECT COUNT(*) AS n FROM Ruta_Clientes rc
     JOIN Rutas r ON r.id = rc.ruta_id WHERE r.cobrador_id = ?`,
    [cid]
  );
  console.log('Clientes en Ruta_Clientes:', total.n);

  const dupNombres = await query(
    `SELECT LOWER(TRIM(c.nombre_completo)) AS nom, COUNT(*) AS cnt,
            GROUP_CONCAT(CONCAT(c.id, '|', IFNULL(c.cedula,'')) ORDER BY c.id SEPARATOR ' ;; ') AS ids
     FROM Clientes c
     JOIN Ruta_Clientes rc ON rc.cliente_id = c.id
     JOIN Rutas r ON r.id = rc.ruta_id AND r.cobrador_id = ? AND r.activa = 1
     WHERE c.deleted_at IS NULL
     GROUP BY LOWER(TRIM(c.nombre_completo))
     HAVING cnt > 1
     ORDER BY cnt DESC LIMIT 30`,
    [cid]
  );
  console.log('\n=== Nombres duplicados en ruta ===', dupNombres.length);
  dupNombres.forEach((d) => console.log(`  ${d.cnt}x ${d.nom}\n    ${d.ids}`));

  const sinPrestamo = await query(
    `SELECT c.id, c.nombre_completo, c.cedula, rc.orden_visita
     FROM Clientes c
     JOIN Ruta_Clientes rc ON rc.cliente_id = c.id
     JOIN Rutas r ON r.id = rc.ruta_id AND r.cobrador_id = ? AND r.activa = 1
     LEFT JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
     WHERE c.deleted_at IS NULL AND p.id IS NULL
     ORDER BY rc.orden_visita`,
    [cid]
  );
  console.log('\nEn ruta SIN prestamo activo:', sinPrestamo.length);
  sinPrestamo.slice(0, 15).forEach((r) =>
    console.log(`  ${r.orden_visita}. ${r.id} | ${r.nombre_completo} | ${r.cedula}`)
  );

  const multiRuta = await query(
    `SELECT c.id, c.nombre_completo, c.cedula, c.cobrador_id,
            COUNT(DISTINCT r.cobrador_id) AS rutas_distintas,
            GROUP_CONCAT(DISTINCT u.nombre_completo SEPARATOR ' | ') AS cobradores
     FROM Clientes c
     JOIN Ruta_Clientes rc ON rc.cliente_id = c.id
     JOIN Rutas r ON r.id = rc.ruta_id AND r.activa = 1
     LEFT JOIN Usuarios u ON u.id = r.cobrador_id
     WHERE c.deleted_at IS NULL
       AND c.id IN (
         SELECT rc2.cliente_id FROM Ruta_Clientes rc2
         JOIN Rutas r2 ON r2.id = rc2.ruta_id AND r2.cobrador_id = ?
       )
     GROUP BY c.id, c.nombre_completo, c.cedula, c.cobrador_id
     HAVING rutas_distintas > 1`,
    [cid]
  );
  console.log('\nClientes de Oscar tambien en otra ruta activa:', multiRuta.length);
  multiRuta.slice(0, 10).forEach((r) =>
    console.log(`  ${r.id} ${r.nombre_completo} → ${r.cobradores}`)
  );

  const agenda = await buildAgendaCobrador(query, cid);
  console.log('\n=== Agenda hoy ===');
  console.log('Total visitas:', agenda.agenda.length);
  console.log('Resumen:', agenda.resumen);

  const cero = agenda.agenda.filter((a) => Number(a.monto_programado || 0) === 0);
  console.log('\nVisitas con monto_programado = 0:', cero.length);
  cero.slice(0, 20).forEach((a) =>
    console.log(`  ${a.cliente_id} | ${a.nombre_completo} | ${a.cedula} | ${a.tipo_visita} | ${a.estado_visita}`)
  );

  const porNombre = {};
  for (const a of agenda.agenda) {
    const k = (a.nombre_completo || '').toLowerCase().trim();
    if (!porNombre[k]) porNombre[k] = [];
    porNombre[k].push(a);
  }
  const dupAgenda = Object.entries(porNombre).filter(([, v]) => v.length > 1);
  console.log('\nNombres repetidos en agenda:', dupAgenda.length);
  dupAgenda.slice(0, 10).forEach(([nom, items]) => {
    console.log(`  ${nom} (${items.length}):`);
    items.forEach((a) =>
      console.log(`    ${a.cliente_id} ced=${a.cedula} monto=${a.monto_programado} prest=${a.prestamo_id}`)
    );
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
