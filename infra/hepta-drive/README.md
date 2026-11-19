# HEPTA Drive (Nextcloud como servicio)

VM `hepta-drive` (10.10.50.220, DMZ). Un Nextcloud por cliente, con OnlyOffice y ClamAV compartidos. Todo el estado de
un cliente vive en `/srv/nextcloud/<cliente>/` (`html/`, `data/`, `db/`), en el volumen de datos `hepta-drive-data`.

> **Estado al 2026-11-19 (noche):** servidor de respaldos instalado (`hepta-respaldo`, 10.10.10.20), primera copia de
> `hepta` hecha y **prueba de restauración OK** (archivos sin diferencias; base restaurada con sus roles y vuelta a
> volcar). Copia nocturna y mantenimiento programados, **todavía no vistos correr solos**. Réplica al NAS y a Drive:
> escrita y probada en un entorno local, falta instalarla en `hcsvrnd01`.

## Qué hay acá

| Carpeta | Va a | Qué es |
|---|---|---|
| `shared/` | `/opt/hepta-drive/shared/` | OnlyOffice y ClamAV. Red Docker externa `hd-shared` |
| `cliente/` | `/opt/hepta-drive/clientes/<cliente>/` | Plantilla de un cliente: `db`, `redis`, `app`, `cron` |
| `respaldo/hepta-drive-respaldo.sh` | VM `hepta-drive` | Volcado de la base y copia con restic, por cliente |
| `respaldo/hepta-respaldo-repos.sh` | servidor de respaldos | Alta de repositorios, depuración, verificación y estado |
| `respaldo/instalar-servidor.sh` | contenedor `hepta-respaldo` | Instala restic, rest-server (versión fijada), certificado, servicio y cron |
| `respaldo/instalar-vm.sh` | VM `hepta-drive` | Instala el script, el certificado del servidor y prueba que llegue |
| `respaldo/hepta-drive-prueba-restauracion.sh` | VM `hepta-drive` | Baja una copia, la compara con producción y restaura la base en un Postgres temporal |
| `respaldo/hepta-drive-replicar.sh` | `hcsvrnd01` | Copia los repositorios verificados al NAS (`/mnt/nas/hepta-drive-repos`) y comprueba cada archivo |
| `../backup/conf/hepta-drive.conf` | `/etc/hepta-backup.conf` de la VM | Configuración y volcados cada 6 h, como las demás VM |

Los `.env` no se versionan: `env.ejemplo` tiene solo los nombres. Los valores nacen en KeePass.

## Diseño del respaldo (decidido con Steve, 2026-11-19)

| Capa | Qué protege | Dónde |
|---|---|---|
| Papelera y versiones, 90 días | Errores del usuario | Nextcloud |
| Snapshots del volumen cada 6 h, 7 días | Vuelta atrás rápida | Pool `remote` |
| Copia diaria con restic, cifrada | Daño del volumen o del pool SSD | Servidor de respaldos, pool `ceph-hdd` |
| Réplica del repositorio | Pérdida del clúster | NAS |
| Réplica fuera de sitio | Pérdida de la sala | Google Drive |

- **La VM no puede borrar sus respaldos.** El servidor (`rest-server`) corre en modo solo-agregar y con un usuario por
  cliente (`--append-only --private-repos`): cada cliente escribe en su repositorio y no ve los demás.
- **Un repositorio por cliente**, con dos contraseñas propias en KeePass: la de acceso al servidor y la del
  repositorio (la que cifra). Sin la segunda, la copia no se puede leer.
- **Retención:** 14 diarios, 8 semanales, 6 mensuales. La depuración y la verificación corren en el servidor.
- **El servidor** es el contenedor `hepta-respaldo`, `10.10.10.20` en la red de administración (`br10`), con los
  repositorios en el volumen `hepta-respaldo-repos` del pool `ceph-hdd` (3,5 TiB útiles con réplica 3). Regla puntual en
  el MikroTik: `10.10.50.220` → `10.10.10.20`, tcp/8000. Habla TLS con certificado propio; la VM lo tiene fijado.
- **Bases:** `pg_dump -Fc` verificado antes de cada copia; `db/` en crudo no se respalda. Tampoco las vistas previas.
- `ceph-hdd` tiene sus tres discos en `hcsvrnd04` y está en la misma sala: es la copia rápida. Las que cuentan ante
  un desastre son el NAS y Drive, y solo se replican después de una verificación buena.
- A los 30 días de la baja de un cliente se borra su repositorio entero (y sus réplicas).

## Horarios (UTC en los equipos; Paraguay entre paréntesis)

| Hora | Dónde | Qué |
|---|---|---|
| 05:00 (02:00) | VM `hepta-drive` | `hepta-drive-respaldo`: volcado de base y roles, copia con restic |
| 09:00 (06:00) | `hepta-respaldo` | `hepta-respaldo-repos mantener`: depuración 14/8/6 y verificación |
| 10:00 (07:00) | `hcsvrnd01` | `hepta-drive-replicar`: réplica al NAS |
| 11:00 (08:00) | `hcsvrnd01` | `hepta-backup-drive.sh repos`: réplica a Google Drive |
| cada 6 h, :17 | VM `hepta-drive` | `hepta-backup.sh`: configuración y volcados, que el retiro lleva al NAS |

## Restaurar

- **Un archivo o una carpeta:** primero la papelera y las versiones de Nextcloud (90 días). Si no alcanza:
  `hepta-drive-respaldo --copias <cliente>` y `restic restore <copia> --include <ruta> --target <carpeta>` con las
  credenciales de `/etc/hepta-drive-respaldo/<cliente>.env`; después `occ files:scan`.
- **La base:** `dumps/globales.sql` primero (trae el usuario `oc_...` que crea Nextcloud) y después
  `pg_restore` de `dumps/nextcloud.dump`. Es lo que hace `hepta-drive-prueba-restauracion`.
- **Sin el clúster:** el repositorio del NAS o el de Drive (`rclone copy gdrive-crypt:hepta-drive-repos/<cliente>`)
  se abre con restic y la contraseña del repositorio, que está en KeePass.

## Pendiente

- [x] Servidor de respaldos, primera copia y prueba de restauración de `hepta` (2026-11-19).
- [ ] Ver correr solos la copia de las 02:00 y el mantenimiento de las 06:00.
- [ ] Instalar la réplica al NAS y a Drive en `hcsvrnd01` y verla correr.
- [ ] Medir con la carga real del primer cliente (200 GB): primera copia, incremental y réplica.
- [ ] `alta-cliente.sh`, plantilla del vhost y runbook de alta.
