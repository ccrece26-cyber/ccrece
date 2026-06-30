/**
 * Genera CSV de 200 clientes para carga masiva.
 * ~20 vencidos (plazo cumplido con saldo), resto al día.
 *
 * Uso: node src/scripts/generar-carga-200-demo.js
 * Salida: backend/output/carga_masiva_200.csv
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');
const { hoyISO } = require('../utils/zonaHoraria');
const {
  calcularCuotaYDistribucion,
  fechaVencimientoCredito,
} = require('../utils/finanzasNube');

const HOY = hoyISO();
const TOTAL = 200;
const VENCIDOS = 18;

const NOMBRES = [
  ['Maria', 'Elena', 'Lopez', 'Ruiz'],
  ['Juan', 'Carlos', 'Perez', 'Garcia'],
  ['Ana', 'Solis', 'Beatriz', 'Martinez'],
  ['Pedro', 'Antonio', 'Rivas', 'Castillo'],
  ['Luz', 'Marina', 'Flores', 'Herrera'],
  ['Oscar', 'Daniel', 'Mejia', 'Torres'],
  ['Rosa', 'Isabel', 'Vargas', 'Jimenez'],
  ['Felix', 'Eduardo', 'Mendoza', 'Ortega'],
  ['Carmen', 'Lucia', 'Zelaya', 'Chavez'],
  ['Jose', 'Luis', 'Baltodano', 'Suarez'],
  ['Patricia', 'Alejandra', 'Corea', 'Navarro'],
  ['Miguel', 'Angel', 'Jarquin', 'Pineda'],
  ['Sandra', 'Patricia', 'Urbina', 'Ramos'],
  ['Francisco', 'Javier', 'Tellez', 'Morales'],
  ['Glenda', 'Marisol', 'Blandon', 'Cruz'],
  ['Walter', 'Jose', 'Guido', 'Espinoza'],
  ['Yolanda', 'Cristina', 'Duarte', 'Reyes'],
  ['Marvin', 'Antonio', 'Gutierrez', 'Silva'],
  ['Xiomara', 'Josefina', 'Centeno', 'Aguilar'],
  ['Boris', 'Ivan', 'Montenegro', 'Delgado'],
];

const BARRIOS = [
  'Barrio Central, Esteli',
  'Reparto San Jose, Esteli',
  'Comarca El Jicaral, Esteli',
  'Colonia 15 de Septiembre',
  'Barrio Oscar Danilo Rosales',
  'Reparto La Sultana',
  'Colonia San Martin',
  'Barrio La Trinidad',
];

const ACTIVIDADES = ['Pulperia', 'Venta de ropa', 'Comida', 'Ferreteria', 'Taxi', 'Agricultura', 'Costura'];

const DIAS_OPCIONES = [
  'LUNES,MIERCOLES,VIERNES',
  'MARTES,JUEVES,SABADO',
  'LUNES,MARTES,VIERNES',
];

function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function cedulaNic(i) {
  const base = String(1000000000000 + i).slice(0, 13);
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return `${base}${letras[i % letras.length]}`;
}

function nombreCompleto(p) {
  return [p[0], p[1], p[2], p[3]].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function escCsv(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

function filaCliente(i, cobradorEmail, perfil) {
  const p = NOMBRES[i % NOMBRES.length];
  const idx = i + 1;
  const monto = [3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000][i % 8];
  const plazo = perfil.vencido ? [12, 14, 16, 18][i % 4] : [16, 20, 24, 28, 32][i % 5];
  const dias = DIAS_OPCIONES[i % DIAS_OPCIONES.length];
  const diasArr = dias.split(',');
  const fin = calcularCuotaYDistribucion(monto, plazo, diasArr, 0.1);
  const total = fin.montoTotalPagar;

  let fecha_desembolso;
  let saldo_pendiente;

  if (perfil.vencido) {
    fecha_desembolso = addDays(HOY, -(plazo * 7 + 21 + (i % 14)));
    const pctRestante = 0.42 + (i % 5) * 0.06;
    saldo_pendiente = Number((total * pctRestante).toFixed(2));
  } else {
    fecha_desembolso = addDays(HOY, -(14 + (i % 50)));
    const pctRestante = 0.55 + (i % 8) * 0.04;
    saldo_pendiente = Number((total * Math.min(0.92, pctRestante)).toFixed(2));
    let venc = fechaVencimientoCredito(fecha_desembolso, plazo, diasArr);
    let guard = 0;
    while (venc && venc < HOY && guard < 80) {
      fecha_desembolso = addDays(fecha_desembolso, 7);
      venc = fechaVencimientoCredito(fecha_desembolso, plazo, diasArr);
      guard += 1;
    }
  }

  const monto_pagado_historico = Number((total - saldo_pendiente).toFixed(2));
  const fecha_ultimo_abono = addDays(HOY, -(3 + (i % 12)));
  const venc = fechaVencimientoCredito(fecha_desembolso, plazo, diasArr);

  return {
    cedula: cedulaNic(1000 + idx),
    primer_nombre: p[0],
    primer_apellido: p[2],
    segundo_nombre: p[1] !== p[0] ? p[1] : '',
    segundo_apellido: p[3] !== p[2] ? p[3] : '',
    nombre_completo: nombreCompleto(p),
    telefono: `8888${String(1000 + idx).slice(-4)}`,
    direccion: BARRIOS[i % BARRIOS.length],
    actividad_economica: ACTIVIDADES[i % ACTIVIDADES.length],
    cobrador_email: cobradorEmail,
    monto_desembolsado: monto,
    plazo_semanas: plazo,
    tasa_mensual: 10,
    dias_cobro: dias,
    fecha_desembolso,
    saldo_pendiente,
    monto_pagado_historico,
    fecha_ultimo_abono,
    semanas_pagadas: '',
    latitud: (13.09 + (i % 20) * 0.001).toFixed(4),
    longitud: (-86.35 - (i % 15) * 0.001).toFixed(4),
    orden_visita: (i % 25) + 1,
    _vencido: venc && venc < HOY,
    _fecha_vencimiento: venc,
  };
}

async function main() {
  let cobradores = await query(
    `SELECT u.email, u.nombre_completo FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id WHERE r.nombre = 'COBRADOR' AND u.activo = 1 AND u.deleted_at IS NULL`
  );
  if (!cobradores.length) {
    cobradores = [{ email: 'cobrador1@nica.com', nombre_completo: 'Cobrador 1' }];
    console.warn('⚠️  Sin cobradores en BD — use emails reales antes de importar.');
  }

  const columnas = [
    'cedula',
    'primer_nombre',
    'primer_apellido',
    'segundo_nombre',
    'segundo_apellido',
    'nombre_completo',
    'telefono',
    'direccion',
    'actividad_economica',
    'cobrador_email',
    'monto_desembolsado',
    'plazo_semanas',
    'tasa_mensual',
    'dias_cobro',
    'fecha_desembolso',
    'saldo_pendiente',
    'monto_pagado_historico',
    'fecha_ultimo_abono',
    'semanas_pagadas',
    'latitud',
    'longitud',
    'orden_visita',
  ];

  const filas = [];
  for (let i = 0; i < TOTAL; i += 1) {
    const cob = cobradores[i % cobradores.length].email;
    const vencido = i < VENCIDOS;
    filas.push(filaCliente(i, cob, { vencido }));
  }

  const vencidosCount = filas.filter((f) => f._vencido).length;
  const lines = [columnas.join(',')];
  for (const f of filas) {
    lines.push(columnas.map((c) => escCsv(f[c])).join(','));
  }

  const outDir = path.join(__dirname, '../../output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `carga_masiva_200_${HOY}.csv`);
  fs.writeFileSync(outPath, `\uFEFF${lines.join('\r\n')}`, 'utf8');

  console.log(`\n📋 Carga masiva generada — fecha corte: ${HOY}`);
  console.log(`   Filas: ${TOTAL} (${vencidosCount} con vencimiento antes de hoy)`);
  console.log(`   Archivo: ${outPath}\n`);
  console.log('Vencidos (primeros):');
  filas
    .filter((f) => f._vencido)
    .slice(0, 8)
    .forEach((f) => {
      console.log(`  · ${f.nombre_completo} — vence ${f._fecha_vencimiento} — saldo C$ ${f.saldo_pendiente}`);
    });
  console.log('\nCobradores usados:');
  cobradores.forEach((c) => console.log(`  · ${c.nombre_completo} <${c.email}>`));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
