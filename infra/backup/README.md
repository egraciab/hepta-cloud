# Respaldos por VM (`hepta-backup.sh`)

Un mismo script para todas las VM; lo que cambia es `/etc/hepta-backup.conf`.

- **Qué guarda:** un dump por base de Postgres (`pg_dump -Fc`) más roles globales, un espejo de las carpetas de
  datos (filestore, uploads) y un `.tar.gz` con la configuración de la VM.
- **Dónde:** `/var/backups/hepta/` dentro de la VM (solo root). El histórico largo y la copia fuera de la VM los
  hace el servidor de respaldos, que retira los archivos; la VM nunca escribe en el NAS.
- **Regla:** un dump vacío o ilegible es un respaldo fallido. El script sale con error, renombra la corrida a
  `*.FALLIDA` y no toca `ultimo-ok`. El control de vida mira `ultimo-ok` y `estado.json`.

## Instalar en una VM

```bash
apt-get install -y rsync
install -m 755 infra/backup/hepta-backup.sh /usr/local/sbin/hepta-backup.sh
install -m 600 infra/backup/conf/<VM>.conf /etc/hepta-backup.conf   # una configuración por VM en conf/
hepta-backup.sh --solo-ver     # muestra qué respaldaría, sin escribir
hepta-backup.sh; echo "salida=$?"; cat /var/backups/hepta/estado.json
```

Cada 6 horas, una vez probado a mano:

```bash
echo '17 */6 * * * root /usr/local/sbin/hepta-backup.sh >> /var/log/hepta-backup.log 2>&1' > /etc/cron.d/hepta-backup
```

## Restaurar una base

```bash
pg_restore -l /var/backups/hepta/dumps/<corrida>/<base>.dump | head      # ver que se lee
createdb <base>_restaurada && pg_restore -d <base>_restaurada --no-owner /var/backups/hepta/dumps/<corrida>/<base>.dump
```

Después de restaurar, correr `pg_dump` sobre la base restaurada: si falla, el respaldo no sirve (caso pgvector del ERP).

## Copia al NAS (`hepta-backup-retirar.sh`, en `hcsvrnd01`)

Las VM no escriben en el NAS: el nodo que lo tiene montado entra a cada VM con `lxc exec`, retira las corridas
nuevas, verifica cada archivo con sha256 y arma el histórico (todo lo de 2 días, uno por día hasta 14 días, uno por
semana hasta 8 semanas; carpetas de datos: un paquete por día, 7 días). Si una VM no tiene un respaldo bueno en las
últimas 7 horas, no responde, o una copia no coincide, termina con error y deja el motivo en
`/mnt/nas/hepta-backups/ALERTA.txt`. Si todo está bien actualiza `ultimo-retiro-ok`. Sin el NAS montado no escribe nada.

```bash
install -m 755 hepta-backup-retirar.sh /usr/local/sbin/hepta-backup-retirar.sh
hepta-backup-retirar.sh                      # primera pasada a mano
echo '47 */3 * * * root /usr/local/sbin/hepta-backup-retirar.sh >> /var/log/hepta-backup-retirar.log 2>&1' > /etc/cron.d/hepta-backup-retirar
```

En el NAS los archivos quedan sin cifrar, igual que los exports de VM que ya están ahí. La copia fuera de sitio
(Drive) va cifrada con rclone crypt.

## Export semanal de las VM completas (`export-vms.sh`, en `hcsvrnd01`)

Recupera lo que no es dato: sistema, imágenes de Docker, módulos Enterprise. Con `--semanal` marca el lote como
completo, deja los últimos 4 lotes completos (los hechos a mano no se borran solos) y anota el resultado en
`/mnt/nas/lxd-exports/ultimo-lote-ok` o `ultimo-lote-fallo`; `hepta-backup-retirar.sh` avisa si el último lote falló o
tiene más de 8 días. Un lote semanal que falla queda en el NAS sin la marca: hay que borrarlo a mano.

```bash
install -m 755 export-vms.sh /root/bin/export-vms.sh
echo '0 5 * * 0 root /root/bin/export-vms.sh --semanal >> /var/log/export-vms.log 2>&1' > /etc/cron.d/export-vms   # domingo 02:00 de Paraguay (el nodo está en UTC)
```
