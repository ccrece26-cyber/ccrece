# ccrece

API REST para **Credi Crece** (microfinanzas Nicaragua). Conecta la app móvil Expo con **TiDB Cloud** (MySQL).

## Requisitos

- Node.js 18+
- Base de datos TiDB Cloud configurada

## Instalación

```bash
npm install
cp .env.example .env
# Editar .env con credenciales TiDB
npm run migrate
npm start
```

Desarrollo con recarga automática:

```bash
npm run dev
```

## Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `DB_HOST` / `TIDB_HOST` | Host del cluster |
| `DB_PORT` | Puerto (4000 en TiDB Cloud) |
| `DB_USER` / `DB_PASSWORD` | Credenciales |
| `DB_NAME` | Nombre de la base |
| `DB_SSL` | `true` para TiDB Cloud |
| `DB_POOL_SIZE` | Conexiones del pool (default 25) |
| `PORT` | Puerto HTTP (default 3000) |
| `SKIP_STARTUP_TASKS` | `1` = sin migraciones en arranque |

## Endpoints principales

| Área | Rutas |
|------|--------|
| Salud | `GET /api/health` |
| Auth | `POST /api/auth/login` |
| Admin | `GET/POST /api/admin/*` |
| Modo campo admin | `GET /api/admin/campo/agenda`, `POST .../pago` |
| Cobrador | `GET /api/cobrador/ruta-diaria/:id`, `POST /api/cobrador/sync/push` |
| Sync legacy | `GET /api/sync/pull?since=&cobrador_id=` |

## Scripts útiles

```bash
npm run fix-cedulas      # Normaliza cédulas sin guión
npm run ensure-indexes   # Índices de rendimiento
npm run fix-schema       # Parches de esquema
npm run vistas-reporte   # Vistas SQL legibles (Excel / TiDB console)
```

### Vistas para reportes (sin la app)

Tras `npm run vistas-reporte` puede consultar en TiDB Cloud o exportar a Excel:

| Vista | Contenido |
|-------|-----------|
| `v_giros_financieros` | Todos los movimientos: desembolsos, cobros, renovaciones, gestiones |
| `v_operaciones_app` | Alias de la vista anterior |
| `v_cartera_activa` | Préstamos activos con saldo y cuotas pendientes |
| `v_prestamos` | Detalle de préstamos |
| `v_pagos` | Cobros registrados |
| `v_clientes` | Clientes con cobrador asignado |
| `v_rutas_clientes` | Orden de visita por ruta (cobradores y admin campo) |

Ejemplo:

```sql
SELECT * FROM v_giros_financieros WHERE fecha >= '2025-01-01' ORDER BY fecha_hora;
```

## Vercel (producción)

1. Conecte el repo en Vercel.
2. Configure variables de entorno — ver **[DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md)**.
3. Health: `https://api-credi-crece.vercel.app/api/health`

## App móvil

URL por defecto: `https://api-credi-crece.vercel.app/api` (ver `app-financiera/app.config.js`).

## Rendimiento

- Respuestas JSON comprimidas (gzip)
- Pool MySQL ampliado y keep-alive
- Pull sync en paralelo por tabla
- Índices en `updated_at`, cobrador y fechas de cobro
- Migraciones de arranque en segundo plano (no bloquean el listen)
