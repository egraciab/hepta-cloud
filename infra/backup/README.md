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
