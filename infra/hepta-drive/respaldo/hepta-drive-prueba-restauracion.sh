#!/usr/bin/env bash
# hepta-drive-prueba-restauracion.sh — corre en la VM hepta-drive. Prueba que el respaldo de un cliente se puede
# recuperar. No toca la instancia en producción: restaura en una carpeta aparte y en un Postgres temporal sin red.
#
#   hepta-drive-prueba-restauracion.sh <cliente> [copia]      copia: id de restic; por defecto, la última
#
# Qué hace:
#   1. Baja la copia del servidor de respaldos a /srv/nextcloud/_prueba-restauracion/<cliente>/.
#   2. Compara los archivos restaurados con los de producción (contenido, no solo nombres). Lo que cambió desde
#      la copia aparece como diferencia: es esperable en una instancia en uso, y el informe lo lista.
#   3. Restaura el volcado de la base en un Postgres temporal (misma imagen, sin red), cuenta tablas, usuarios y
#      archivos contra producción, y vuelve a volcar la copia restaurada (si eso falla, el respaldo no sirve).
#   4. Borra lo temporal y deja el informe en /var/lib/hepta-drive-respaldo/<cliente>.prueba-restauracion.txt
#
# Termina con error si la copia no baja, falta algún archivo que producción tiene sin cambios, el volcado no
# restaura o la base restaurada no se puede volver a volcar.
set -uo pipefail

