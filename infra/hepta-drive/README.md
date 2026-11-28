# HEPTA Drive (Nextcloud como servicio)

VM `hepta-drive` (10.10.50.220, DMZ). Un Nextcloud por cliente, con OnlyOffice y ClamAV compartidos. Todo el estado de
un cliente vive en `/srv/nextcloud/<cliente>/` (`html/`, `data/`, `db/`), en el volumen de datos `hepta-drive-data`.

> **Estado al 2026-11-21:** respaldo completo y visto correr solo (copia, mantenimiento, réplica al NAS y a Drive).
> Alta de cliente por script (`hepta-drive-alta`) probada en la VM con un cliente de prueba. El alta del respaldo de
> un cliente nuevo la hace sola `hepta-drive-enrolar`, desde `hcsvrnd01`.

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
| `respaldo/hepta-drive-enrolar.sh` | `hcsvrnd01` | Cada 10 min: crea en el servidor de respaldos el repositorio de un cliente nuevo, hace la primera copia y la verifica |
| `alta-cliente.sh` | VM `hepta-drive` (`hepta-drive-alta`) | Alta, verificación, estado y baja de un cliente |
| `agente/` | VM `hepta-drive` (`/opt/hepta-drive/agente`, servicio `hepta-drive-agente`) | Puerta del Admin de HEPTA Cloud: `10.10.50.220:8888`, TLS con certificado propio, clave y filtro de origen. Valida, crea en segundo plano, informa y entrega los secretos. Todo termina en `hepta-drive-alta` |
| `salud/hepta-drive-salud.py` | VM `hepta-drive` (`/usr/local/sbin/hepta-drive-salud`, cron cada 15 min) | Salud de adentro de la VM: ClamAV responde como lo ve Nextcloud, firmas de ≤ 4 días, RAM disponible y disco de datos. Señal a healthchecks.io |
| `marca/logo.png` | `/opt/hepta-drive/plantilla/marca/` | Logo de Hepta Cloud: el que lleva una instancia si el cliente no trae el suyo (`--logo`) |
| `../../tools/drive_vhost_add.sh` | NGINX perimetral | Vhost `<cliente>.drive.hepta.com.py` |
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
- **Baja de un cliente:** el repositorio se **archiva** solo (sin acceso para la VM y sin exigirle copias nuevas) y queda
  entero, igual que su réplica en el NAS y en Drive. Borrarlo es una decisión de una persona, en el servidor de
  respaldos, y recién a los 30 días: `hepta-respaldo-repos borrar <cliente> --confirmar <cliente>`. El mantenimiento
  diario avisa cuando un archivado ya cumplió el plazo; la réplica del día siguiente lo quita del NAS y de Drive.

## Horarios (UTC en los equipos; Paraguay entre paréntesis)

| Hora | Dónde | Qué |
|---|---|---|
| 05:00 (02:00) | VM `hepta-drive` | `hepta-drive-respaldo`: volcado de base y roles, copia con restic |
| 09:00 (06:00) | `hepta-respaldo` | `hepta-respaldo-repos mantener`: depuración 14/8/6 y verificación |
| 10:00 (07:00) | `hcsvrnd01` | `hepta-drive-replicar`: réplica al NAS |
| 11:00 (08:00) | `hcsvrnd01` | `hepta-backup-drive.sh repos`: réplica a Google Drive |
| cada 10 min | `hcsvrnd01` | `hepta-drive-enrolar`: alta del respaldo de los clientes nuevos (no hace nada si no hay) |
| cada 6 h, :17 | VM `hepta-drive` | `hepta-backup.sh`: configuración y volcados, que el retiro lleva al NAS |

## Dominio propio de un cliente

La instancia nace siempre como `<cliente>.drive.hepta.com.py` y esa dirección no se abandona nunca: las aplicaciones de
escritorio y celular quedan atadas a ella. El dominio del cliente se **suma** (Admin → HEPTA Drive → Dominio):

1. El cliente crea un CNAME de su nombre a `<cliente>.drive.hepta.com.py` (sin proxy de por medio).
2. La instancia acepta el nombre nuevo (`hepta-drive-alta dominio-aceptar`).
3. El NGINX saca el certificado por HTTP y crea el vhost (`drive_vhost_add.sh <cliente> --dominio <nombre>`).
4. La instancia deja de tener fija su dirección y usa el dominio propio en los enlaces de los correos
   (`hepta-drive-alta dominio-principal`, que escribe `compose.override.yaml` en la carpeta del cliente).

Para quitarlo: `hepta-drive-alta dominio-quitar <cliente>` en la VM y `drive_vhost_add.sh <cliente> --quitar-dominio <nombre>`
en el NGINX. Un cliente tiene un solo dominio propio.

## Antivirus y salud de la VM

ClamAV es uno solo para todos los clientes (`shared-clamav-1`, `clamav:3310` en la red `hd-shared`). Cada Nextcloud lo
usa en modo daemon, borra lo infectado y **rechaza las subidas si no lo alcanza** ("No connection to anti virus"):
mejor un archivo rechazado que uno sin revisar. Su configuración es `shared/clamd.conf`, montado en solo lectura. El
ajuste del 2026-11-27 (bloques de 100 MB, 12 análisis a la vez, cola de 200) salió de la primera sincronización
masiva, que lo saturaba con 4 vCPU; la VM pasó a 8 vCPU y 12 GiB.

```bash
# en la VM, después de un cambio de shared/clamd.conf
cd /opt/hepta-drive/shared && docker compose up -d clamav
docker exec shared-clamav-1 grep -E '^(StreamMaxLength|MaxThreads|MaxQueue|ReadTimeout)' /etc/clamav/clamd.conf
```

`hepta-drive-salud` revisa cada 15 minutos lo que el vigía de `hcsvrnd01` no ve desde afuera: que ClamAV responda
(desde un contenedor de cliente, como Nextcloud), que las firmas tengan como mucho 4 días (ClamAV a veces pasa 2 o 3 días sin publicar), que queden 4 GiB de RAM y
que el volumen de datos no pase del 85 %. Manda una señal a healthchecks.io, "bien" o "falla" con el detalle; si la
señal deja de llegar, healthchecks.io avisa igual. En healthchecks.io: un chequeo aparte con período 15 minutos y
gracia 30, con aviso al mismo correo de afuera que el del vigía.

```bash
install -m 755 hepta-drive-salud.py /usr/local/sbin/hepta-drive-salud
hepta-drive-salud --estado        # cómo está cada cosa, sin mandar señal
hepta-drive-salud --configurar    # pide la dirección de la señal sin mostrarla y la guarda en /etc/hepta-drive-salud.conf (600)
echo '*/15 * * * * root /usr/local/sbin/hepta-drive-salud >> /var/log/hepta-drive-salud.log 2>&1' > /etc/cron.d/hepta-drive-salud
```

Los umbrales se cambian en el mismo `.conf` (`FIRMAS_MAX_DIAS`, `RAM_MIN_GIB`, `DISCO_MAX_PCT`).

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
- [x] Copia, mantenimiento y réplicas vistos correr solos (2026-11-20).
- [x] `alta-cliente.sh` y vhost, probados con un cliente de prueba (2026-11-20).
- [ ] `hepta-drive-enrolar`: instalar en `hcsvrnd01` y verlo dar de alta solo a un cliente de prueba.
- [ ] Agente de alta: instalar y probar un alta completa disparada por la API.
- [ ] Probar la baja. Runbook de alta.
- [ ] Medir con la carga real del primer cliente (200 GB): primera copia, incremental y réplica.
