/**
 * Convierte Cartera_cedicrece_16072026_DIAS_Y_REVISION_TASA.xlsx
 * al formato exacto de carga masiva (plantilla actual).
 *
 * Uso: node src/scripts/exportar-cartera-a-carga-masiva.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const path = require('path');
const XLSX = require('xlsx');
const { parseTasaMensualInput, calcularCuotaYDistribucion } = require('../utils/finanzasNube');
const { normalizarCedula } = require('../utils/cedulaNic');
const { PLANTILLA_COLUMNAS } = require('../utils/cargaMasivaPrestamos');

const SRC = path.join(__dirname, '../../../Cartera_cedicrece_16072026_DIAS_Y_REVISION_TASA.xlsx');
const OUT = path.join(__dirname, '../../../CrediCrece_carga_masiva_desde_cartera_16072026.xlsx');

const COLUMNAS = PLANTILLA_COLUMNAS;

/** Mapeo etiquetas del Excel → email real del cobrador */
const COBRADOR_MAP = {
  'cobrador 1': 'cobrador1',
  cobrador1: 'cobrador1',
  vielka: 'cobrador1',
  'cobrador 2': 'cobrador2',
  cobrador2: 'cobrador2',
};

function mapCobradorEmail(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return '';
  if (COBRADOR_MAP[s]) return COBRADOR_MAP[s];
  if (s.includes('@')) return s;
  if (s.includes('1')) return 'cobrador1';
  if (s.includes('2')) return 'cobrador2';
  return s;
}

/** Si no hay cobrador, intenta inferir por nombre del cliente o deja vacío (hoja Revisar). */
function resolverCobrador(row) {
  const mapped = mapCobradorEmail(row.cobrador_email || row.cobrador);
  if (mapped) return mapped;
  return '';
}

function asignarCedulasUnicas(filas) {
  const vistas = new Map(); // base → count
  const avisos = [];
  return filas.map((f) => {
    if (!f.cedula) return f;
    const base = f.cedula.replace(/\/\d+$/, '');
    const n = vistas.get(base) || 0;
    vistas.set(base, n + 1);
    if (n === 0) return f;
    const nueva = `${base}/${n + 1}`;
    avisos.push({
      nombre: f.nombre_completo,
      cedula_original: f.cedula,
      cedula_nueva: nueva,
      motivo: 'cedula_duplicada_en_archivo',
    });
    return { ...f, cedula: nueva };
  });
}

function parseDocumentoTipo(raw) {
  const t = String(raw || '')
    .trim()
    .toLowerCase();
  if (t === 'extranjero' || t === 'ext' || t === 'foreign' || t === 'e') return 'extranjero';
  return 'nacional';
}

/**
 * En el Excel de revisión, tasa_mensual suele ser la TASA GLOBAL (0.30 = 30%).
 * Carga masiva espera tasa MENSUAL en % (10) o decimal (0.10).
 * Convertimos: mensual_pct = (global / (plazo/4)) * 100, redondeada a 1 decimal.
 * Si no cuadra, usamos 10.
 */
function tasaMensualParaCarga(row) {
  const plazo = Math.max(1, Math.floor(Number(row.plazo_semanas) || 0));
  const meses = plazo / 4;
  const raw = row.tasa_mensual ?? row.tasa_global_archivo;
  const global = parseTasaMensualInput(raw); // 0.3 → 0.3, 30 → 0.3, 10 → 0.1
  // Heurística: si valor * meses ≈ global típico... 
  // Si el archivo ya guardó global (ej 0.3 con 3 meses), global/meses = 0.1 → 10%
  // Si alguien puso 10 pensando mensual, parseTasaMensualInput(10)=0.1, y 0.1/3 sería malo.
  // Detectar: si raw >= 1 y raw <= 100 y (raw/100)/meses ≈ 0.1? 
  // Mejor: usar nota del archivo si tasa_global_ok=SI → 10
  if (String(row.tasa_global_ok || '').toUpperCase() === 'SI') {
    return 10;
  }
  if (meses > 0 && global > 0) {
    // Si global parece mensual ya (≈0.08–0.15) y meses > 1, podría ser error.
    // Preferir: si global > 0.15 o (global ≈ 0.1 * meses), tratar como global.
    const mensualDec = global / meses;
    const pareceGlobal =
      Math.abs(global - 0.1 * meses) <= 0.02 ||
      global >= 0.15 ||
      (Number(raw) > 0 && Number(raw) < 1 && Number(raw) !== 0.1);
    if (pareceGlobal && mensualDec > 0.01 && mensualDec < 0.5) {
      return Number((mensualDec * 100).toFixed(1));
    }
    // raw ya era mensual en % (ej. 10)
    if (Number(raw) >= 1 && Number(raw) <= 30) return Number(raw);
    if (global >= 0.05 && global <= 0.2) return Number((global * 100).toFixed(1));
  }
  return 10;
}