CONF_DIR="${HD_CONF_DIR:-/etc/hepta-drive-respaldo}"
DATOS="${HD_DATOS:-/srv/nextcloud}"
ESTADO="${HD_ESTADO:-/var/lib/hepta-drive-respaldo}"
DOCKER="${HD_DOCKER:-docker}"
IMAGEN_PG="${HD_IMAGEN_PG:-postgres:16}"
C="${1:-}"; COPIA="${2:-latest}"
[[ "$C" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
[ -r "$CONF_DIR/$C.env" ] && [ -r "$CONF_DIR/servidor.conf" ] || { echo "ERROR: '$C' no está dado de alta en el respaldo" >&2; exit 2; }
SERVIDOR=""; CACERT=""
# shellcheck disable=SC1091
. "$CONF_DIR/servidor.conf"

BASE="$DATOS/_prueba-restauracion"; DEST="$BASE/$C"; PG="hd-prueba-$C"
INFORME="$ESTADO/$C.prueba-restauracion.txt"
ERRORES=0; T0=$(date +%s)
linea() { echo "$*" | tee -a "$INFORME"; }
falla() { ERRORES=$((ERRORES + 1)); linea "ERROR: $*"; }

restic_de() {
  ( REST_CLAVE=""; RESTIC_PASSWORD=""
    # shellcheck disable=SC1090
    . "$CONF_DIR/$C.env"
    export RESTIC_PASSWORD RESTIC_REST_USERNAME="$C" RESTIC_REST_PASSWORD="$REST_CLAVE"
    export RESTIC_REPOSITORY="rest:$SERVIDOR/$C/" RESTIC_CACHE_DIR="${HD_CACHE:-/var/cache/hepta-drive-respaldo}"
    restic --cacert "$CACERT" "$@" )
}
limpiar() {
  $DOCKER rm -f "$PG" >/dev/null 2>&1
  # Solo se borra la carpeta de pruebas de este cliente, nunca otra cosa
  case "$DEST" in "$DATOS"/_prueba-restauracion/?*) [ -d "$DEST" ] && rm -rf -- "${DEST:?}" ;; esac
}
trap limpiar EXIT

install -d -m 700 "$ESTADO" "$BASE"; limpiar; install -d -m 700 "$DEST"
: > "$INFORME"
linea "Prueba de restauración de '$C' · $(date '+%F %T %Z') · copia: $COPIA"
linea "Espacio libre en $DATOS: $(df -h --output=avail "$DATOS" | tail -1 | tr -d ' ')"

# ── 1. Bajar la copia ──
linea ""; linea "1. Bajando la copia del servidor de respaldos…"
if restic_de restore "$COPIA" --target "$DEST/archivos" >"$DEST/restore.log" 2>&1; then
  linea "   OK en $(( $(date +%s) - T0 )) s: $(du -sh "$DEST/archivos" | cut -f1), $(find "$DEST/archivos" -type f | wc -l) archivos"
else
  falla "no se pudo bajar la copia: $(tail -c 300 "$DEST/restore.log" | tr '\n' ' ')"
  linea ""; linea "RESULTADO: FALLÓ (sin copia no hay nada más que probar)"; exit 1
fi
REST="$DEST/archivos$DATOS/$C"
[ -d "$REST/data" ] || falla "la copia no trae la carpeta data/"
[ -s "$REST/html/config/config.php" ] || falla "la copia no trae html/config/config.php"

# ── 2. Comparar con producción (por contenido) ──
linea ""; linea "2. Comparando con producción…"
DIF="$DEST/diferencias.txt"
rsync -rcn --delete --out-format='%i %n' \
  --exclude '/db' --exclude '/dumps' --exclude '/data/appdata_*/preview' --exclude '*.parcial' --exclude '*.part' \
  "$DATOS/$C/" "$REST/" > "$DIF" 2>"$DEST/rsync.err" || falla "la comparación no pudo completarse: $(head -c 200 "$DEST/rsync.err")"
# En la salida de rsync: ">f+++" = está en producción y no en la copia · ">f" con cambios = distinto · "*deleting" = solo en la copia
FALTAN=$(grep -c '^>f+++' "$DIF"); DISTINTOS=$(grep '^>f' "$DIF" | grep -vc '^>f+++'); SOBRAN=$(grep -c '^\*deleting' "$DIF")
linea "   Solo en producción (nuevos desde la copia): $FALTAN · distintos (cambiaron desde la copia): $DISTINTOS · solo en la copia (borrados después): $SOBRAN"
if [ $((FALTAN + DISTINTOS + SOBRAN)) -gt 0 ]; then
  linea "   Primeras diferencias:"; head -15 "$DIF" | sed 's/^/     /' | tee -a "$INFORME"
fi
# Lo que NO puede faltar: archivos de usuarios que no cambiaron después de la copia
HORA_COPIA="$(restic_de snapshots "$COPIA" --json 2>/dev/null | grep -o '"time":"[^"]*"' | tail -1 | cut -d'"' -f4)"
if [ -n "$HORA_COPIA" ]; then
  VIEJOS=0
  while read -r _ ruta; do
    case "$ruta" in data/*/files/*)
      [ "$(stat -c %Y "$DATOS/$C/$ruta" 2>/dev/null || echo 9999999999)" -lt "$(date -d "$HORA_COPIA" +%s)" ] && { VIEJOS=$((VIEJOS + 1)); linea "   FALTA EN LA COPIA: $ruta"; } ;;
    esac
  done < <(grep '^>f' "$DIF")
  [ "$VIEJOS" -eq 0 ] && linea "   OK: todos los archivos de usuarios anteriores a la copia ($HORA_COPIA) están y coinciden." \
                      || falla "$VIEJOS archivo/s de usuarios anteriores a la copia faltan o difieren"
else
  falla "no pude leer la fecha de la copia"
fi

# ── 3. Base de datos en un Postgres temporal sin red ──
linea ""; linea "3. Restaurando la base en un Postgres temporal…"
DUMP="$REST/dumps/nextcloud.dump"
if [ ! -s "$DUMP" ]; then
  falla "la copia no trae el volcado de la base (dumps/nextcloud.dump)"
else
  CLAVE="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  install -d -m 700 "$DEST/pg"
  if ! $DOCKER run -d --name "$PG" --network none -e POSTGRES_USER=nextcloud -e POSTGRES_DB=nextcloud \
        -e POSTGRES_PASSWORD="$CLAVE" -v "$DEST/pg:/var/lib/postgresql/data" "$IMAGEN_PG" >/dev/null 2>"$DEST/pg.err"; then
    falla "no arrancó el Postgres temporal: $(head -c 200 "$DEST/pg.err")"
  else
    for _ in $(seq 1 60); do $DOCKER exec "$PG" pg_isready -U nextcloud -d nextcloud >/dev/null 2>&1 && break; sleep 1; done
    sleep 2   # la imagen reinicia Postgres una vez al terminar de inicializar
    for _ in $(seq 1 30); do $DOCKER exec "$PG" psql -U nextcloud -d nextcloud -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
    # Primero los roles (el usuario oc_... que crea Nextcloud). "ya existe" para el rol nextcloud es esperable.
    OPC_RESTORE=(--exit-on-error)
    if [ -s "$REST/dumps/globales.sql" ]; then
      $DOCKER exec -i "$PG" psql -U nextcloud -d postgres -q < "$REST/dumps/globales.sql" >"$DEST/globales.log" 2>&1
      ROLES="$($DOCKER exec "$PG" psql -U nextcloud -d postgres -Atc "select string_agg(rolname, ', ' order by rolname) from pg_roles where rolname !~ '^pg_'" 2>/dev/null)"
      linea "   roles restaurados: $ROLES"
    else
      linea "   AVISO: esta copia no trae los roles (globales.sql); se restaura sin dueños ni permisos."
      OPC_RESTORE+=(--no-owner --no-acl)
    fi
    if $DOCKER exec -i "$PG" pg_restore -U nextcloud -d nextcloud "${OPC_RESTORE[@]}" < "$DUMP" >"$DEST/pg_restore.log" 2>&1; then
      contar() { $DOCKER exec "$1" psql -U nextcloud -d nextcloud -Atc "$2" 2>/dev/null | tr -d ' \r'; }
      for q in "tablas|select count(*) from information_schema.tables where table_schema='public'" \
               "usuarios|select count(*) from oc_users" "archivos en el índice|select count(*) from oc_filecache"; do
        linea "   ${q%%|*}: restaurada $(contar "$PG" "${q#*|}") · producción $(contar "$C-db-1" "${q#*|}")"
      done
      [ "$(contar "$PG" "select count(*) from oc_filecache")" -gt 0 ] 2>/dev/null || falla "la base restaurada no tiene archivos en el índice"
      # El usuario con el que Nextcloud entra a la base (config.php) tiene que existir en la base restaurada
      DBUSER="$(grep -o "'dbuser' *=> *'[^']*'" "$REST/html/config/config.php" 2>/dev/null | cut -d"'" -f4)"
      if [ -n "$DBUSER" ]; then
        if [ "$(contar "$PG" "select count(*) from pg_roles where rolname='$DBUSER'")" = 1 ]; then linea "   OK: existe el usuario de base que usa Nextcloud ($DBUSER)."
        else falla "falta el usuario de base que usa Nextcloud ($DBUSER)"; fi
      fi
      BYTES="$($DOCKER exec "$PG" pg_dump -U nextcloud -Fc nextcloud 2>"$DEST/pg_dump.err" | wc -c)"
      if [ "${BYTES:-0}" -gt 1000 ] && [ ! -s "$DEST/pg_dump.err" ]; then
        linea "   OK: la base restaurada se pudo volver a volcar ($(numfmt --to=iec "$BYTES"); el original pesa $(numfmt --to=iec "$(stat -c %s "$DUMP")"))."
      else
        falla "la base restaurada NO se pudo volver a volcar: $(head -c 200 "$DEST/pg_dump.err")"
      fi
    else
      falla "pg_restore falló: $(tail -c 300 "$DEST/pg_restore.log" | tr '\n' ' ')"
    fi
  fi
fi

linea ""
if [ "$ERRORES" -eq 0 ]; then
  linea "RESULTADO: OK en $(( $(date +%s) - T0 )) s. La copia $COPIA de '$C' se puede recuperar."
  date -Is > "$ESTADO/$C.prueba-restauracion-ok"
else
  linea "RESULTADO: FALLÓ con $ERRORES error/es."
fi
[ "$ERRORES" -eq 0 ]
