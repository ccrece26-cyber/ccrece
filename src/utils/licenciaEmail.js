const nodemailer = require('nodemailer');

const ADMIN_EMAIL = (process.env.LICENSE_ADMIN_EMAIL || 'delveraz14@gmail.com').trim();

function smtpConfigurado() {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
  );
}

function resendConfigurado() {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

async function enviarPorResend({ codigo, deviceId, etiqueta }) {
  const dispositivo = etiqueta || deviceId;
  const from = process.env.RESEND_FROM || 'Credi Crece <onboarding@resend.dev>';
  const html = `
    <h2>Credi Crece — código de activación</h2>
    <p><strong>Código:</strong> <span style="font-size:24px;letter-spacing:4px">${codigo}</span></p>
    <p><strong>Dispositivo:</strong> ${dispositivo}</p>
    <p><strong>ID:</strong> ${deviceId}</p>
    <p>Válido 48 horas. Comparta este código con el cliente.</p>
  `;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [ADMIN_EMAIL],
      subject: `Credi Crece — activación ${codigo}`,
      text: `Código: ${codigo}\nDispositivo: ${dispositivo}\nID: ${deviceId}`,
      html,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`Resend (${res.status}): ${txt.slice(0, 280)}`);
    err.code = 'RESEND_ERROR';
    throw err;
  }
  return { enviadoA: ADMIN_EMAIL };
}

async function enviarCodigoActivacion({ codigo, deviceId, etiqueta }) {
  if (resendConfigurado()) {
    return enviarPorResend({ codigo, deviceId, etiqueta });
  }

  if (!smtpConfigurado()) {
    const err = new Error(
      'Configure SMTP (SMTP_HOST, SMTP_USER, SMTP_PASS) o RESEND_API_KEY en Vercel.'
    );
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const dispositivo = etiqueta || deviceId;
  const html = `
    <h2>Credi Crece — código de activación</h2>
    <p>Se solicitó activar la app en un dispositivo.</p>
    <p><strong>Código:</strong> <span style="font-size:24px;letter-spacing:4px">${codigo}</span></p>
    <p><strong>Dispositivo:</strong> ${dispositivo}</p>
    <p><strong>ID:</strong> ${deviceId}</p>
    <p>Comparta este código con el cliente. Válido 48 horas.</p>
  `;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: ADMIN_EMAIL,
    subject: `Credi Crece — activación ${codigo}`,
    text: `Código de activación: ${codigo}\nDispositivo: ${dispositivo}\nID: ${deviceId}`,
    html,
  });

  return { enviadoA: ADMIN_EMAIL };
}

module.exports = {
  enviarCodigoActivacion,
  smtpConfigurado: () => smtpConfigurado() || resendConfigurado(),
  ADMIN_EMAIL,
};
