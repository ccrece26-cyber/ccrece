/**
 * Aplica Renovaciones 03082026.xlsx a la nube:
 * - Joharsys (CC-235): renovación real (saldo 2900 + 15000 desembolso)
 * - Resto clientes con crédito pagado: crédito NUEVO
 * - Clientes sin existencia: cliente + crédito NUEVO
 *
 * Regla financiera (sistema):
 * - tasa mensual = 10%
 * - 1 mes = 4 semanas
 * - plazo_base = floor(plazo_excel / 4) * 4  (si plazo >= 4; si < 4 usa el plazo completo)
 * - semanas de más → Historial_Prorrogas (interés congelado)
 * - total = base * (1 + 0.10 * (plazo_base/4))
 *
 *   CONFIRM_APLICAR_RENOV_3_8=yes node src/scripts/aplicar-renovaciones-03082026.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const path = require('path');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { query, getConnection, pool } = require('../config/db');
const { importarFilas } = require('../utils/cargaMasivaPrestamos');
const { aplicarProrrogaEnNube } = require('../utils/prorrogasNube');
const { calcularCuotaYDistribucion, parseTasaMensualInput } = require('../utils/finanzasNube');
const { resolverFrecuenciaCobro } = require('../utils/frecuenciaCobro');
const { bumpCarteraVersion } = require('../utils/carteraVersion');
const { splitNombreCompleto } = require('../utils/cliente');

const ROOT = path.join(__dirname, '../../..');
const FILE = path.join(ROOT, 'Renovaciones 03082026.xlsx');
const OUT = path.join(ROOT, 'Aplicacion_renovaciones_03082026.xlsx');
const APPLY = process.env.CONFIRM_APLICAR_RENOV_3_8 === 'yes';
const TASA_MENSUAL = 0.1;
const COD_JOHARSYS = 235;

const norm = (s) =>
  String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function pick(row, ...names) {
  const keys = Object.keys(row);
  for (const n of names) {
    const hit = keys.find((k) => norm(k.trim()) === norm(n));
    if (hit != null && row[hit] != null && row[hit] !== '') return row[hit];
  }
  return null;
}

function money(n) {
  return Number(Number(n).toFixed(2));
}

/** plazo_excel → base (múltiplos de 4 semanas) + prórroga residual */
function splitPlazo(plazoExcel) {
  const n = Math.max(1, Math.floor(Number(plazoExcel) || 1));
  if (n < 4) {
    return { plazo_total: n, plazo_base: n, semanas_prorroga: 0, meses: n / 4 };
  }
  const meses = Math.floor(n / 4);
  const plazo_base = meses * 4;
  const semanas_prorroga = n - plazo_base;
  return { plazo_total: n, plazo_base, semanas_prorroga, meses };
}

function mapCobradorEmail(raw) {
  const s = norm(raw);
  if (s.includes('2') || s.includes('COBRADOR 2')) return 'cobrador2';
  return 'cobrador1';
}

function fechaISO(v) {
  if (!v) return '2026-08-03';
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const m = String(v).match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  try {
    return new Date(v).toISOString().slice(0, 10);
  } catch {
    return '2026-08-03';
  }
}

