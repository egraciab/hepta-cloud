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
backend/services/alta.js     # alta de un tenant en segundo plano (trabajos en memoria) y correo de bienvenida;
                             # la usan el alta manual (provision.routes) y la confirmación de pago (payments.routes)
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

## Alta de un tenant (flujo del Admin)

1. **Usuario** del portal (Usuarios → Nuevo, o "+ Nuevo usuario" dentro del alta). Sin contraseña: se genera sola.
   Ahí mismo se lo vincula a su **Cliente** (entidad fiscal); también se vincula y desvincula desde Clientes → Editar.
2. **Instancias → Nueva instancia**: usuario, subdominio y plan (`starter` = Despegue, `professional` = Crecimiento;
   Empresa no tiene alta automática). `POST /api/admin/provision` responde 202 con un trabajo y el Admin consulta
   `GET /api/admin/provision/jobs/:id` cada 8 s. El alta sigue aunque se cierre la ventana ("Altas en curso").
3. Al terminar se registra la instancia y sale el correo de bienvenida con el usuario y la contraseña del sistema
   y, si el usuario nunca entró al portal, también la del portal. Si algo queda a medias, el trabajo trae un `aviso`.

No volver a hacer el alta dentro de la petición HTTP: el proxy la corta al minuto y el alta tarda de 2 a 10.

## Pendientes

- [ ] API perimetral: validar `domain` y `db` en `/vhost` y sacar la lista de suspendidos de `/health`.
- [ ] TLS entre HEPTA Cloud y las dos APIs del puerto 8888: la contraseña inicial del cliente viaja sin cifrar
      dentro de la red interna. (El filtro por IP ya está: `ALLOWED_IPS` en el `.env` de cada API.)
- [ ] RetoPA: la ficha del cliente se crea solo con un botón del Admin; enganchar al alta si se ofrece en el plan.
- [ ] Entorno de prueba (no existe) y pasar los JS en línea de los HTML a archivos.
- [ ] Portal, después del lanzamiento: contratar y cambiar de plan desde el portal (la ruta `POST /api/portal/payment-request`
      existe pero ninguna pantalla la usa) y vincular al cliente con el ERP del grupo en el alta (`users.tenant_partner_id`):
      hasta entonces Facturas no se muestra y Soporte es un formulario que llega por correo.
- [ ] Admin, después del lanzamiento: menú plegable en celular, Configuración general en pestañas, buscador y paginado en
      Instancias/Usuarios/Leads, reenviar bienvenida, y quitar `plan` de `PUT /api/admin/instances/:id` (no cambia nada en Odoo).

## Hecho

- 2026-11-12 — Repo creado desde producción (sin secretos). Fuga de `site_config` cerrada, secretos enmascarados
  en el Admin, rotación de las claves de provisión, perimetral, RetoPA y SMTP. Límite de intentos en el login.
- 2026-11-12 — Alta de tenants sin `admin`/`admin`: script y API nuevos en `HGSVRLNX104` (instalan el plan, contraseña
  al azar para `admin`, usuario propio del cliente), alta en segundo plano y flujo del Admin ordenado. Probado en
  producción con dos altas de ensayo (Crecimiento y Despegue). `tienda2` era el único tenant con la clave de fábrica.
- 2026-11-13 — Tenants nuevos: menú de inicio `web_responsive` (OCA) con colores de HEPTA Cloud en lugar del de
  Zehntech, que arrastraba Punto de venta e Inventario a Despegue; el alta completa y verifica la contabilidad
  (antes nacían con diarios sin cuenta) y el menú "Inicio" del sitio apunta a la portada. En producción desde
  `odoo-tenants-addons@ebd0513`, probado con un alta desde el Admin. Los tenants anteriores no se tocaron.
- 2026-11-13 — Seguridad del alta: las APIs del puerto 8888 solo responden a HEPTA Cloud (`ALLOWED_IPS`), y el
  usuario `odoo` de `HGSVRLNX104` ya no tiene `sudo` total: solo `psql` y `createdb` como postgres
  (`/etc/sudoers.d/odoo-provision`). Marca de agua del menú de inicio en producción.
- 2026-11-14 — Sitio: retoque de diseño, contenido ajustado a lo que entrega cada plan (`sql/2026-11-14_contenido_sitio.sql`),
  `/api/site-config` sin `email_wc_*` ni `notify_*`, video de portada que no cae a la animación al recargar.
- 2026-11-14 — Admin: datos de afuera escapados (un lead con HTML se ejecutaba en el navegador del administrador), baja de
  instancias que exige el corte real y se puede reactivar, estado sin edición a mano, roles y contraseñas solo godmode,
  aviso cuando una carga falla.
- 2026-11-14 — Portal: menú en celular, recuperar contraseña por correo (`password_resets`, enlace de un uso, 1 hora; el
  código viaja después de `#` y solo se guarda su hash), Mi cuenta con datos en solo lectura, Soporte por formulario
  (`POST /api/portal/support`, queda en Leads con `[Soporte]`) y Facturas oculta mientras la cuenta no esté vinculada al ERP.
  Los pedidos de dominio fallaban: `leads.source` solo acepta website/whatsapp/retopa/referral/other.
