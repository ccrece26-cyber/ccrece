/**
 * PDF del reporte de operaciones del día (mismo formato que el script CLI).
 * Devuelve un Buffer.
 */
const PDFDocument = require('pdfkit');
const { ZONA_NICARAGUA } = require('./zonaHoraria');
const { labelCobrador, num } = require('./reporteOperacionesDia');

const C = {
  forest: '#1c3d2e',
  forestMid: '#2d5a40',
  ink: '#1c1917',
  body: '#44403c',
  muted: '#78716c',
  line: '#d6d3d1',
  soft: '#f5f5f4',
  stripe: '#fafaf9',
  white: '#ffffff',
  renew: '#9a3412',
  renewBg: '#fff7ed',
};

const money = (n) => {
  const x = num(n);
  const [ent, dec] = Math.abs(x).toFixed(2).split('.');
  return `${x < 0 ? '-' : ''}C$ ${ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
};

const fmtCedula = (c) => {
  const s = String(c || '').trim();
  if (!s) return '—';
  if (s.length <= 16) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
};

function absoluteText(doc, str, x, y, opts = {}) {
  const prev = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  try {
    doc.text(String(str ?? ''), x, y, { ...opts, lineBreak: false });
  } finally {
    doc.page.margins.bottom = prev;
  }
}

function drawPdfHeader(doc, fecha) {
  const W = doc.page.width;
  doc.rect(0, 0, W, 52).fill(C.forest);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(C.white);
  absoluteText(doc, 'Credi Crece', 36, 14, { width: 300 });
  doc.font('Helvetica').fontSize(9).fillColor('#d1e7dd');
  absoluteText(doc, 'Operaciones del día', 36, 32, { width: 300 });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.white);
  absoluteText(doc, fecha, W - 200, 16, { width: 164, align: 'right' });
  doc.font('Helvetica').fontSize(7.5).fillColor('#d1e7dd');
  absoluteText(
    doc,
    `Generado ${new Date().toLocaleString('es-NI', { timeZone: ZONA_NICARAGUA })} (hora Nicaragua)`,
    W - 260,
    32,
    { width: 224, align: 'right' }
  );
  return 64;
}

function drawSummaryCards(doc, resumen, startY) {
  const margin = 36;
  const gap = 10;
  const cardW = (doc.page.width - 72 - gap * 3) / 4;
  const cards = [
    {
      label: 'Pagos',
      value: `${resumen.pagos_tx} tx`,
      sub: money(resumen.pagos_monto),
    },
    { label: 'Renovaciones', value: String(resumen.renovaciones), sub: 'operaciones' },
    {
      label: 'Desembolsos',
      value: `${resumen.desembolsos_nuevos}+${resumen.desembolsos_renovacion}`,
      sub: money(resumen.monto_desembolsos),
    },
    {
      label: 'Cierres',
      value: `${resumen.cierres_tx} tx`,
      sub: money(resumen.cierres_monto),
    },
  ];
  let x = margin;
  cards.forEach((card) => {
    doc.roundedRect(x, startY, cardW, 46, 4).fill(C.soft).stroke(C.line);
    doc.font('Helvetica').fontSize(7).fillColor(C.muted);
    absoluteText(doc, card.label.toUpperCase(), x + 8, startY + 8, { width: cardW - 16 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.forest);
    absoluteText(doc, card.value, x + 8, startY + 20, { width: cardW - 16 });
    doc.font('Helvetica').fontSize(8).fillColor(C.body);
    absoluteText(doc, card.sub, x + 8, startY + 34, { width: cardW - 16 });
    x += cardW + gap;
  });
  return startY + 58;
}

function rowHeight(doc, row, cols, fontSize = 6.5) {
  doc.fontSize(fontSize);
  let h = 12;
  row.forEach((cell, i) => {
    const ch = doc.heightOfString(String(cell ?? ''), { width: cols[i] - 6 });
    h = Math.max(h, ch + 5);
  });
  return Math.min(h, 28);
}

function drawTable(doc, { title, headers, rows, cols, startY, highlightCol, margin = 36 }) {
  const tableW = cols.reduce((a, b) => a + b, 0);
  let y = startY;

  const drawHead = () => {
    let x = margin;
    doc.roundedRect(margin, y, tableW, 16, 3).fill(C.forestMid);
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.white);
    headers.forEach((h, i) => {
      absoluteText(doc, h, x + 3, y + 4, { width: cols[i] - 6 });
      x += cols[i];
    });
    y += 16;
  };

  const newPageIfNeeded = (need) => {
    if (y + need > doc.page.height - 36) {
      doc.addPage();
      y = 48;
      drawHead();
    }
  };

  newPageIfNeeded(36);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.forest).text(title, margin, y);
  y += 14;
  drawHead();

  rows.forEach((row, ri) => {
    const rh = rowHeight(doc, row, cols);
    newPageIfNeeded(rh + 4);

    const isRenewRow = highlightCol != null && String(row[highlightCol]).toUpperCase() === 'SI';
    if (isRenewRow) {
      doc.rect(margin, y, tableW, rh).fill(C.renewBg);
    } else if (ri % 2 === 0) {
      doc.rect(margin, y, tableW, rh).fill(C.stripe);
    }

    let x = margin;
    doc.font('Helvetica').fontSize(6.5).fillColor(C.ink);
    row.forEach((cell, i) => {
      const isHi = highlightCol != null && i === highlightCol && String(cell).toUpperCase() === 'SI';
      if (isHi) {
        doc.font('Helvetica-Bold').fillColor(C.renew);
      } else if (i === 3) {
        doc.font('Helvetica-Bold');
      } else {
        doc.font('Helvetica').fillColor(C.ink);
      }
      absoluteText(doc, String(cell ?? ''), x + 3, y + 3, { width: cols[i] - 6 });
      x += cols[i];
    });
    doc.strokeColor(C.line).lineWidth(0.3).moveTo(margin, y + rh).lineTo(margin + tableW, y + rh).stroke();
    y += rh;
  });

  return y + 12;
}

function addPageFooters(doc, fecha) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - 24;
    doc.strokeColor(C.line).lineWidth(0.4).moveTo(36, fy - 4).lineTo(doc.page.width - 36, fy - 4).stroke();
    doc.font('Helvetica').fontSize(6.5).fillColor(C.muted);
    absoluteText(doc, `Credi Crece · Reporte operaciones ${fecha} · Hora Nicaragua (UTC−6)`, 36, fy, {
      width: 500,
    });
    absoluteText(doc, `Pág. ${i - range.start + 1} / ${range.count}`, doc.page.width - 80, fy, {
      width: 44,
      align: 'right',
    });
  }
}

/** @returns {Promise<Buffer>} */
function buildPdfOperacionesDia(datos) {
  return new Promise((resolve, reject) => {
    try {
      const { fecha } = datos;
      const doc = new PDFDocument({
        size: 'LETTER',
        margin: 36,
        layout: 'landscape',
        bufferPages: true,
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let y = drawPdfHeader(doc, fecha);
      y = drawSummaryCards(doc, datos.resumen || {}, y);

      y = drawTable(doc, {
        title: '1. Pagos por cliente',
        headers: ['Hora', 'Cobrador', 'Código', 'Cliente', 'Cédula', 'Recibo', 'Monto', 'Tipo', 'Renov.'],
        cols: [34, 52, 44, 148, 72, 46, 56, 46, 30],
        startY: y,
        highlightCol: 8,
        rows: (datos.pagos || []).map((p) => [
          p.hora,
          p.cobrador,
          p.codigo,
          p.cliente,
          fmtCedula(p.cedula),
          p.recibo || '—',
          money(p.monto),
          p.tipo_cobro,
          p.es_renovacion,
        ]),
      });

      y = drawTable(doc, {
        title: '2. Renovaciones',
        headers: ['Hora', 'Cobrador', 'Código', 'Cliente', 'Cédula', 'Recibo', 'Saldo ant.', 'Nuevo', 'Efectivo'],
        cols: [34, 50, 40, 120, 68, 42, 50, 50, 50],
        startY: y,
        rows: (datos.renovaciones || []).map((r) => [
          r.hora,
          r.cobrador,
          r.codigo,
          r.cliente,
          fmtCedula(r.cedula),
          r.recibo || '—',
          money(r.saldo_anterior),
          money(r.nuevo_monto),
          money(r.efectivo),
        ]),
      });

      y = drawTable(doc, {
        title: '3. Desembolsos',
        headers: ['Tipo', 'Renov.', 'Cobrador', 'Código', 'Cliente', 'Cédula', 'Recibo', 'Monto', 'Plazo'],
        cols: [48, 30, 50, 40, 110, 68, 42, 50, 36],
        startY: y,
        highlightCol: 1,
        rows: (datos.desembolsos || []).map((d) => [
          d.tipo === 'RENOVACION' ? 'Renov.' : 'Nuevo',
          d.es_renovacion,
          labelCobrador(d.cobrador),
          d.codigo,
          d.cliente,
          fmtCedula(d.cedula),
          d.recibo || '—',
          money(d.monto),
          `${d.plazo} sem`,
        ]),
      });

      drawTable(doc, {
        title: '4. Cierres de caja',
        headers: ['Cobrador', 'Tx cierre', 'Monto cierre', 'Tx pagos', 'Monto pagos', 'Cuadra'],
        cols: [100, 44, 72, 44, 72, 40],
        startY: y,
        rows: (datos.cierres || []).map((c) => [
          labelCobrador(c.cobrador),
          c.transacciones,
          money(c.monto_cierre),
          c.pagos_tx,
          money(c.pagos_monto),
          c.cuadra ? '✓ SI' : 'NO',
        ]),
      });

      addPageFooters(doc, fecha);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildPdfOperacionesDia };
