/**
 * Prepara la ruta de prueba del cobrador para hoy:
 * - Muestra agenda pendiente
 * - Reabre cierre de caja si está cerrado (--reabrir)
 * - Diagnóstico push admin
 *
 * Uso: node src/scripts/preparar-prueba-cobros-hoy.js [fecha YYYY-MM-DD] [--reabrir] [--cobrador-id]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');
const { hoyISO, rangoDiaNicaragua } = require('../utils/zonaHoraria');
const { diaCobroDeFecha, debeSugerirCobroEnFecha } = require('../utils/diasCobro');
const { buildAgendaCobrador } = require('../utils/agendaCobrador');
const { whereCierreCalendarioDia } = require('../utils/fechasSql');
const { notificarAdminsCobrosCobrador } = require('../utils/expoPush');

const fecha = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : hoyISO();
const reabrir = process.argv.includes('--reabrir');
const activarPrueba = process.argv.includes('--activar-prueba');
const revertirPrueba = process.argv.includes('--revert-prueba');
const cobArg = process.argv.find((a) => a.startsWith('--cobrador-id='));
const COB_DEFAULT = 'COB-mq879bqw';
const CLIENTES_PRUEBA = [
  'Luz Marina Castillo Flores',
  'Ana Beatriz Solis',
  'Juan Carlos Perez Mora',
];

function parseDias(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) return j.map(String);
    } catch {
      /* csv */
    }
    return raw.split(/[,;|]/).map((d) => d.trim()).filter(Boolean);
  }
  return [];
}

async function activarVisitasPrueba(cobId, fecha) {
  const dia = diaCobroDeFecha(fecha);
  console.log('\n>>> Activando visitas de prueba para', dia);
  for (const nombre of CLIENTES_PRUEBA) {
    const rows = await query(
      `SELECT p.id, p.dias_de_cobro, c.nombre_completo
       FROM Prestamos p
       JOIN Clientes c ON p.cliente_id = c.id
       WHERE c.cobrador_id = ? AND c.nombre_completo = ? AND p.estado = 'Activo' AND p.deleted_at IS NULL
       LIMIT 1`,
      [cobId, nombre]
    );
    if (!rows.length) {
      console.log('  (no encontrado)', nombre);
      continue;
    }
    const p = rows[0];
    const dias = parseDias(p.dias_de_cobro);
    if (dias.includes(dia)) {
      console.log('  ✓', p.nombre_completo, '— ya tiene', dia);
      continue;
    }
    dias.push(dia);
    await query(`UPDATE Prestamos SET dias_de_cobro = ?, updated_at = NOW() WHERE id = ?`, [
      JSON.stringify(dias),
      p.id,
    ]);
    console.log('  +', p.nombre_completo, '→', dias.join(','));
  }
}

async function revertirVisitasPrueba(cobId) {
  console.log('\n>>> Revirtiendo DOMINGO de prueba');
  for (const nombre of CLIENTES_PRUEBA) {
    const rows = await query(
      `SELECT p.id, p.dias_de_cobro, c.nombre_completo
       FROM Prestamos p
       JOIN Clientes c ON p.cliente_id = c.id
       WHERE c.cobrador_id = ? AND c.nombre_completo = ? AND p.estado = 'Activo'
       LIMIT 1`,
      [cobId, nombre]
    );
    if (!rows.length) continue;
    const dias = parseDias(rows[0].dias_de_cobro).filter((d) => d !== 'DOMINGO');
    await query(`UPDATE Prestamos SET dias_de_cobro = ?, updated_at = NOW() WHERE id = ?`, [
      JSON.stringify(dias),
      rows[0].id,
    ]);
    console.log('  -', rows[0].nombre_completo, '→', dias.join(','));
  }
}

