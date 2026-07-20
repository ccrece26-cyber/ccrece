/**
 * Genera plantilla Excel vacía para carga masiva.
 * Salida: app-financiera/assets/plantilla_carga_masiva.xlsx
 *
 * Uso: npm run plantilla-carga
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { query, pool } = require('../config/db');

const COLUMNAS = [
  'codigo_cliente',
  'cedula',
  'documento_tipo',
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
  'tipo_frecuencia',
  'dias_cobro',
  'dias_mes',
  'fecha_desembolso',
  'saldo_pendiente',
  'monto_pagado_historico',
  'fecha_ultimo_abono',
  'semanas_pagadas',
  'latitud',
  'longitud',
  'orden_visita',
];

const INSTRUCCIONES = [
  {
    campo: 'codigo_cliente',
    nota: 'Opcional. 5 o CC-5 → id CC-5. Tras la carga, nuevos = max+1.',
  },
  {
    campo: 'cedula',
    nota: 'Opcional. Nacional NIC o vacío (SINDOC). Extranjero: cualquier doc.',
  },
  {
    campo: 'documento_tipo',
    nota: 'nacional (default) | extranjero.',
  },
  { campo: 'cobrador_email', nota: 'Email real del cobrador. No use EJEMPLO@borrar.com.' },
  { campo: 'monto_desembolsado', nota: 'Capital original (ej. 5000).' },
  {
    campo: 'plazo_semanas',
    nota: 'Semanas del plan. Interés: tasa_mensual × (plazo/4).',
  },
  { campo: 'tasa_mensual', nota: '10 = 10%/mes financiero. NO es la tasa global.' },
  {
    campo: 'tipo_frecuencia',
    nota: 'SEMANAL o DIAS_MES.',
  },
  { campo: 'dias_cobro', nota: 'SEMANAL: LUNES,MIERCOLES,VIERNES.' },
  { campo: 'dias_mes', nota: 'DIAS_MES: 15,30.' },
  { campo: 'fecha_desembolso', nota: 'YYYY-MM-DD' },
  {
    campo: 'saldo_pendiente',
    nota: 'VERDAD: lo que debe hoy. Pagado histórico = total_contrato − saldo. Se reparte FIFO en cuotas.',
  },
  {
    campo: 'monto_pagado_historico',
    nota: 'Opcional. Si no cuadra con (total−saldo), se recalcula. Puede dejarse vacío.',
  },
  { campo: 'fecha_ultimo_abono', nota: 'Opcional. Fecha del pago histórico.' },
  {
    campo: 'semanas_pagadas',
    nota: 'No usar como verdad. Solo si faltan saldo/pagado. Si > plazo se ignora.',
  },
  {
    campo: 'despues_de_cargar',
    nota: 'Cobros, abonos parciales, varias cuotas y liquidaciones siguen igual (FIFO). La carga solo deja saldo/cuotas al día.',
  },
];

const FILAS_EJEMPLO = [
  {
    codigo_cliente: 'CC-1',
    cedula: '0011208760015A',
    documento_tipo: 'nacional',
    primer_nombre: 'Maria',
    primer_apellido: 'Lopez',
    nombre_completo: 'Maria Elena Lopez',
    telefono: '88881234',
    direccion: 'Barrio Central, Esteli',
    actividad_economica: 'Pulperia',
    cobrador_email: 'EJEMPLO@borrar.com',
    monto_desembolsado: 5000,
    plazo_semanas: 16,
    tasa_mensual: 10,
    tipo_frecuencia: 'SEMANAL',
    dias_cobro: 'LUNES,MIERCOLES,VIERNES',
    dias_mes: '',
    fecha_desembolso: '2025-11-15',
    saldo_pendiente: 4200,
    semanas_pagadas: 4,
    latitud: 13.0917,
    longitud: -86.3542,
    orden_visita: 1,
  },
  {
    codigo_cliente: 'CC-2',
    cedula: 'PASSPORT-HX9912',
    documento_tipo: 'extranjero',
    primer_nombre: 'John',
    primer_apellido: 'Smith',
    nombre_completo: 'John Smith',
    telefono: '86501122',
    direccion: 'Reparto San Jose',
    actividad_economica: 'Venta de ropa',
    cobrador_email: 'EJEMPLO@borrar.com',
    monto_desembolsado: 8000,
    plazo_semanas: 22,
    tasa_mensual: 10,
    tipo_frecuencia: 'SEMANAL',
    dias_cobro: 'LUNES,MARTES,VIERNES',
    dias_mes: '',
    fecha_desembolso: '2026-01-24',
    saldo_pendiente: 6000,
    semanas_pagadas: 4,
    orden_visita: 2,
  },
  {
    codigo_cliente: '3',
    cedula: '',
    documento_tipo: 'nacional',
    primer_nombre: 'Ana',
    primer_apellido: 'Garcia',
    nombre_completo: 'Ana Sofia Garcia',
    telefono: '87770011',
    direccion: 'Mercado Municipal',
    actividad_economica: 'Comedor',
    cobrador_email: 'EJEMPLO@borrar.com',
    monto_desembolsado: 10000,
    plazo_semanas: 12,
    tasa_mensual: 10,
    tipo_frecuencia: 'DIAS_MES',
    dias_cobro: '',
    dias_mes: '15,30',
    fecha_desembolso: '2026-01-05',
    saldo_pendiente: 11000,
    semanas_pagadas: 2,
    orden_visita: 3,
  },
];

async function main() {
  const cobradores = await query(
    `SELECT u.id, u.email, u.nombre_completo FROM Usuarios u
     JOIN Roles r ON u.rol_id = r.id WHERE r.nombre = 'COBRADOR' AND u.activo = 1
     ORDER BY u.nombre_completo`
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(FILAS_EJEMPLO, { header: COLUMNAS }), 'Cartera');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(INSTRUCCIONES), 'Instrucciones');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      cobradores.map((c) => ({
        cobrador_email: c.email,
        cobrador_id: c.id,
        nombre: c.nombre_completo,
      }))
    ),
    'Cobradores'
  );

  const outDir = path.join(__dirname, '../../../app-financiera/assets');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'plantilla_carga_masiva.xlsx');
  XLSX.writeFile(wb, outPath);

  const csvPath = path.join(outDir, 'plantilla_carga_masiva.csv');
  const ws = wb.Sheets.Cartera;
  fs.writeFileSync(csvPath, XLSX.utils.sheet_to_csv(ws), 'utf8');

  console.log('Plantilla generada:');
  console.log(' ', outPath);
  console.log(' ', csvPath);

  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
