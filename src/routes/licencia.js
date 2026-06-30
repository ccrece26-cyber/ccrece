const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { obtenerIpCliente } = require('../utils/clientIp');
const { geolocalizarIp } = require('../utils/geoip');
const { enviarCodigoActivacion, smtpConfigurado, ADMIN_EMAIL } = require('../utils/licenciaEmail');
const { firmarToken, verificarToken } = require('../utils/licenciaToken');
const { ensureLicenciaTables } = require('../utils/ensureLicenciaTables');

const CODIGO_EXPIRA_HORAS = 48;
const MAX_SOLICITUDES_HORA = 5;
const MIN_SEGUNDOS_ENTRE_CORREOS = 90;

function generarCodigo6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function dispositivoActivado(deviceId) {
  const [row] = await query(
    'SELECT device_id FROM Licencias_Activados WHERE device_id = ? LIMIT 1',
    [deviceId]
  );
  return Boolean(row?.device_id);
}

async function solicitudesRecientes(deviceId) {
  const [row] = await query(
    `SELECT COUNT(*) AS n FROM Licencias_Codigos
     WHERE device_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    [deviceId]
  );
  return Number(row?.n || 0);
}

/** Evita reenvío si ya se mandó correo hace pocos segundos (doble tap o reintento HTTP). */
async function correoRecienteEnviado(deviceId) {
  const [row] = await query(
    `SELECT id, created_at FROM Licencias_Codigos
     WHERE device_id = ? AND email_enviado_at IS NOT NULL
       AND email_enviado_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
       AND used_at IS NULL AND expires_at > NOW()
     ORDER BY email_enviado_at DESC LIMIT 1`,
    [deviceId, MIN_SEGUNDOS_ENTRE_CORREOS]
  );
  return row || null;
}

function txtCampo(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

async function solicitarCodigo(req, res) {
  try {
    await ensureLicenciaTables();
    const deviceId = String(req.body.deviceId || '').trim();
    const etiqueta = txtCampo(req.body.etiqueta, 120);
    const solicitudIp = obtenerIpCliente(req);
    const deviceMarca = txtCampo(req.body.deviceMarca, 60);
    const deviceModelo = txtCampo(req.body.deviceModelo, 80);
    const deviceOs = txtCampo(req.body.deviceOs, 40);
    const appVersion = txtCampo(req.body.appVersion, 40);
    const geo = solicitudIp ? await geolocalizarIp(solicitudIp) : null;
    const metaDispositivo = {
      solicitudIp,
      deviceMarca,
      deviceModelo,
      deviceOs,
      appVersion,
      geoCiudad: geo?.ciudad || null,
      geoRegion: geo?.region || null,
      geoPais: geo?.pais || null,
      geoIsp: geo?.isp || null,
    };

    if (!deviceId || deviceId.length < 8) {
      return res.status(400).json({ success: false, message: 'Identificador de dispositivo inválido.' });
    }

    if (await dispositivoActivado(deviceId)) {
      const token = firmarToken(deviceId);
      return res.json({
        success: true,
        yaActivado: true,
        token,
        message: 'Este dispositivo ya está activado.',
      });
    }

    if (!smtpConfigurado()) {
      return res.status(503).json({
        success: false,
        message:
          'Correo no configurado. En Vercel agregue SMTP_* (Gmail) o RESEND_API_KEY y redeploy.',
      });
    }

    const recientes = await solicitudesRecientes(deviceId);
    if (recientes >= MAX_SOLICITUDES_HORA) {
      return res.status(429).json({
        success: false,
        message: 'Demasiadas solicitudes. Espere unos minutos e intente de nuevo.',
      });
    }

    const envioPrevio = await correoRecienteEnviado(deviceId);
    if (envioPrevio) {
      return res.json({
        success: true,
        message: `Ya se envió un código a ${ADMIN_EMAIL} hace unos segundos. Revise su correo (y spam).`,
        throttled: true,
        expiraHoras: CODIGO_EXPIRA_HORAS,
      });
    }

    const codigo = generarCodigo6();
    const codigoHash = await bcrypt.hash(codigo, 10);
    const id = uuidv4();

    await query(
      `INSERT INTO Licencias_Codigos
         (id, device_id, codigo_hash, etiqueta, solicitud_ip, device_marca, device_modelo, device_os, app_version,
          geo_ciudad, geo_region, geo_pais, geo_isp, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
      [
        id,
        deviceId,
        codigoHash,
        etiqueta,
        solicitudIp,
        deviceMarca,
        deviceModelo,
        deviceOs,
        appVersion,
        metaDispositivo.geoCiudad,
        metaDispositivo.geoRegion,
        metaDispositivo.geoPais,
        metaDispositivo.geoIsp,
        CODIGO_EXPIRA_HORAS,
      ]
    );

    await enviarCodigoActivacion({ codigo, deviceId, etiqueta, metaDispositivo, idempotencyKey: id });

    await query(`UPDATE Licencias_Codigos SET email_enviado_at = NOW() WHERE id = ?`, [id]);

    return res.json({
      success: true,
      message: `Código enviado a ${ADMIN_EMAIL}. El administrador se lo compartirá para activar la app.`,
      expiraHoras: CODIGO_EXPIRA_HORAS,
    });
  } catch (error) {
    console.error('licencia/solicitar:', error.message);
    if (error.code === 'SMTP_NOT_CONFIGURED') {
      return res.status(503).json({ success: false, message: error.message });
    }
    if (error.code === 'RESEND_ERROR') {
      return res.status(502).json({ success: false, message: error.message });
    }
    return res.status(500).json({
      success: false,
      message: 'No se pudo enviar el código. Verifique Resend/SMTP en Vercel.',
    });
  }
}

async function verificarCodigo(req, res) {
  try {
    await ensureLicenciaTables();
    const deviceId = String(req.body.deviceId || '').trim();
    const codigo = String(req.body.codigo || '').replace(/\D/g, '');

    if (!deviceId || codigo.length !== 6) {
      return res.status(400).json({ success: false, message: 'Código de 6 dígitos requerido.' });
    }

    if (await dispositivoActivado(deviceId)) {
      const token = firmarToken(deviceId);
      return res.json({ success: true, token, message: 'Dispositivo ya activado.' });
    }

    const rows = await query(
      `SELECT id, codigo_hash FROM Licencias_Codigos
       WHERE device_id = ? AND used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 10`,
      [deviceId]
    );

    let codigoId = null;
    for (const row of rows) {
      if (await bcrypt.compare(codigo, row.codigo_hash)) {
        codigoId = row.id;
        break;
      }
    }

    if (!codigoId) {
      return res.status(401).json({
        success: false,
        message: 'Código incorrecto o expirado. Solicite uno nuevo.',
      });
    }

    await query('UPDATE Licencias_Codigos SET used_at = NOW() WHERE id = ?', [codigoId]);
    await query(
      `INSERT INTO Licencias_Activados (device_id, activado_at)
       VALUES (?, NOW())
       ON DUPLICATE KEY UPDATE activado_at = NOW()`,
      [deviceId]
    );

    const token = firmarToken(deviceId);
    return res.json({ success: true, token, message: 'Activación correcta.' });
  } catch (error) {
    console.error('licencia/verificar:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function estadoLicencia(req, res) {
  try {
    await ensureLicenciaTables();
    const deviceId = String(req.query.deviceId || '').trim();
    const token = String(req.query.token || req.headers['x-licencia-token'] || '').trim();

    if (!deviceId) {
      return res.status(400).json({ success: false, activo: false });
    }

    const activoDb = await dispositivoActivado(deviceId);
    const tokenOk = verificarToken(deviceId, token);
    const activo = activoDb && tokenOk;

    return res.json({
      success: true,
      activo,
      activoDb,
      tokenOk,
    });
  } catch (error) {
    return res.status(500).json({ success: false, activo: false, message: error.message });
  }
}

module.exports = { solicitarCodigo, verificarCodigo, estadoLicencia };
