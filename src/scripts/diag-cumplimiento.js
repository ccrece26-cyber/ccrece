require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');
const { debeSugerirCobroEnFecha, diaCobroDeFecha } = require('../utils/diasCobro');
const { buildAgendaCobrador } = require('../utils/agendaCobrador');

const fecha = process.argv[2] || '2026-06-23';
const nombreBuscar = process.argv[3] || 'Oscar';

(async () => {
  console.log('Fecha:', fecha, '| Dia:', diaCobroDeFecha(fecha));

  const cobradores = await query(
    `SELECT u.id, u.nombre_completo FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id
     WHERE r.nombre = 'COBRADOR' AND (u.nombre_completo LIKE ? OR u.nombre_completo LIKE ?)`,
    ['%Vielka%', '%vielka%']
  );
  if (!cobradores.length) {
    const all = await query(
      `SELECT u.id, u.nombre_completo FROM Usuarios u
       JOIN Roles r ON u.rol_id = r.id WHERE r.nombre = 'COBRADOR' ORDER BY u.nombre_completo`
    );
    console.log('Cobradores disponibles:', all.map((c) => c.nombre_completo).join(', '));
    process.exit(1);
  }
  const cobId = cobradores[0].id;
  console.log('Cobrador:', cobradores[0].nombre_completo, cobId);

  const clientesOscar = await query(
    `SELECT c.*, p.id AS prestamo_id, p.estado AS prestamo_estado, p.dias_de_cobro,
            p.fecha_desembolso, p.saldo_pendiente
     FROM Clientes c
     LEFT JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
     WHERE c.deleted_at IS NULL
       AND (c.nombre_completo LIKE ? OR c.nombre_completo LIKE ? OR c.nombre_completo LIKE ?)`,
    [`%${nombreBuscar}%`, '%Mejia%', '%Mej%']
  );
  console.log('\nClientes encontrados:', clientesOscar.length);
  for (const row of clientesOscar) {
    const p = {
      dias_de_cobro: row.dias_de_cobro,
      fecha_desembolso: row.fecha_desembolso,
    };
    console.log('---', row.nombre_completo);
    console.log('  cliente_id:', row.id, '| cobrador_id:', row.cobrador_id);
    console.log('  prestamo:', row.prestamo_id, row.prestamo_estado);
    console.log('  dias_de_cobro:', row.dias_de_cobro);
    console.log('  fecha_desembolso:', row.fecha_desembolso);
    console.log('  debeSugerirCobroEnFecha:', debeSugerirCobroEnFecha(fecha, p));

    const enRuta = await query(
      `SELECT rc.*, r.cobrador_id, r.activa
       FROM Ruta_Clientes rc
       JOIN Rutas r ON rc.ruta_id = r.id
       WHERE rc.cliente_id = ?`,
      [row.id]
    );
    console.log('  rutas:', enRuta);

    if (row.prestamo_id) {
      const cuotas = await query(
        `SELECT id, fecha_programada, monto_programado, monto_pagado, estado
         FROM Cuotas_Calendario
         WHERE prestamo_id = ? AND estado IN ('Programada','Parcial')
           AND fecha_programada <= ? AND deleted_at IS NULL
         ORDER BY fecha_programada LIMIT 5`,
        [row.prestamo_id, fecha]
      );
      console.log('  cuotas pendientes:', cuotas);

      const pagos = await query(
        `SELECT id, monto_pagado, fecha_pago, cobrador_id, registrado_por_admin
         FROM Pagos WHERE prestamo_id = ? AND DATE(fecha_pago) = DATE(?) AND deleted_at IS NULL`,
        [row.prestamo_id, fecha]
      );
      console.log('  pagos hoy:', pagos);
    }
  }

  const agenda = await buildAgendaCobrador(query, cobId, fecha);
  console.log('\n=== Agenda Vielka ===');
  console.log('Resumen:', agenda.resumen);
  for (const v of agenda.agenda) {
    console.log(`  [${v.estado_visita}] ${v.nombre_completo} (#${v.orden_visita})`);
  }

  const pagosHoy = await query(
    `SELECT pg.*, c.nombre_completo
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE pg.cobrador_id = ? AND DATE(pg.fecha_pago) = DATE(?) AND pg.deleted_at IS NULL`,
    [cobId, fecha]
  );
  console.log('\nPagos hoy cobrador (todos):', pagosHoy.map((p) => ({
    nombre: p.nombre_completo,
    admin: p.registrado_por_admin,
    monto: p.monto_pagado,
  })));

  const enRuta = await query(
    `SELECT c.id, c.nombre_completo, c.cobrador_id, rc.orden_visita
     FROM Clientes c
     INNER JOIN Ruta_Clientes rc ON c.id = rc.cliente_id
     INNER JOIN Rutas r ON rc.ruta_id = r.id AND r.cobrador_id = ? AND r.activa = 1
     WHERE c.deleted_at IS NULL
     ORDER BY rc.orden_visita`,
    [cobId]
  );
  const excluidos = enRuta.filter((c) => c.cobrador_id !== cobId);
  console.log('\nEn ruta pero cobrador_id distinto (BUG):', excluidos.map((c) => `${c.nombre_completo} (${c.cobrador_id})`));

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