function fechaISO(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && v >= 25569 && v < 120000) {
    return new Date((Math.floor(v) - 25569) * 86400 * 1000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s.includes('T') ? s : `${s}T12:00:00`);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

function esActivoParaCarga(row) {
  const marca = String(row.marca || '').toUpperCase();
  const estado = String(row.estado_credito || '').toUpperCase();
  const saldo = Number(row.saldo_pendiente);
  if (marca === 'CANCELADO' || estado === 'CANCELADO' || estado === 'PAGADO') return false;
  if (Number.isFinite(saldo) && saldo <= 0.009) return false;
  return true;
}

const SUFIJOS_NOMBRE = new Set([
  'HNA',
  'HNO',
  'HNO.',
  'HNA.',
  'HERMANA',
  'HERMANO',
  'ESPOSA',
  'ESPOSO',
  'SR',
  'SRA',
  'SR.',
  'SRA.',
]);

/**
 * Parte nombre completo NIC típico:
 * 1 token → primer_nombre
 * 2 → nombre + apellido
 * 3 → nombre + 2 apellidos
 * 4+ → 1er nombre, resto de nombres, 2 apellidos finales
 * Quita sufijos tipo HNA, (Hno), (Hermana).
 */
function partirNombreCompleto(nombreCompleto) {
  let s = String(nombreCompleto || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) {
    return {
      primer_nombre: '',
      segundo_nombre: '',
      primer_apellido: '',
      segundo_apellido: '',
      nombre_completo: '',
    };
  }

  let partes = s.split(' ').filter(Boolean);
  // Quitar sufijos al final (pueden repetirse)
  while (partes.length > 1) {
    const last = partes[partes.length - 1].toUpperCase().replace(/\./g, '');
    if (SUFIJOS_NOMBRE.has(last) || SUFIJOS_NOMBRE.has(partes[partes.length - 1].toUpperCase())) {
      partes = partes.slice(0, -1);
      continue;
    }
    break;
  }

  const keep = (w) => String(w || '').trim();

  let primer_nombre = '';
  let segundo_nombre = '';
  let primer_apellido = '';
  let segundo_apellido = '';

  if (partes.length === 1) {
    primer_nombre = keep(partes[0]);
  } else if (partes.length === 2) {
    primer_nombre = keep(partes[0]);
    primer_apellido = keep(partes[1]);
  } else if (partes.length === 3) {
    // Suele ser nombre compuesto + 1 apellido (VICTOR MANUEL RODRIGUEZ)
    primer_nombre = keep(partes[0]);
    segundo_nombre = keep(partes[1]);
    primer_apellido = keep(partes[2]);
  } else {
    // 4+: nombres = todo menos últimos 2; apellidos = últimos 2
    primer_nombre = keep(partes[0]);
    segundo_nombre = partes.slice(1, -2).map(keep).join(' ');
    primer_apellido = keep(partes[partes.length - 2]);
    segundo_apellido = keep(partes[partes.length - 1]);
  }

  const nombre_completo = [primer_nombre, segundo_nombre, primer_apellido, segundo_apellido]
    .filter(Boolean)
    .join(' ');

  return {
    primer_nombre,
    segundo_nombre,
    primer_apellido,
    segundo_apellido,
    nombre_completo: nombre_completo || s,
  };
}

function filaACarga(row) {
  const tipoFreq = String(row.tipo_frecuencia || '').trim().toUpperCase();
  const diasMes = String(row.dias_mes || '').trim();
  const diasCobro = String(row.dias_cobro || '').trim();
  let tipo_frecuencia = tipoFreq;
  if (!tipo_frecuencia) {
    tipo_frecuencia = diasMes || /\d+\s*(y|,)\s*\d+|cada\s*mes/i.test(diasCobro) ? 'DIAS_MES' : 'SEMANAL';
  }

  let cedula = normalizarCedula(row.cedula) || '';
  // Placeholders inválidos del archivo fuente
  if (!cedula || cedula === '0' || cedula.length < 8) cedula = '';

  const yaPartido =
    String(row.primer_nombre || '').trim() || String(row.primer_apellido || '').trim();
  const partidos = yaPartido
    ? {
        primer_nombre: String(row.primer_nombre || '').trim(),
        segundo_nombre: String(row.segundo_nombre || '').trim(),
        primer_apellido: String(row.primer_apellido || '').trim(),
        segundo_apellido: String(row.segundo_apellido || '').trim(),
        nombre_completo: String(row.nombre_completo || '').trim(),
      }
    : partirNombreCompleto(row.nombre_completo);

  const codigoRaw = row.codigo_cliente ?? row.No ?? row.no ?? row.numero_cliente;
  let codigo_cliente = '';
  if (codigoRaw != null && codigoRaw !== '') {
    const n = parseInt(String(codigoRaw).replace(/^CC-/i, ''), 10);
    if (Number.isFinite(n) && n >= 1) codigo_cliente = `CC-${n}`;
  }

  const plazo = Math.floor(Number(row.plazo_semanas) || 0);
  let semanas_pagadas = '';
  if (row.semanas_pagadas !== '' && row.semanas_pagadas != null) {
    let sem = Math.max(0, Math.floor(Number(row.semanas_pagadas) || 0));
    // En el archivo fuente a menudo mezclan "visitas" con "semanas".
    // Si sem > plazo y hay varios días de cobro, intentar convertir visitas → semanas.
    const diasN = String(row.dias_cobro || '')
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean).length;
    if (sem > plazo && plazo > 0 && diasN > 1 && sem % diasN === 0) {
      sem = Math.floor(sem / diasN);
    }
    // Si aún supera el plazo, vaciar: la verdad es saldo_pendiente / monto_pagado_historico.
    if (plazo > 0 && sem > plazo) {
      semanas_pagadas = '';
    } else {
      semanas_pagadas = sem;
    }
  }

  const tasa_mensual = tasaMensualParaCarga(row);
  const saldo_pendiente = Number(row.saldo_pendiente) || 0;
  const monto_desembolsado = Number(row.monto_desembolsado) || 0;
  // Pagado = total contrato − saldo (columna del Excel fuente suele no cuadrar).
  let monto_pagado_historico = '';
  if (monto_desembolsado > 0 && plazo > 0) {
    try {
      const diasArr = String(
        tipo_frecuencia === 'DIAS_MES' ? diasMes || diasCobro : diasCobro
      )
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const fin = calcularCuotaYDistribucion(
        monto_desembolsado,
        plazo,
        tipo_frecuencia === 'DIAS_MES' ? [1] : diasArr.length ? diasArr : ['LUNES'],
        parseTasaMensualInput(tasa_mensual),
        {
          tipo_frecuencia,
          dias_mes:
            tipo_frecuencia === 'DIAS_MES'
              ? diasArr.map((d) => Number(d)).filter((n) => n >= 1 && n <= 31)
              : undefined,
        }
      );
      const total = fin.montoTotalPagar;
      const saldoCap = Math.min(Math.max(0, saldo_pendiente), total);
      monto_pagado_historico = Number((total - saldoCap).toFixed(2));
    } catch {
      monto_pagado_historico = '';
    }
  }

  return {
    codigo_cliente,
    cedula,
    documento_tipo: parseDocumentoTipo(row.documento_tipo),
    primer_nombre: partidos.primer_nombre,
    primer_apellido: partidos.primer_apellido,
    segundo_nombre: partidos.segundo_nombre,
    segundo_apellido: partidos.segundo_apellido,
    nombre_completo: partidos.nombre_completo || String(row.nombre_completo || '').trim(),
    telefono: row.telefono != null && row.telefono !== '' ? String(row.telefono) : '',
    direccion: row.direccion || '',
    actividad_economica: row.actividad_economica || '',
    cobrador_email: resolverCobrador(row),
    monto_desembolsado,
    plazo_semanas: plazo,
    tasa_mensual,
    tipo_frecuencia,
    dias_cobro: tipo_frecuencia === 'DIAS_MES' ? '' : diasCobro,
    dias_mes: tipo_frecuencia === 'DIAS_MES' ? diasMes || diasCobro : '',
    fecha_desembolso: fechaISO(row.fecha_desembolso),
    saldo_pendiente,
    monto_pagado_historico,
    fecha_ultimo_abono: fechaISO(row.fecha_ultimo_abono),
    semanas_pagadas,
    latitud: row.latitud !== '' && row.latitud != null ? Number(row.latitud) : '',
    longitud: row.longitud !== '' && row.longitud != null ? Number(row.longitud) : '',
    orden_visita:
      row.orden_visita !== '' && row.orden_visita != null ? Number(row.orden_visita) : '',
  };
}

