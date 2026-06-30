const fs = require('fs');
const path = require('path');
const { normalizarFila, calcularPreview } = require('../utils/cargaMasivaPrestamos');
const { fechaVencimientoCredito } = require('../utils/finanzasNube');
const { hoyISO } = require('../utils/zonaHoraria');

const file = process.argv[2] || path.join(__dirname, '../../output/carga_masiva_200_2026-06-30.csv');
const hoy = hoyISO();
const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.trim().split(/\r?\n/);
const hdr = lines[0].split(',');

function parseLine(line) {
  const o = {};
  let cur = '';
  let inQ = false;
  let ci = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) {
      o[hdr[ci]] = cur;
      cur = '';
      ci += 1;
      continue;
    }
    cur += c;
  }
  o[hdr[ci]] = cur;
  return o;
}

let ok = 0;
let e = 0;
let v = 0;
for (let i = 1; i < lines.length; i += 1) {
  const row = parseLine(lines[i]);
  const f = normalizarFila(row, i - 1);
  const pr = calcularPreview(f);
  if (pr.error) {
    e += 1;
    if (e <= 5) console.log('ERR fila', i + 1, pr.error);
  } else ok += 1;
  const dias = String(row.dias_cobro).split(',');
  const ven = fechaVencimientoCredito(row.fecha_desembolso, Number(row.plazo_semanas), dias);
  if (ven < hoy) v += 1;
}
console.log('validas', ok, 'errores', e, 'vencidos', v, 'hoy', hoy);
