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
                             # portal_mail, provision, drive, public, public_mail; retopa.js es un helper, no un router
backend/config/              # db, odoo (XML-RPC), credenciales, secretos (AES-256-GCM), site_config_publico,
                             # credenciales_alta (texto del correo de bienvenida; la clave inicial no se guarda)
infra/                       # copia de la API perimetral y dónde vive lo demás (API y script de alta)
backend/services/alta.js     # alta de un tenant en segundo plano (trabajos en memoria) y correo de bienvenida;
                             # la usan el alta manual (provision.routes) y la confirmación de pago (payments.routes)
backend/services/adicionales.js  # instalar un módulo adicional (rubro) en una instancia, en segundo plano
backend/services/drive.js    # HEPTA Drive: pide el alta al agente de la VM hepta-drive y sigue el trabajo (provisioning_jobs)
backend/services/mailcow/    # cliente de mailcow, DNS y Cloudflare para el servicio de correo
infra/hepta-drive/           # todo lo de la VM hepta-drive: script de alta, agente (API con TLS), marca, respaldo. Ver su README
infra/backup/                # respaldos por VM: hepta-backup.sh, configuración de cada VM y retiro al NAS
backend/scripts/             # import_mail, provision_mail, avisar_credenciales, drive_configurar, drive_comprobar (a mano)
sql/, backend/migrate_*.sql, migracion_*.sql   # migraciones (se aplican a mano; no editar las ya aplicadas)
tools/webmail_add.sh         # alta de un webmail de cliente en el nginx perimetral
frontend/public/admin/v2/     # Admin nuevo, en paralelo al actual: módulos ES sin bundler, misma sesión (hc_admin_token);
                             # sus lecturas en backend/routes/admin_v2.routes.js (/api/admin/v2/*), las acciones usan las rutas de siempre
utils/old/                   # parches históricos (patch_*.py): solo referencia, no se ejecutan
```

## Integraciones (todas se configuran en la tabla `site_config`, no en el `.env`)

| Servicio | Dónde | Clave en `site_config` |
|---|---|---|
| Alta/suspensión de tenants Odoo | `hepta-provision` en `HGSVRLNX104:8888` (lee `PROVISION_API_KEY` de su `.env`) | `provision_api_url`, `provision_api_key` |
| Vhosts y certificados del perimetral (tenants y HEPTA Drive) | `hepta-perimetral` en `dkr-hgsvrlnx003:8888` (`PERIMETRAL_API_KEY`) | `perimetral_api_url`, `perimetral_api_key` |
| RetoPA (usuario y ficha del cliente) | API interna de RetoPA (`INTERNAL_API_KEY`), cabecera `X-Internal-Key` | `retopa_api_url`, `retopa_api_key`, `retopa_enabled`, `retopa_auto_list` |
| HEPTA Drive (Nextcloud por cliente) | agente en la VM `hepta-drive`, `10.10.50.220:8888`, **con TLS** y certificado propio | `drive_api_url`, `drive_api_key`, `drive_api_cert` (se cargan con `scripts/drive_configurar.js`) |
| Correo saliente | mailcow | `smtp_*` |

En el `.env`: `DB_*`, `JWT_SECRET`, `HEPTA_SECRET_KEY` (cifra las credenciales de integración), `CLOUDFLARE_API_TOKEN`, `ODOO_*`.

## Reglas que no se negocian

- **Secretos:** nunca en el repo, nunca por chat. Se generan en KeePass y se pegan en el servidor (`nano`, o
  `read -rs`). `.env`, `backups/`, dumps y copias `*.bak-*` están en `.gitignore`. Antes de commitear SQL con
  `INSERT INTO site_config`, verificar que no lleve valores reales.
- **Contraseña inicial del cliente:** la genera la API de alta y llega una sola vez. Va al correo de
  bienvenida y a ningún otro lado: ni base, ni `admin_logs`, ni `console.log`, ni respuesta al navegador.
- **Clave de `admin` de un tenant** (la cuenta de HEPTA): Admin → Instancias → *Clave admin* (solo godmode) la genera
  al azar en la API de alta (`POST /admin-password`) y la muestra **una vez** para copiarla a KeePass. No se guarda en
  la base ni en `admin_logs` (solo queda que se pidió), ni en la consola, ni en el log de la API.
- **`/api/site-config` es público.** Solo entrega claves que no son sensibles según
  `backend/config/site_config_publico.js`. Una clave nueva con una credencial tiene que terminar en `_key`,
  `_token`, `_pass`, `_password` o `_secret`, o empezar con un prefijo interno (`smtp_`, `provision_`,
  `perimetral_`, `cloudflare_`, `odoo_`, `mailcow_`, `drive_`, `retopa_api_`). Hasta el 2026-11-12 este endpoint devolvía
  la tabla entera (incidente; las cuatro claves expuestas se rotaron ese día).
- **Secretos de un alta de HEPTA Drive:** viven en la VM hasta que se bajan a KeePass (Admin → HEPTA Drive → *Bajar*, solo
  godmode). No se guardan en la base ni en `admin_logs`; solo queda quién los bajó y cuándo.
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

## Dominio propio de un tenant (Admin → Instancias → Editar → Activar dominio)

`backend/services/dominio_tenant.js`. Primero **revisa** (`GET /api/admin/provision/custom-domain/:id?domain=`, no cambia
nada) y el Admin muestra qué registros se crean o reemplazan; después corre en segundo plano, en este orden: vhost y
certificado en el perimetral (DNS-01, el subdominio sigue andando) → si la zona está en la cuenta de Cloudflare de HEPTA,
dominio y `www` como CNAME **con proxy** a `dominio_propio_lb` y la zona en SSL *Full (strict)* → prueba de
`https://dominio/web/login` → recién ahí el subdominio manda al dominio (301) y Odoo arma sus enlaces con el dominio
(API de alta `POST /website-domain`). Si la prueba falla, el DNS vuelve a como estaba. Nunca pisa un registro sin que se
haya visto y confirmado; MX y TXT no se tocan. Zona del cliente: crea él el CNAME, **sin proxy**, a `dns_proxy_host` (un
CNAME con proxy a nuestro balanceador desde otra cuenta de Cloudflare da error 1014). El `www` redirige al dominio.

