# Infraestructura que HEPTA Cloud usa y no corre en este servidor

Copias versionadas de las piezas que el backend llama por red. **Nunca se sube un `.env`.**

| Pieza | Dónde corre | Fuente |
|---|---|---|
| API perimetral (`hepta-perimetral`): suspensión, vhosts y certificados de dominios propios | `dkr-hgsvrlnx003:8888`, `/opt/hepta/perimetral_api/main.py` | `infra/perimetral_api/main.py` (este repo) |
| API de alta (`hepta-provision`): alta, suspensión y reactivación de tenants | `HGSVRLNX104:8888`, `/opt/hepta/provision_api/main.py` | repo `egraciab/odoo-tenants-addons` → `tools/tenants/provision_api/main.py` |
| Script de alta | `HGSVRLNX104`, `/opt/odoo/scripts/provision_tenant.sh` | repo `egraciab/odoo-tenants-addons` → `tools/tenants/provision_tenant.sh` |

La API y el script de alta viven en el repo de los tenants porque ese es el que está clonado en
`HGSVRLNX104` (`/opt/odoo/repos/odoo-tenants-addons`) y se despliegan junto con los módulos de los planes.

## Credenciales de un tenant nuevo

- `admin` es la cuenta de HEPTA. Nace con una contraseña al azar que nadie conoce; para usarla se fija
  una desde KeePass con `tools/tenants/clave_usuario.sh <tenant>`.
- El cliente recibe su propio usuario (su correo), sin acceso a Aplicaciones ni Ajustes. La API de alta
  genera la contraseña inicial y la devuelve una sola vez; HEPTA Cloud la manda en el correo de bienvenida
  y no la guarda. Si ese correo no sale, el Admin avisa y se le fija una con
  `tools/tenants/clave_usuario.sh <tenant> <correo>`.
- `tools/tenants/auditar_clave_admin.sh` lista los tenants donde algún usuario sigue con la contraseña
  de fábrica.

## Pendiente conocido de la API perimetral (versionada tal cual está en producción)

- `DELETE /vhost/{domain}` no valida el dominio y `POST /vhost` no valida `db`: los dos terminan en rutas
  y archivos de nginx. Piden la clave, pero hay que validarlos igual.
- `/health` es público y lista los tenants suspendidos.
