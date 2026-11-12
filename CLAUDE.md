# HEPTA Cloud — guía para Claude Code

HEPTA Cloud (cloud.hepta.com.py) es la plataforma de servicios de HEPTA E.A.S.: sitio comercial, panel de
administración y portal de clientes para vender y operar **Odoo 19 CE multi-tenant** (planes Despegue y
Crecimiento), **correo** (mailcow) y dominios. Este repo es el punto de contacto entre Steve, Claude (chat) y
Claude Code. **Leelo completo antes de tocar código.**

## Stack y dónde corre

- Node 20 / Express 4, CommonJS, sin TypeScript ni ORM (`pg` Pool en `backend/config/db.js`).
- PostgreSQL 16 **en el host** (base `heptacloud`), no en contenedor. El backend llega por `host.docker.internal`.
- Frontend: tres HTML grandes con JS en línea (`frontend/public/`: sitio, `admin/`, `portal/`), servidos por el
  mismo backend. Sin framework ni bundler. `frontend/` va montado como volumen: un cambio de HTML no pide rebuild.
- Un solo contenedor: `heptacloud_backend` (puerto 3100). Delante está el NGINX perimetral (`dkr-hgsvrlnx003`).
- VM `hepta-cloud`, ruta `/opt/heptacloud`. **No hay entorno de desarrollo todavía: lo que se despliega es producción.**

Deploy: `cd /opt/heptacloud && git pull origin main && docker compose up -d --build backend`.
Después: `curl -s -o /dev/null -w '%{http_code}\n' https://cloud.hepta.com.py/api/health`.

## Estructura

```
backend/server.js            # arranque, CORS, rate limit, montaje de rutas (el orden importa)
backend/middleware/auth.js   # JWT Bearer: requireAuth, requireAdmin (admin|godmode), requireGodmode
backend/routes/              # admin, admin_mail, auth, clients, credentials, leads, payments, portal,
                             # portal_mail, provision, public, public_mail; retopa.js es un helper, no un router
backend/config/              # db, odoo (XML-RPC), credenciales, secretos (AES-256-GCM), site_config_publico,
                             # credenciales_alta (texto del correo de bienvenida; la clave inicial no se guarda)
infra/                       # copia de la API perimetral y dónde vive lo demás (API y script de alta)
backend/services/mailcow/    # cliente de mailcow, DNS y Cloudflare para el servicio de correo
backend/scripts/             # import_mail, provision_mail, avisar_credenciales (se corren a mano)
sql/, backend/migrate_*.sql, migracion_*.sql   # migraciones (se aplican a mano; no editar las ya aplicadas)
tools/webmail_add.sh         # alta de un webmail de cliente en el nginx perimetral
utils/old/                   # parches históricos (patch_*.py): solo referencia, no se ejecutan
```

## Integraciones (todas se configuran en la tabla `site_config`, no en el `.env`)

| Servicio | Dónde | Clave en `site_config` |
|---|---|---|
| Alta/suspensión de tenants Odoo | `hepta-provision` en `HGSVRLNX104:8888` (lee `PROVISION_API_KEY` de su `.env`) | `provision_api_url`, `provision_api_key` |
| Vhosts y certificados del perimetral | `hepta-perimetral` en `dkr-hgsvrlnx003:8888` (`PERIMETRAL_API_KEY`) | `perimetral_api_url`, `perimetral_api_key` |
| RetoPA (usuario y ficha del cliente) | API interna de RetoPA (`INTERNAL_API_KEY`), cabecera `X-Internal-Key` | `retopa_api_url`, `retopa_api_key`, `retopa_enabled`, `retopa_auto_list` |
| Correo saliente | mailcow | `smtp_*` |

En el `.env`: `DB_*`, `JWT_SECRET`, `HEPTA_SECRET_KEY` (cifra las credenciales de integración), `CLOUDFLARE_API_TOKEN`, `ODOO_*`.

## Reglas que no se negocian

- **Secretos:** nunca en el repo, nunca por chat. Se generan en KeePass y se pegan en el servidor (`nano`, o
  `read -rs`). `.env`, `backups/`, dumps y copias `*.bak-*` están en `.gitignore`. Antes de commitear SQL con
  `INSERT INTO site_config`, verificar que no lleve valores reales.
- **Contraseña inicial del cliente:** la genera la API de alta y llega una sola vez. Va al correo de
  bienvenida y a ningún otro lado: ni base, ni `admin_logs`, ni `console.log`, ni respuesta al navegador.
- **`/api/site-config` es público.** Solo entrega claves que no son sensibles según
  `backend/config/site_config_publico.js`. Una clave nueva con una credencial tiene que terminar en `_key`,
  `_token`, `_pass`, `_password` o `_secret`, o empezar con un prefijo interno (`smtp_`, `provision_`,
  `perimetral_`, `cloudflare_`, `odoo_`, `mailcow_`, `retopa_api_`). Hasta el 2026-11-12 este endpoint devolvía
  la tabla entera (incidente; las cuatro claves expuestas se rotaron ese día).
- **Frontera de licencia:** los clientes van al Odoo 19 CE multi-tenant; el ERP Enterprise del grupo nunca aloja
  bases de clientes.
- **Producción:** cambio con respaldo antes (`pg_dump` de `heptacloud`) y verificación después. Sin adivinar
  infraestructura: pedir la salida exacta del comando.
- Idioma: español rioplatense con voseo en comentarios, mensajes y docs. Respuestas de API `{ success, data?, error?, code? }`.

## Pendientes

- [ ] **Contraseña inicial de los tenants (bloquea el lanzamiento del 30-nov):** código listo el 2026-11-12
      (ver `infra/README.md`). Falta: probar el alta en staging de tenants, reemplazar el script y la API en
      `HGSVRLNX104`, desplegar acá y correr `auditar_clave_admin.sh` sobre los tenants que ya existen.
- [ ] API perimetral: validar `domain` y `db` en `/vhost` y sacar la lista de suspendidos de `/health`.
- [ ] Limitar el puerto 8888 de las dos APIs a la IP de HEPTA Cloud (hoy escuchan en todas las interfaces, sin TLS).
- [ ] El alta espera hasta 11 minutos con la conexión abierta: pasarla a segundo plano con estado consultable.
- [ ] RetoPA: la ficha del cliente se crea solo con un botón del Admin; enganchar al alta si se ofrece en el plan.
- [ ] Entorno de prueba (no existe) y pasar los JS en línea de los HTML a archivos.

## Hecho

- 2026-11-12 — Repo creado desde producción (sin secretos). Fuga de `site_config` cerrada, secretos enmascarados
  en el Admin, rotación de las claves de provisión, perimetral, RetoPA y SMTP. Límite de intentos en el login.