function main() {
  const wbIn = XLSX.readFile(SRC);
  const hoja =
    wbIn.SheetNames.find((n) => n.toLowerCase() === 'cartera') || wbIn.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wbIn.Sheets[hoja], { defval: '' });

  const activosRaw = [];
  const excluidos = [];
  for (const r of rows) {
    if (!esActivoParaCarga(r)) {
      excluidos.push({
        nombre: r.nombre_completo,
        cedula: r.cedula,
        marca: r.marca,
        estado: r.estado_credito,
        saldo: r.saldo_pendiente,
        motivo: 'cancelado_o_saldo_cero',
      });
      continue;
    }
    activosRaw.push(filaACarga(r));
  }

  const { filas: activosConCed, avisos: avisosCed } = (() => {
    const avisos = [];
    const filas = asignarCedulasUnicas(activosRaw);
    // re-run avisos capture: asignarCedulasUnicas mutates via map; collect diffs
    for (let i = 0; i < activosRaw.length; i += 1) {
      if (activosRaw[i].cedula && activosRaw[i].cedula !== filas[i].cedula) {
        avisos.push({
          nombre: filas[i].nombre_completo,
          cedula_original: activosRaw[i].cedula,
          cedula_nueva: filas[i].cedula,
          motivo: 'cedula_duplicada_en_archivo',
        });
      }
    }
    return { filas, avisos };
  })();

  const activos = [];
  const sinCobrador = [];
  for (const f of activosConCed) {
    if (!f.cobrador_email) {
      // Default seguro: cobrador1 (Vielka); queda en Revisar para confirmar
      sinCobrador.push({ ...f, cobrador_asignado: 'cobrador1', nota: 'Sin cobrador en origen; asignado cobrador1' });
      activos.push({ ...f, cobrador_email: 'cobrador1' });
    } else {
      activos.push(f);
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(activos, { header: COLUMNAS }),
    'Cartera'
  );

  const instrucciones = [
    { campo: 'origen', nota: path.basename(SRC) },
    { campo: 'filas_origen', nota: String(rows.length) },
    { campo: 'filas_carga', nota: String(activos.length) },
    { campo: 'excluidos', nota: String(excluidos.length) },
    {
      campo: 'tasa_mensual',
      nota: 'Convertida a % mensual (10 = 10%/mes). El archivo fuente tenía tasa GLOBAL.',
    },
    {
      campo: 'cobrador_email',
      nota: 'Cobrador 1→cobrador1, Cobrador 2→cobrador2. Ajuste si sus emails reales son otros.',
    },
    {
      campo: 'documento_tipo',
      nota: 'nacional por defecto. Cambie a extranjero si aplica.',
    },
    {
      campo: 'uso',
      nota: 'Importar en Admin → Carga masiva (hoja Cartera). Borrar filas de ejemplo si hubiera.',
    },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(instrucciones), 'Instrucciones');

  if (excluidos.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(excluidos), 'Excluidos');
  }
  if (sinCobrador.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sinCobrador), 'Revisar_cobrador');
  }
  if (avisosCed.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(avisosCed), 'Cedulas_ajustadas');
  }

  // Resumen tasas / cobradores
  const cobCount = {};
  const tasaCount = {};
  for (const a of activos) {
    cobCount[a.cobrador_email] = (cobCount[a.cobrador_email] || 0) + 1;
    tasaCount[a.tasa_mensual] = (tasaCount[a.tasa_mensual] || 0) + 1;
  }
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      ...Object.entries(cobCount).map(([k, v]) => ({ tipo: 'cobrador', valor: k, cantidad: v })),
      ...Object.entries(tasaCount).map(([k, v]) => ({
        tipo: 'tasa_mensual',
        valor: k,
        cantidad: v,
      })),
    ]),
    'Resumen'
  );

  XLSX.writeFile(wb, OUT);
  console.log('OK');
  console.log('  Origen:', SRC);
  console.log('  Salida:', OUT);
  console.log('  Activos carga:', activos.length);
  console.log('  Excluidos:', excluidos.length);
  console.log('  Sin cobrador (→cobrador1):', sinCobrador.length);
  console.log('  Cedulas /2:', avisosCed.length);
  console.log('  Cobradores:', cobCount);
  console.log('  Tasas mensuales:', tasaCount);
  if (avisosCed[0]) console.log('  Ej cedula /2:', avisosCed[0]);
  console.log('  Ejemplo1:', activos[0]);
}

main();