## Pendientes

- [ ] TLS entre HEPTA Cloud y las dos APIs del puerto 8888: la contraseña inicial del cliente viaja sin cifrar
      dentro de la red interna. (El filtro por IP ya está: `ALLOWED_IPS` en el `.env` de cada API.)
- [ ] RetoPA: la ficha del cliente se crea solo con un botón del Admin; enganchar al alta si se ofrece en el plan.
- [ ] Credenciales: la clave de la API de RetoPA vive en `site_config` (`retopa_api_url`, `retopa_api_key`), no en Admin →
      Credenciales como las de Odoo. Pasarla al módulo de credenciales (cifrada, con vencimiento y "Probar").
- [ ] Entorno de prueba (no existe) y pasar los JS en línea de los HTML a archivos.
- [ ] Módulos adicionales que se superponen: no ofrecer uno si la instancia ya tiene otro incompatible (ej.: con
      Boutique instalado no se puede instalar Belleza y SPA, y al revés). Columna de exclusiones en `addons` y control en
      `services/adicionales.js` y en la API (pedido de Steve, 2026-11-18).
- [ ] Portal, después del lanzamiento: contratar y cambiar de plan desde el portal (la ruta `POST /api/portal/payment-request`
      existe pero ninguna pantalla la usa) y vincular al cliente con el ERP del grupo en el alta (`users.tenant_partner_id`):
      hasta entonces Facturas no se muestra y Soporte es un formulario que llega por correo.
- [ ] Admin nuevo (`/admin/v2/`): conviven los dos. El Pedido ya da de alta ERP, Mail y Drive (juntos o solos; el DNS del correo se
      publica recién después de ver qué se crea o reemplaza). **Estado y respaldos** (`services/estado.js`,
      `GET /api/admin/v2/estado`): ERP, Mail, Drive, respaldos y vista de afuera, con el reporte del vigía por `POST /api/monitor/vigia`.
      Faltan facturación y suscripción desde el ERP, dominio gestionado, el ERP del grupo en Estado y pasar las pantallas que hoy enlazan al Admin actual (planes,
      contenido, legales, configuración, credenciales, usuarios, baja de instancias). Pruebas: `tests/harness_admin_v2.js`
      (rutas, Postgres efímero), `tests/harness_estado.js` (panel Estado) y `tests/harness_admin_v2_ui.js` (Playwright con API simulada).
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
- 2026-11-15 — Respaldos de datos por VM: `infra/backup/hepta-backup.sh` (bases, carpetas de datos y configuración, con
  verificación de volcados) corre cada 6 h en `hepta-cloud`, `retopa-core`, `HGSVRLNX104` y `HGSVRLNX111`;
  `hepta-backup-retirar.sh` en `hcsvrnd01` los lleva al NAS con histórico y control de vida. Detalle y pendientes en el
  runbook `runbook-ha-backups.md` del Project. En esta VM el respaldo queda en `/var/backups/hepta/`.
