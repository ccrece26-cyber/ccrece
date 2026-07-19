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
    campo: 'cedula',
    nota: 'Obligatorio. 14 caracteres: 13 números + 1 letra mayúscula, sin guiones (ej. 0011208760015A).',
  },
  { campo: 'cobrador_email', nota: 'Email real del cobrador (hoja Cobradores). No use EJEMPLO@borrar.com.' },
  { campo: 'monto_desembolsado', nota: 'Capital original (ej. 5000).' },
  { campo: 'plazo_semanas', nota: 'Semanas del plan. Interés: 10% × (plazo/4). Mes = 4 semanas.' },
  { campo: 'tasa_mensual', nota: '10 = 10% por mes financiero.' },
  {
    campo: 'tipo_frecuencia',
    nota: 'SEMANAL o DIAS_MES. Si vacío, se detecta por dias_cobro/dias_mes.',
  },
  { campo: 'dias_cobro', nota: 'SEMANAL: LUNES,MIERCOLES,VIERNES. También "15 y 30 de Cada Mes".' },
  { campo: 'dias_mes', nota: 'DIAS_MES: 15,30 o 10,25. Vencimiento = desembolso + plazo×7.' },
  { campo: 'fecha_desembolso', nota: 'YYYY-MM-DD (ej. 2025-11-15)' },
  { campo: 'saldo_pendiente', nota: 'Lo que debe hoy (ej. 4200). Fuente principal.' },
  { campo: 'monto_pagado_historico', nota: 'Opcional. Abonado antes de la app (= total − saldo).' },
  { campo: 'fecha_ultimo_abono', nota: 'Opcional. Fecha del pago histórico (YYYY-MM-DD).' },
  { campo: 'semanas_pagadas', nota: 'Solo referencia. Borre filas de ejemplo antes de importar.' },
];

const FILAS_EJEMPLO = [
  {
    cedula: '0011208760015A',
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
    cedula: '0011309870023B',
    primer_nombre: 'Juan',
    primer_apellido: 'Perez',
    nombre_completo: 'Juan Carlos Perez',
    telefono: '86501122',
    direccion: 'Reparto San Jose',
    actividad_economica: 'Venta de ropa',
    cobrador_email: 'EJEMPLO@borrar.com',
    monto_desembolsado: 8000,
    plazo_semanas: 12,
    tasa_mensual: 10,
    tipo_frecuencia: 'DIAS_MES',
    dias_cobro: '',
    dias_mes: '15,30',
    fecha_desembolso: '2026-01-05',
    saldo_pendiente: 11000,
    semanas_pagadas: 2,
    orden_visita: 2,
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
