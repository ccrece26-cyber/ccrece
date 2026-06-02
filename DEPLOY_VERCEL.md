# Desplegar en Vercel (apiCrediCrece)

## 1. Variables de entorno (obligatorio)

En [Vercel](https://vercel.com) → proyecto **api-credi-crece** → **Settings** → **Environment Variables**, agregue **los mismos valores** que en su archivo local `backend/.env`:

| Variable | Ejemplo / nota |
|----------|----------------|
| `DB_HOST` | `gateway01.xxx.prod.aws.tidbcloud.com` (host TiDB Cloud) |
| `DB_PORT` | `4000` |
| `DB_USER` | usuario TiDB |
| `DB_PASSWORD` | contraseña TiDB |
| `DB_NAME` | `microfinanzas_nica` |
| `DB_SSL` | `true` |

También acepta prefijo `TIDB_*` (`TIDB_HOST`, `TIDB_USER`, etc.).

Marque **Production**, **Preview** y **Development** si usa las tres.

**No suba el archivo `.env` a GitHub** (ya está en `.gitignore`).

## 2. Redeploy

Tras guardar las variables: **Deployments** → último deploy → **Redeploy**.

O haga `git push` a `main` (Vercel redespliega solo).

## 3. Comprobar

Abra en el navegador:

```
https://api-credi-crece.vercel.app/api/health
```

Debe responder:

```json
{ "success": true, "tidb": "connected", ... }
```

Si `tidb: "misconfigured"` → faltan variables en Vercel.  
Si `tidb: "disconnected"` y menciona `127.0.0.1` → `DB_HOST` no está definido o es incorrecto.

## 4. App móvil

En `app-financiera/app.config.js` la URL ya apunta a:

`https://api-credi-crece.vercel.app/api`

Reinicie Expo: `npx expo start -c`
