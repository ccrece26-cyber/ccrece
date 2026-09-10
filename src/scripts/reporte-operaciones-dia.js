/**
 * Reporte diario: pagos (marcando renovaciones), renovaciones, desembolsos y cierres.
 *
 *   node src/scripts/reporte-operaciones-dia.js
 *   node src/scripts/reporte-operaciones-dia.js --fecha 2026-09-01
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { pool } = require('../config/db');
const { hoyISO, toFechaISO } = require('../utils/zonaHoraria');
const {
  cargarDatosOperacionesDia,
  buildWorkbookOperacionesDia,
} = require('../utils/reporteOperacionesDia');
const { buildPdfOperacionesDia } = require('../utils/reporteOperacionesDiaPdf');

function parseArgs() {
  const args = process.argv.slice(2);
  let fecha = hoyISO();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fecha' && args[i + 1]) fecha = toFechaISO(args[++i]);
  }
  return fecha;
}

function generarExcel(datos) {
  const { fecha } = datos;
  const outName = `Reporte_operaciones_${fecha}.xlsx`;
  const OUT = path.join(__dirname, '../../../', outName);
  const wb = buildWorkbookOperacionesDia(datos);
  try {
    XLSX.writeFile(wb, OUT);
  } catch (e) {
    if (e.code === 'EBUSY') {
      const alt = OUT.replace(/\.xlsx$/i, '_actualizado.xlsx');
      XLSX.writeFile(wb, alt);
      return alt;
    }
    throw e;
  }
  return OUT;
}

async function generarPDF(datos) {
  const { fecha } = datos;
  const outName = `Reporte_operaciones_${fecha}.pdf`;
  const OUT = path.join(__dirname, '../../../', outName);
  const buf = await buildPdfOperacionesDia(datos);
  fs.writeFileSync(OUT, buf);
  return OUT;
}

(async () => {
  const fecha = parseArgs();
  const datos = await cargarDatosOperacionesDia(fecha);
  const excel = generarExcel(datos);
  const pdf = await generarPDF(datos);

  console.log(
    JSON.stringify(
      {
        ok: true,
        fecha,
        excel,
        pdf,
        resumen: datos.resumen,
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
  } catch {
    /* */
  }
  process.exit(1);
});
