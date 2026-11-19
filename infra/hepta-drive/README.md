# HEPTA Drive (Nextcloud como servicio)

VM `hepta-drive` (10.10.50.220, DMZ). Un Nextcloud por cliente, con OnlyOffice y ClamAV compartidos. Todo el estado de
un cliente vive en `/srv/nextcloud/<cliente>/` (`html/`, `data/`, `db/`), en el volumen de datos `hepta-drive-data`.

> **Estado al 2026-11-19:** los `compose.yaml` están versionados tal como corren en la VM. El respaldo está escrito y
> probado en un entorno local (alta, copia, intento de borrado rechazado, depuración, restauración y comparación),
> **todavía no instalado**: falta crear el servidor de respaldos. No dar el respaldo por hecho hasta verlo correr solo.

## Qué hay acá

| Carpeta | Va a | Qué es |
|---|---|---|
| `shared/` | `/opt/hepta-drive/shared/` | OnlyOffice y ClamAV. Red Docker externa `hd-shared` |
| `cliente/` | `/opt/hepta-drive/clientes/<cliente>/` | Plantilla de un cliente: `db`, `redis`, `app`, `cron` |
| `respaldo/hepta-drive-respaldo.sh` | VM `hepta-drive` | Volcado de la base y copia con restic, por cliente |
| `respaldo/hepta-respaldo-repos.sh` | servidor de respaldos | Alta de repositorios, depuración, verificación y estado |
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
- **El servidor va en la red interna**, no en la DMZ, con una regla puntual `10.10.50.220` → servidor, puerto 8000.
- **Bases:** `pg_dump -Fc` verificado antes de cada copia; `db/` en crudo no se respalda. Tampoco las vistas previas.
- `ceph-hdd` tiene sus tres discos en `hcsvrnd04` y está en la misma sala: es la copia rápida. Las que cuentan ante
  un desastre son el NAS y Drive, y solo se replican después de una verificación buena.
- A los 30 días de la baja de un cliente se borra su repositorio entero (y sus réplicas).

## Pendiente

- [ ] Servidor de respaldos: contenedor, volumen en `ceph-hdd`, `rest-server` con TLS, regla de firewall.
- [ ] Instalar en la VM, primera corrida medida, cron, y **prueba de restauración** de la instancia `hepta`.
- [ ] Réplica al NAS y a Drive desde `hcsvrnd01`; sumar la VM al retiro, al export semanal y al vigía.
- [ ] `alta-cliente.sh`, plantilla del vhost y runbook de alta.
