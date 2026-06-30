const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function enviarExpoPush(messages) {
  if (!messages.length) return { ok: 0, errores: [] };
  const errores = [];
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages.slice(0, 100)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const txt = JSON.stringify(data).slice(0, 300);
      console.warn('[expo-push] HTTP', res.status, txt);
      return { ok: 0, errores: [{ status: res.status, message: txt }] };
    }
    const tickets = data?.data || [];
    let ok = 0;
    for (const t of tickets) {
      if (t.status === 'ok') {
        ok += 1;
      } else {
        errores.push(t);
        console.warn('[expo-push] ticket error:', t.message || t.details?.error, t.details);
      }
    }
    return { ok, errores };
  } catch (e) {
    console.warn('[expo-push]', e.message);
    return { ok: 0, errores: [{ message: e.message }] };
  }
}

async function tokensAdminsActivos(query) {
  const rows = await query(
    `SELECT u.id, u.expo_push_token AS token
     FROM Usuarios u
     INNER JOIN Roles r ON u.rol_id = r.id
     WHERE r.nombre = 'ADMIN' AND u.activo = 1 AND u.deleted_at IS NULL
       AND u.expo_push_token IS NOT NULL AND TRIM(u.expo_push_token) != ''`
  );
  return rows
    .map((r) => ({ id: r.id, token: String(r.token).trim() }))
    .filter((r) => r.token.startsWith('ExponentPushToken'));
}

async function limpiarTokensInvalidos(_query, errores = []) {
  for (const e of errores) {
    if (e?.details?.error === 'DeviceNotRegistered') {
      console.warn('[expo-push] token expirado — el admin debe abrir la app y activar notificaciones');
    }
  }
}

/**
 * Notifica a admins cuando un cobrador sincroniza cobros (un push por lote, bajo consumo).
 */
async function notificarAdminsCobrosCobrador(query, cobros = []) {
  if (!cobros.length) return;

  const admins = await tokensAdminsActivos(query);
  if (!admins.length) {
    console.warn('[expo-push] sin tokens admin — abra la app admin y active notificaciones');
    return;
  }

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

  const messages = admins.map(({ token }) => ({
    to: token,
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

  const result = await enviarExpoPush(messages);
  console.log('[expo-push] admin cobros:', result.ok, '/', messages.length, 'tokens');
  if (result.errores?.length) {
    await limpiarTokensInvalidos(query, result.errores);
  }
}

module.exports = { notificarAdminsCobrosCobrador, enviarExpoPush, tokensAdminsActivos };