function toFilaCarga(r, plan) {
  const no = Number(pick(r, 'No'));
  const nombre = String(pick(r, 'nombre_completo') || '').trim();
  const partes = splitNombreCompleto(nombre);
  const diasRaw = pick(r, 'dias_cobro') || 'LUNES';
  const freq = resolverFrecuenciaCobro({ dias_cobro: diasRaw });

  return {
    codigo_cliente: `CC-${no}`,
    cedula: String(pick(r, 'cedula') || '').trim(),
    documento_tipo: 'nacional',
    primer_nombre: partes.primer_nombre,
    segundo_nombre: partes.segundo_nombre,
    primer_apellido: partes.primer_apellido,
    segundo_apellido: partes.segundo_apellido,
    nombre_completo: nombre,
    telefono: pick(r, 'telefono'),
    direccion: pick(r, 'direccion'),
    actividad_economica: pick(r, 'actividad_economica'),
    cobrador_email: mapCobradorEmail(pick(r, 'cobrador_email')),
    monto_desembolsado: plan.monto_base_nominal || plan.monto_desembolso,
    // Separar producto y prórroga (carga masiva ya aplica semanas_prorroga)
    plazo_semanas: plan.plazo_base,
    semanas_prorroga: plan.semanas_prorroga,
    tasa_mensual: 10,
    tipo_frecuencia: freq.tipo,
    dias_cobro: String(diasRaw),
    fecha_desembolso: fechaISO(pick(r, 'fecha_desembolso')),
    // dejar que el motor calcule total = desembolso * (1 + 0.1 * meses); no forzar saldo > producto
    saldo_pendiente: null,
    monto_pagado_historico: 0,
    semanas_pagadas: 0,
    fecha_ultimo_abono: '',
    _meta: {
      no,
      plazo_excel: plan.plazo_total,
      plazo_base: plan.plazo_base,
      semanas_prorroga: plan.semanas_prorroga,
      tasa_global: plan.tasa_global,
      tipo: plan.tipo,
      monto_total_esperado: plan.monto_total,
    },
  };
}

  async function aplicarRenovacionJoharsys(conn, plan, excelRow, adminId) {
  const [rows] = await conn.execute(
    `SELECT p.*, c.id AS codigo, c.cobrador_id, c.nombre_completo
     FROM Prestamos p
     JOIN Clientes c ON c.id = p.cliente_id
     WHERE c.id = 'CC-235' AND p.deleted_at IS NULL AND p.estado = 'Activo'
     LIMIT 1`
  );
  if (!rows.length) throw new Error('CC-235 sin préstamo activo para renovar');
  const ant = rows[0];
  const saldoAnt = Number(ant.saldo_pendiente);
  if (saldoAnt <= 0.01) throw new Error('CC-235 sin saldo — no es renovación de sistema');

  // Modelo descuento: recibo = monto solicitado; interés sobre recibo; efectivo = recibo − saldo
  const montoRecibo = plan.monto_desembolso;
  if (montoRecibo + 0.009 < saldoAnt) {
    throw new Error(`Monto renovación ${montoRecibo} < saldo ${saldoAnt}`);
  }
  const efectivo = money(montoRecibo - saldoAnt);
  const diasRaw = pick(excelRow, 'dias_cobro') || ant.dias_de_cobro || 'SABADO';
  const freq = resolverFrecuenciaCobro({ dias_cobro: diasRaw });
  const calc = calcularCuotaYDistribucion(montoRecibo, plan.plazo_base, freq.diasParaAgenda, TASA_MENSUAL, {
    tipo_frecuencia: freq.tipo,
    dias_mes: freq.diasMes,
  });

  const nuevoId = uuidv4();
  const logId = uuidv4();
  const pagoId = uuidv4();
  const fecha = fechaISO(pick(excelRow, 'fecha_desembolso'));
  const diasJson = JSON.stringify(freq.diasParaAgenda);
  const cobradorEntrega = ant.cobrador_id;

  await conn.beginTransaction();
  try {
    // Cobro del saldo → cumplimiento cobrador
    await conn.execute(
      `INSERT INTO Pagos (
        id, prestamo_id, cobrador_id, monto_pagado, fecha_pago, latitud, longitud,
        registrado_por_admin, operador_id, is_synced
      ) VALUES (?, ?, ?, ?, ?, 0, 0, 1, ?, 1)`,
      [pagoId, ant.id, cobradorEntrega || adminId, saldoAnt, `${fecha} 18:00:00`, adminId]
    );

    await conn.execute(
      `UPDATE Prestamos SET estado = 'Pagado', saldo_pendiente = 0, updated_at = NOW(), is_synced = 1
       WHERE id = ?`,
      [ant.id]
    );

    await conn.execute(
      `INSERT INTO Prestamos (
        id, cliente_id, monto_desembolsado, plazo_semanas, tasa_interes_aplicada,
        cuota_semanal_base, monto_total_pagar, saldo_pendiente, dias_de_cobro, periodicidad,
        renovacion_previa_id, estado, fecha_desembolso,
        cobrador_registro_id, cobrador_entrega_id, is_synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Activo', ?, ?, ?, 1)`,
      [
        nuevoId,
        ant.cliente_id,
        montoRecibo,
        plan.plazo_base,
        calc.tasaInteresAplicada,
        calc.cuotaSemanalBase,
        calc.montoTotalPagar,
        calc.montoTotalPagar,
        diasJson,
        freq.periodicidad || 'SEMANAL',
        ant.id,
        fecha,
        adminId,
        cobradorEntrega,
      ]
    );

    await conn.execute(
      `INSERT INTO Renovaciones_Log (
        id, prestamo_anterior_id, prestamo_nuevo_id, saldo_pendiente_anterior, nuevo_desembolso,
        base_nominal, tasa_aplicada, monto_total_a_pagar, cuota_semanal, fecha_renovacion,
        cobrador_opero_id, cobrador_entrega_id, plazo_semanas, efectivo_entregar, is_synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        logId,
        ant.id,
        nuevoId,
        saldoAnt,
        montoRecibo,
        montoRecibo,
        calc.tasaInteresAplicada,
        calc.montoTotalPagar,
        calc.cuotaSemanalBase,
        fecha,
        adminId,
        cobradorEntrega,
        plan.plazo_base,
        efectivo,
      ]
    );

    if (plan.semanas_prorroga > 0) {
      await aplicarProrrogaEnNube(conn, {
        prestamo_id: nuevoId,
        semanas_extra: plan.semanas_prorroga,
        comentario: `Exceso plazo Excel (${plan.plazo_total} sem): base ${plan.plazo_base} @10%/mes + ${plan.semanas_prorroga} prórroga`,
        operador_id: adminId,
      });
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  }

  return {
    tipo: 'renovacion',
    codigo: 'CC-235',
    prestamo_anterior_id: ant.id,
    prestamo_nuevo_id: nuevoId,
    saldo_anterior: saldoAnt,
    monto_recibo: montoRecibo,
    base_nominal: montoRecibo,
    plazo_base: plan.plazo_base,
    semanas_prorroga: plan.semanas_prorroga,
    tasa_aplicada: calc.tasaInteresAplicada,
    monto_total: calc.montoTotalPagar,
    cuota: calc.cuotaSemanalBase,
    efectivo_entregar: efectivo,
    pago_saldo_id: pagoId,
  };
}

(async () => {
  const renovRows = XLSX.utils.sheet_to_json(
    XLSX.readFile(FILE, { raw: true, cellDates: true }).Sheets['Hoja1'],
    { defval: null, raw: true }
  );

  const cloudActivos = await query(`
    SELECT c.id AS codigo, c.cedula, c.nombre_completo, p.id AS prestamo_id,
           p.estado, p.saldo_pendiente, p.monto_desembolsado
    FROM Prestamos p
    JOIN Clientes c ON c.id = p.cliente_id AND c.deleted_at IS NULL
    WHERE p.deleted_at IS NULL AND p.estado = 'Activo'
  `);
  const activoByCodigo = new Map();
  const activoByCedula = new Map();
  for (const a of cloudActivos) {
    activoByCodigo.set(String(a.codigo).toUpperCase(), a);
    const m = String(a.codigo).match(/(\d+)/);
    if (m) activoByCodigo.set(String(Number(m[1])), a);
    if (a.cedula) activoByCedula.set(String(a.cedula).toUpperCase().replace(/\s/g, ''), a);
  }

  const planes = [];
  for (const r of renovRows) {
    const no = Number(pick(r, 'No'));
    const monDes = Number(pick(r, 'monto_desembolsado', ' monto_desembolsado'));
    const plazoExcel = Number(pick(r, 'plazo_semanas'));
    const split = splitPlazo(plazoExcel);
    const act =
      activoByCodigo.get(String(no)) ||
      activoByCodigo.get(`CC-${no}`) ||
      activoByCedula.get(String(pick(r, 'cedula') || '').toUpperCase().replace(/\s/g, '')) ||
      null;

    let tipo;
    let saldoArrastre = 0;
    if (no === COD_JOHARSYS && act && Number(act.saldo_pendiente) > 0.01) {
      tipo = 'renovacion';
      saldoArrastre = Number(act.saldo_pendiente);
    } else if (act && Number(act.saldo_pendiente) > 0.01) {
      tipo = 'bloqueado_activo';
    } else {
      tipo = 'credito_nuevo';
    }

    const baseNominal = money((tipo === 'renovacion' ? saldoArrastre : 0) + monDes);
    const tasaGlobal = Number((TASA_MENSUAL * (split.plazo_base / 4)).toFixed(4));
    const montoTotal = money(baseNominal * (1 + tasaGlobal));

    planes.push({
      no,
      nombre: pick(r, 'nombre_completo'),
      cedula: pick(r, 'cedula'),
      excel: r,
      tipo,
      monto_desembolso: monDes,
      saldo_arrastre: saldoArrastre,
      monto_base_nominal: baseNominal,
      plazo_total: split.plazo_total,
      plazo_base: split.plazo_base,
      semanas_prorroga: split.semanas_prorroga,
      meses: split.meses,
      tasa_mensual: TASA_MENSUAL,
      tasa_global: tasaGlobal,
      monto_total: montoTotal,
      fecha: fechaISO(pick(r, 'fecha_desembolso')),
      cobrador: mapCobradorEmail(pick(r, 'cobrador_email')),
      dias: pick(r, 'dias_cobro'),
    });
  }

  console.log(
    JSON.stringify(
      {
        dry_run: !APPLY,
        planes: planes.map((p) => ({
          no: p.no,
          nombre: p.nombre,
          tipo: p.tipo,
          desembolso: p.monto_desembolso,
          arrastre: p.saldo_arrastre,
          base: p.monto_base_nominal,
          plazo_excel: p.plazo_total,
          plazo_base: p.plazo_base,
          prorroga: p.semanas_prorroga,
          tasa_global_pct: money(p.tasa_global * 100),
          total: p.monto_total,
        })),
      },
      null,
      2
    )
  );

  if (!APPLY) {
    console.log('\nSin cambios. Ejecute con CONFIRM_APLICAR_RENOV_3_8=yes');
    await pool.end();
    process.exit(0);
  }

  const resultados = [];
  const errores = [];

  // 1) Renovación Joharsys
  const planJ = planes.find((p) => p.tipo === 'renovacion' && p.no === COD_JOHARSYS);
  if (planJ) {
    const conn = await getConnection();
    try {
      const res = await aplicarRenovacionJoharsys(conn, planJ, planJ.excel, 'USER-ADMIN-1');
      resultados.push(res);
      console.log('OK renovación Joharsys', res);
    } catch (e) {
      errores.push({ no: 235, error: e.message });
      console.error('ERR Joharsys', e.message);
    } finally {
      conn.release();
    }
  }

  // 2) Créditos nuevos
  const nuevos = planes.filter((p) => p.tipo === 'credito_nuevo');
  const filasCarga = nuevos.map((p) => toFilaCarga(p.excel, p));

  if (filasCarga.length) {
    const imp = await importarFilas(filasCarga, query, getConnection, { optimizar_rutas: true });
    console.log('import nuevos', {
      importados: imp.importados,
      fallidos: imp.fallidos,
      exitos: imp.detalle_exitos,
      fallos: imp.detalle_fallos,
    });

    for (const f of filasCarga) {
      const meta = f._meta;
      const [pRow] = await query(
        `SELECT id, plazo_semanas, monto_total_pagar, saldo_pendiente, tasa_interes_aplicada, monto_desembolsado
         FROM Prestamos
         WHERE cliente_id = ? AND deleted_at IS NULL AND estado = 'Activo'
         ORDER BY fecha_desembolso DESC LIMIT 1`,
        [f.codigo_cliente]
      );
      if (!pRow) {
        errores.push({ no: meta.no, error: 'No se creó préstamo activo' });
        continue;
      }

      // La carga masiva ya aplicó semanas_prorroga; no duplicar.
      const [final] = await query(
        `SELECT plazo_semanas, saldo_pendiente, monto_total_pagar, tasa_interes_aplicada, monto_desembolsado,
                (SELECT COALESCE(SUM(semanas_extra),0) FROM Historial_Prorrogas h
                 WHERE h.prestamo_id = p.id AND h.deleted_at IS NULL) AS semanas_prorroga
         FROM Prestamos p WHERE id = ?`,
        [pRow.id]
      );

      resultados.push({
        tipo: 'credito_nuevo',
        codigo: f.codigo_cliente,
        nombre: f.nombre_completo,
        prestamo_id: pRow.id,
        desembolso: Number(final?.monto_desembolsado),
        plazo_base: meta.plazo_base,
        semanas_prorroga: Number(final?.semanas_prorroga || 0),
        plazo_final: Number(final?.plazo_semanas),
        tasa: Number(final?.tasa_interes_aplicada),
        total: Number(final?.monto_total_pagar),
        saldo: Number(final?.saldo_pendiente),
        total_esperado: meta.monto_total_esperado,
      });
    }

    if (imp.detalle_fallos?.length) {
      for (const f of imp.detalle_fallos) {
        errores.push({ error: f.error || f.message || JSON.stringify(f), detalle: f });
      }
    }
  }

  for (const p of planes.filter((x) => x.tipo === 'bloqueado_activo')) {
    errores.push({
      no: p.no,
      error: `Cliente con crédito activo (saldo ${p.saldo_arrastre || '?'}) — no se cargó como nuevo`,
    });
  }

  await bumpCarteraVersion();

  const verif = await query(`
    SELECT c.id AS codigo, c.nombre_completo, p.estado, p.monto_desembolsado, p.plazo_semanas,
           p.tasa_interes_aplicada, p.monto_total_pagar, p.saldo_pendiente, p.fecha_desembolso,
           p.renovacion_previa_id,
           (SELECT COALESCE(SUM(semanas_extra),0) FROM Historial_Prorrogas h
            WHERE h.prestamo_id=p.id AND h.deleted_at IS NULL) AS semanas_prorroga
    FROM Prestamos p
    JOIN Clientes c ON c.id = p.cliente_id
    WHERE p.deleted_at IS NULL AND p.estado = 'Activo'
      AND c.id IN (${planes.map((p) => `'CC-${p.no}'`).join(',')})
    ORDER BY CAST(SUBSTRING_INDEX(c.id,'-',-1) AS UNSIGNED)
  `);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      planes.map((p) => ({
        No: p.no,
        nombre: p.nombre,
        tipo: p.tipo,
        desembolso: p.monto_desembolso,
        arrastre: p.saldo_arrastre,
        base: p.monto_base_nominal,
        plazo_excel: p.plazo_total,
        plazo_base: p.plazo_base,
        prorroga: p.semanas_prorroga,
        tasa_global_pct: money(p.tasa_global * 100),
        total: p.monto_total,
      }))
    ),
    'Plan'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(resultados.length ? resultados : [{ ok: 0 }]),
    'Aplicados'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(errores.length ? errores : [{ ok: 1 }]),
    'Errores'
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(verif), 'Nube_activo');
  XLSX.writeFile(wb, OUT);

  console.log(
    JSON.stringify(
      {
        success: errores.length === 0,
        aplicados: resultados.length,
        errores,
        nube: verif,
        excel: OUT,
      },
      null,
      2
    )
  );

  await pool.end();
  process.exit(errores.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
