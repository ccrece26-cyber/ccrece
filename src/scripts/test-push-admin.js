#!/usr/bin/env node
/** Prueba envío Expo Push a todos los admins con token. */
require('dotenv').config();
const { query } = require('../config/db');
const { enviarExpoPush, tokensAdminsActivos } = require('../utils/expoPush');

async function main() {
  const admins = await tokensAdminsActivos(query);
  console.log('Admins con token:', admins.length);
  admins.forEach((a) => console.log(' -', a.id, a.token.slice(0, 40) + '...'));

  if (!admins.length) {
    console.log('\n❌ Ningún admin tiene token. Abra la app admin → Mi cuenta → Activar notificaciones.');
    process.exit(1);
  }

  const messages = admins.map(({ token }) => ({
    to: token,
    title: 'Credi Crece · Prueba',
    body: 'Si ve esto, las notificaciones push están funcionando.',
    sound: 'default',
    priority: 'high',
    channelId: 'cobros-admin',
    data: { tipo: 'prueba' },
  }));

  const res = await enviarExpoPush(messages);
  console.log('\nResultado:', res);
  process.exit(res.ok > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
