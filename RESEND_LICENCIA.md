# Activación de app con Resend

## 1. Crear cuenta Resend

1. Entra en [https://resend.com](https://resend.com) e inicia sesión (ideal con **delveraz14@gmail.com**).
2. **API Keys** → **Create API Key** → copia la clave (`re_...`).

## 2. Variables en Vercel

Proyecto **api-credi-crece** → **Settings** → **Environment Variables**:

| Variable | Valor |
|----------|--------|
| `RESEND_API_KEY` | `re_xxxxxxxx` (tu API key) |
| `LICENSE_ADMIN_EMAIL` | `delveraz14@gmail.com` |
| `LICENSE_SECRET` | texto largo aleatorio (ej. 32+ caracteres) |
| `RESEND_FROM` | `Credi Crece <onboarding@resend.dev>` *(pruebas)* |

Marca **Production** (y Preview si quieres).

**No hace falta** configurar `SMTP_*` si usas Resend.

### Remitente (`RESEND_FROM`)

- **Pruebas:** `Credi Crece <onboarding@resend.dev>`  
  Con el dominio de prueba, Resend solo permite enviar al **mismo correo con el que te registraste**. Usa `LICENSE_ADMIN_EMAIL=delveraz14@gmail.com` si tu cuenta Resend es esa.
- **Producción:** en Resend → **Domains** → verifica tu dominio → usa por ejemplo `Credi Crece <activacion@tudominio.com>` en `RESEND_FROM`.

## 3. Redeploy

**Deployments** → **Redeploy** (obligatorio tras guardar variables).

## 4. Probar

En la app: **Solicitar código de activación**. Debe llegar un correo a `delveraz14@gmail.com` con 6 dígitos.

Prueba por API:

```bash
curl -X POST https://api-credi-crece.vercel.app/api/licencia/solicitar \
  -H "Content-Type: application/json" \
  -d "{\"deviceId\":\"test-12345678\",\"etiqueta\":\"Prueba\"}"
```

Respuesta esperada: `"success": true` y mensaje de código enviado.

## 5. Local (opcional)

En `backend/.env` (no subir a Git):

```
RESEND_API_KEY=re_...
LICENSE_ADMIN_EMAIL=delveraz14@gmail.com
LICENSE_SECRET=local-dev-secret
RESEND_FROM=Credi Crece <onboarding@resend.dev>
```

Luego `cd backend && npm start` y apunta la app a `http://TU_IP:3000/api` con `EXPO_PUBLIC_API_URL`.