(async () => {
  let cobId = cobArg ? cobArg.split('=')[1] : COB_DEFAULT;
  const { inicio, fin } = rangoDiaNicaragua(fecha);
  const dia = diaCobroDeFecha(fecha);

  if (revertirPrueba) {
    await revertirVisitasPrueba(cobId);
  }
  if (activarPrueba) {
    await activarVisitasPrueba(cobId, fecha);
  }

  const cob = await query(
    `SELECT u.id, u.nombre_completo FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id
     WHERE u.id = ? OR u.nombre_completo LIKE '%Vielka%'
     ORDER BY u.id = ? DESC LIMIT 1`,
    [cobId, cobId]
  );
  if (!cob.length) {
    console.log('Cobrador no encontrado');
    process.exit(1);
  }
  cobId = cob[0].id;

  console.log('=== PRUEBA COBROS ===');
  console.log('Fecha:', fecha, '| Día:', dia);
  console.log('Cobrador:', cob[0].nombre_completo, cobId);

  const agenda = await buildAgendaCobrador(query, cobId, fecha);
  const pendientes = (agenda.agenda || []).filter(
    (v) => !v.estado_visita || v.estado_visita === 'pendiente'
  );
  const cobrados = (agenda.agenda || []).filter(
    (v) => v.estado_visita === 'cobrado' || v.estado_visita === 'cobrado_admin'
  );

  console.log('\n--- Agenda hoy ---');
  console.log('Total visitas:', agenda.agenda?.length || 0);
  console.log('Pendientes:', pendientes.length, '| Ya cobrados:', cobrados.length);
  console.log('Monto cobrado hoy:', agenda.resumen?.monto_cobrado ?? 0);

  if (pendientes.length) {
    console.log('\n>>> Clientes para COBRAR hoy (prueba push al sincronizar):');
    for (const v of pendientes.slice(0, 12)) {
      console.log(
        `  • ${v.nombre_completo} | C$ ${Number(v.monto_programado || 0).toFixed(2)} | saldo C$ ${Number(v.saldo_pendiente || 0).toFixed(2)}`
      );
    }
  } else {
    console.log('\n⚠ Sin visitas pendientes hoy. Clientes activos del cobrador:');
    const activos = await query(
      `SELECT c.nombre_completo, p.id AS prestamo_id, p.dias_de_cobro, p.saldo_pendiente, p.fecha_desembolso
       FROM Clientes c
       JOIN Prestamos p ON p.cliente_id = c.id AND p.estado = 'Activo' AND p.deleted_at IS NULL
       WHERE c.cobrador_id = ? AND (c.deleted_at IS NULL)
       ORDER BY c.nombre_completo LIMIT 10`,
      [cobId]
    );
    for (const a of activos) {
      const sugerido = debeSugerirCobroEnFecha(fecha, a);
      console.log(
        `  • ${a.nombre_completo} | dias: ${a.dias_de_cobro} | sugerido hoy: ${sugerido ? 'SI' : 'NO'}`
      );
    }
  }

  const cierres = await query(
    `SELECT id, fecha_cierre, monto_efectivo, deleted_at FROM Cierre_Caja
     WHERE cobrador_id = ? AND ${whereCierreCalendarioDia('fecha_cierre')}
     ORDER BY fecha_cierre DESC`,
    [cobId, fecha]
  );
  const cierreActivo = cierres.find((c) => !c.deleted_at);
  console.log('\n--- Cierre caja ---');
  console.log(cierreActivo ? `CERRADO (C$ ${Number(cierreActivo.monto_efectivo).toFixed(2)})` : 'Abierto — puede cobrar');

  if (reabrir && cierreActivo) {
    await query(
      `UPDATE Cierre_Caja SET deleted_at = NOW(), updated_at = NOW()
       WHERE cobrador_id = ? AND deleted_at IS NULL AND ${whereCierreCalendarioDia('fecha_cierre')}`,
      [cobId, fecha]
    );
    console.log('>>> Cierre reabierto para', fecha);
  }

  const admins = await query(
    `SELECT u.id, u.nombre_completo, u.email, u.expo_push_token, u.push_token_at
     FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id
     WHERE r.nombre = 'ADMIN' AND u.activo = 1 AND u.deleted_at IS NULL`
  );
  console.log('\n--- Push admin (por qué no llega la notificación) ---');
  for (const a of admins) {
    const tok = a.expo_push_token ? `${String(a.expo_push_token).slice(0, 40)}...` : '❌ SIN TOKEN';
    console.log(`  ${a.nombre_completo} (${a.email})`);
    console.log(`    token: ${tok}`);
    console.log(`    registrado: ${a.push_token_at ? String(a.push_token_at).slice(0, 19) : 'nunca'}`);
  }
  const conToken = admins.filter((a) => a.expo_push_token);
  if (!conToken.length) {
    console.log('\n⚠ CAUSA: ningún admin tiene token push en TiDB.');
    console.log('  Solución: admin abre la APK (no Expo Go), acepta permisos de notificaciones,');
    console.log('  cierra sesión y vuelve a entrar (o reinstala la app).');
  } else {
    console.log('\n✓ Hay', conToken.length, 'admin(s) con token. Push se envía al SINCRONIZAR cobro (no al guardar offline).');
    if (process.argv.includes('--test-push')) {
      await notificarAdminsCobrosCobrador(query, [
        {
          monto: 100,
          liquidacion: false,
          clienteNombre: 'Prueba sistema',
          cobradorNombre: cob[0].nombre_completo,
        },
      ]);
      console.log('>>> Push de prueba enviado a Expo.');
    }
  }

  const pagosHoy = await query(
    `SELECT c.nombre_completo, pg.monto_pagado, pg.fecha_pago, pg.registrado_por_admin
     FROM Pagos pg
     JOIN Prestamos p ON pg.prestamo_id = p.id
     JOIN Clientes c ON p.cliente_id = c.id
     WHERE pg.deleted_at IS NULL AND pg.fecha_pago >= ? AND pg.fecha_pago < ?
       AND pg.cobrador_id = ?
     ORDER BY pg.fecha_pago DESC`,
    [inicio, fin, cobId]
  );
  if (pagosHoy.length) {
    console.log('\n--- Cobros ya en nube hoy ---');
    pagosHoy.forEach((p) =>
      console.log(`  ${p.nombre_completo} | C$ ${Number(p.monto_pagado).toFixed(2)} | admin: ${p.registrado_por_admin}`)
    );
  }

  console.log('\n--- Pasos para probar notificación ---');
  console.log('1. Admin: APK nativa → login → aceptar notificaciones');
  console.log('2. Vielka: Ruta del día → cobrar un cliente pendiente → debe sincronizar (internet)');
  console.log('3. Admin debe recibir push en ~5 seg tras sync del cobrador');
  console.log('Opcional: node src/scripts/preparar-prueba-cobros-hoy.js --test-push');

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
