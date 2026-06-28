const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function enviarExpoPush(messages) {
  if (!messages.length) return;
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages.slice(0, 100)),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn('[expo-push] HTTP', res.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.warn('[expo-push]', e.message);
  }
}

async function tokensAdminsActivos(query) {
  const rows = await query(
    `SELECT u.expo_push_token AS token
     FROM Usuarios u
     INNER JOIN Roles r ON u.rol_id = r.id
     WHERE r.nombre = 'ADMIN' AND u.activo = 1 AND u.deleted_at IS NULL
       AND u.expo_push_token IS NOT NULL AND TRIM(u.expo_push_token) != ''`
  );
  return [...new Set(rows.map((r) => String(r.token).trim()).filter(Boolean))];
}

/**
 * Notifica a admins cuando un cobrador sincroniza cobros (un push por lote, bajo consumo).
 * @param {Function} query
 * @param {Array<{ monto: number, liquidacion?: boolean, clienteNombre?: string, cobradorNombre?: string }>} cobros
 */
async function notificarAdminsCobrosCobrador(query, cobros = []) {
  if (!cobros.length) return;
  const tokens = await tokensAdminsActivos(query);
  if (!tokens.length) return;

  const total = cobros.reduce((s, c) => s + Number(c.monto || 0), 0);
  const cobrador = cobros[0]?.cobradorNombre || 'Cobrador';
  const hayLiquidacion = cobros.some((c) => c.liquidacion);

  let title;
  let body;
  if (cobros.length === 1) {
    const c = cobros[0];
    title = hayLiquidacion ? 'Liquidación registrada' : 'Cobro registrado';
    body = `${cobrador} · ${c.clienteNombre || 'Cliente'} · C$${Number(c.monto).toFixed(2)}`;
  } else {
    title = `${cobros.length} cobros sincronizados`;
    body = `${cobrador} · Total C$${total.toFixed(2)}${hayLiquidacion ? ' (incl. liquidación)' : ''}`;
  }

  const messages = tokens.map((to) => ({
    to,
    title: `Credi Crece · ${title}`,
    body,
    sound: 'default',
    priority: 'high',
    channelId: 'cobros-admin',
    data: {
      tipo: 'cobro_cobrador',
      cantidad: cobros.length,
      monto_total: total,
      liquidacion: hayLiquidacion,
    },
  }));

  await enviarExpoPush(messages);
}

module.exports = { notificarAdminsCobrosCobrador, enviarExpoPush };