- 2026-11-18 — Admin → Instancias → **Clave admin** (solo godmode): contraseña nueva al azar para `admin` del tenant,
  mostrada una sola vez. Necesita la API de alta 1.2.0 (`odoo-tenants-addons`, `tools/tenants/provision_api/main.py`).
- 2026-11-18 — **Módulos adicionales** (rubros sobre un plan): tablas `addons` e `instance_addons`
  (`sql/2026-11-18_modulos_adicionales.sql`, con Boutique y Belleza y SPA a precio "A definir"), lista y edición en
  Admin → Planes, botón **Módulos** en cada instancia (instala en segundo plano con la API de alta 1.3.0,
  `POST /install-module`, solo `hepta_rubro_*` y plan Crecimiento o superior).
- 2026-11-21 — **HEPTA Drive en el Admin**: alta de un Nextcloud por cliente desde Admin → HEPTA Drive (valida, crea en
  segundo plano, muestra el avance, baja el paquete de secretos a KeePass). Tablas `client_services` y `provisioning_jobs`
  (`sql/2026-11-21_hepta_drive.sql`). El trabajo lo hace el agente de la VM (`infra/hepta-drive/agente`), que termina en el
  script `hepta-drive-alta`; el respaldo del cliente nuevo lo enrola solo `hcsvrnd01`. La pantalla va en su propio
  archivo (`frontend/public/admin/drive.js`). Botón **Usuarios**: lista y suma usuarios a una instancia (nacen como
  usuarios comunes, invitados por correo). Correo pasó al grupo Portal como **HEPTA Mail**. Toda instancia nace con la marca
  Hepta Cloud y en `<cliente>.drive.hepta.com.py`; el logo del cliente es solo a pedido y por consola (`--logo`).
  El vhost lo crea solo al terminar el alta (API perimetral, `POST /drive-vhost`, que corre `drive_vhost_add.sh`); si falla,
  queda "sin publicar" con un botón para reintentar. Usuarios: barra de uso, quitar/devolver acceso y eliminar (godmode).
  **Dominio propio** (botón Dominio): se suma al nombre de HEPTA, que sigue andando. Si la zona está en la cuenta de Cloudflare
  de HEPTA crea el CNAME solo (`CLOUDFLARE_API_TOKEN`, sin pisar registros existentes); si no, comprueba el del cliente. La instancia lo
  acepta, el NGINX saca el certificado por HTTP y crea el vhost (`POST /drive-dominio`), y al final pasa a ser la dirección
  de los enlaces (`compose.override.yaml` del cliente). Quitarlo es por consola (`dominio-quitar` y `--quitar-dominio`).
  **Suspender / Reactivar** (modo mantenimiento: nadie entra, datos y copias siguen) y **Dar de baja** (godmode, repitiendo
  el nombre): última copia, apaga y archiva, quita los vhosts y el CNAME propio. No borra nada: los datos quedan en
  `/srv/nextcloud/_bajas` y el repositorio de copias se archiva solo (`hepta-respaldo-repos archivar`, vía `hcsvrnd01`).
  Borrar un repositorio archivado es siempre a mano y recién a los 30 días (`hepta-respaldo-repos borrar`).
- 2026-11-23 — **API perimetral 2.0.0** en `dkr-hgsvrlnx003`: `www-data` solo puede correr por sudo `hepta-tenant-nginx`
  (`tools/tenant_nginx.sh`: suspender, reactivar, dominio propio de tenants) y `drive_vhost_add.sh`; ya no tiene `nginx`,
  `certbot`, `tee`, `ln` ni `rm` sueltos. `/vhost` valida dominio, db y correo; `/health` sin la lista de suspendidos.
  Probado suspendiendo y reactivando `spademo` desde el Admin. Una instancia suspendida ya no devuelve un 503 pelado:
  manda a **`/suspendida?i=<tenant>`**, página de Hepta Cloud (servicio en pausa, datos a salvo, portal y WhatsApp).
- 2026-11-24 — **Dominio propio de tenants con revisión, Cloudflare y vuelta atrás** (`services/dominio_tenant.js`, ver la
  sección de arriba). Primer caso: `rygtech.com.py` (RYG Tech, Odoo 18 → tenant `rygtech`), por el balanceador
  `lb.hepta.com.py` con proxy y la zona en SSL strict. Necesita la API de alta 1.4.1 (`POST /website-domain`, que además avisa a los procesos de Odoo que limpien su caché) y los tokens de
  Cloudflare con alcance "todas las zonas de la cuenta": el del perimetral (certbot) con Zone Read + DNS Edit, y el de
  HEPTA Cloud con eso más Zone Settings Edit. La prueba resuelve con DNS públicos: el de la red guarda hasta una hora
  el "no existe" de un nombre recién creado.
