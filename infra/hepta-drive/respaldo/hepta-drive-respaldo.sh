#!/usr/bin/env bash
# hepta-drive-respaldo.sh — corre en la VM hepta-drive. Respaldo de los archivos de cada cliente de Nextcloud.
#
# Por cada cliente de /opt/hepta-drive/clientes/:
#   1. Vuelca su base (pg_dump -Fc desde <cliente>-db-1) a /srv/nextcloud/<cliente>/dumps/ y verifica que se lea.
#   2. Manda /srv/nextcloud/<cliente>/ con restic a SU repositorio en el servidor de respaldos (rest-server).
#      Viaja solo lo que cambió, cifrado con la contraseña del repositorio. No va: db/ (Postgres en vivo; para eso
#      está el volcado), las vistas previas (se regeneran) ni archivos a medio escribir.
#
# El servidor acepta agregar y nada más: desde esta VM no se puede borrar ni pisar un respaldo ya hecho.
# La depuración del histórico (14 diarios, 8 semanales, 6 mensuales) y la verificación corren del lado del servidor.
#
# Regla de la casa: un volcado vacío o ilegible, o un restic que termina con error, es un respaldo FALLIDO.
# El script sale con error y no toca "ultimo-ok" de ese cliente.
#
# Uso:  hepta-drive-respaldo.sh                 todos los clientes dados de alta en el respaldo
#       hepta-drive-respaldo.sh <cliente>       uno solo
#       hepta-drive-respaldo.sh --solo-ver      qué respaldaría, sin escribir
#       hepta-drive-respaldo --alta <cliente>      pide las dos contraseñas (no se muestran) y guarda el acceso
#       hepta-drive-respaldo.sh --copias <cliente>    lista las copias que hay en el servidor
# Config: /etc/hepta-drive-respaldo/servidor.conf  (SERVIDOR=https://<ip>:8000 · CACERT=<certificado del servidor>)
#         /etc/hepta-drive-respaldo/<cliente>.env  (600: REST_CLAVE y RESTIC_PASSWORD; las dos nacen en KeePass)
set -uo pipefail

CONF_DIR="${HD_CONF_DIR:-/etc/hepta-drive-respaldo}"
CLIENTES_DIR="${HD_CLIENTES_DIR:-/opt/hepta-drive/clientes}"
DATOS="${HD_DATOS:-/srv/nextcloud}"
ESTADO="${HD_ESTADO:-/var/lib/hepta-drive-respaldo}"
DOCKER="${HD_DOCKER:-docker}"
PG_USUARIO=nextcloud; PG_BASE=nextcloud

[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
aviso() { echo "[$(date '+%F %H:%M:%S')] $*"; }
nombre_ok() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]]; }

cargar_servidor() {
  [ -r "$CONF_DIR/servidor.conf" ] || { echo "ERROR: falta $CONF_DIR/servidor.conf" >&2; exit 2; }
  SERVIDOR=""; CACERT=""
  # shellcheck disable=SC1091
  . "$CONF_DIR/servidor.conf"
  [[ "$SERVIDOR" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "ERROR: SERVIDOR tiene que ser https://<host>:<puerto>" >&2; exit 2; }
  [ -r "$CACERT" ] || { echo "ERROR: no se puede leer el certificado del servidor ($CACERT)" >&2; exit 2; }
}

# restic contra el repositorio de un cliente. Las credenciales van por variables, no por la línea de comandos.
restic_de() {   # restic_de <cliente> <args...>
  local c="$1"; shift
  ( REST_CLAVE=""; RESTIC_PASSWORD=""
    # shellcheck disable=SC1090
    . "$CONF_DIR/$c.env"
    export RESTIC_PASSWORD RESTIC_REST_USERNAME="$c" RESTIC_REST_PASSWORD="$REST_CLAVE"
    export RESTIC_REPOSITORY="rest:$SERVIDOR/$c/" RESTIC_CACHE_DIR="${HD_CACHE:-/var/cache/hepta-drive-respaldo}"
    restic --cacert "$CACERT" "$@" )
}

clientes() {   # clientes con|sin  → los que tienen (o no) el respaldo dado de alta
  local d c
  for d in "$CLIENTES_DIR"/*/; do
    [ -d "$d" ] || continue
    c="$(basename "$d")"
    if [ -r "$CONF_DIR/$c.env" ]; then [ "$1" = con ] && echo "$c"; else [ "$1" = sin ] && echo "$c"; fi
  done
  return 0
}

case "${1:-}" in
  --alta)
    c="${2:-}"; nombre_ok "$c" || { echo "Uso: $0 --alta <cliente>" >&2; exit 2; }
    [ -d "$CLIENTES_DIR/$c" ] || { echo "ERROR: no existe $CLIENTES_DIR/$c" >&2; exit 2; }
    cargar_servidor
    echo "Respaldo de '$c'. Pegá desde KeePass (no se muestra lo que escribís):"
    read -rsp "  1) Clave de acceso al servidor de respaldos (usuario $c): " k1; echo
    read -rsp "  2) Contraseña del repositorio de $c: " k2; echo
    [ -n "$k1" ] && [ -n "$k2" ] || { echo "ERROR: las dos son obligatorias" >&2; exit 2; }
    case "$k1$k2" in *"'"*) echo "ERROR: generalas sin comilla simple (')" >&2; exit 2;; esac
    install -d -m 700 "$CONF_DIR"
    ACCESO="${CONF_DIR:?}/${c:?}.env"
    ( umask 077; printf "REST_CLAVE='%s'\nRESTIC_PASSWORD='%s'\n" "$k1" "$k2" > "$ACCESO" )
    unset k1 k2
    if ERR="$(restic_de "$c" cat config 2>&1 >/dev/null)"; then
      echo "OK: el repositorio de $c responde con esas credenciales."
    else
      echo "ERROR: no pude abrir el repositorio de $c:"; echo "${ERR:0:400}"
      : > "$ACCESO"; unlink "$ACCESO"
      echo "No guardé nada. ¿Está dado de alta en el servidor (hepta-respaldo-repos alta $c) y son las mismas claves?"; exit 1
    fi
    exit 0 ;;
  --copias)
    c="${2:-}"; nombre_ok "$c" || { echo "Uso: $0 --copias <cliente>" >&2; exit 2; }
    cargar_servidor; restic_de "$c" snapshots --compact; exit $? ;;
esac

SOLO_VER=0; SOLO=""
case "${1:-}" in --solo-ver) SOLO_VER=1;; "") ;; -*) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 2;; *) SOLO="$1";; esac
cargar_servidor
command -v restic >/dev/null || { echo "ERROR: falta restic (apt install restic)" >&2; exit 2; }

if [ "$SOLO_VER" = 1 ]; then
  echo "Servidor de respaldos: $SERVIDOR"
  for c in $(clientes con); do
    echo "  - $c: $(du -sh --exclude=db "$DATOS/$c" 2>/dev/null | cut -f1) sin la base en vivo · último bueno: $(cat "$ESTADO/$c.ultimo-ok" 2>/dev/null || echo nunca)"
  done
  for c in $(clientes sin); do echo "  - $c: ¡SIN RESPALDO! Falta: hepta-drive-respaldo --alta $c"; done
  exit 0
fi

install -d -m 700 "$ESTADO"
exec 9>"$ESTADO/.candado"; flock -n 9 || { echo "Ya hay un respaldo corriendo; salgo." >&2; exit 0; }

FALLARON=0
campo() { grep -o "\"$2\":[0-9]*" <<<"$1" | head -1 | cut -d: -f2; }   # número de un campo del resumen de restic

respaldar() {
  local c="$1" errores=() inicio fin raiz dump t0 salida resumen sal cod archivos total nuevos copia
  inicio="$(date -Is)"; t0=$(date +%s); raiz="$DATOS/$c"
  aviso "── $c"
  [ -d "$raiz/data" ] || errores+=("no existe $raiz/data")

  # 1. Volcado de la base
  install -d -m 700 "$raiz/dumps"; dump="$raiz/dumps/$PG_BASE.dump"
  if ! $DOCKER exec "$c-db-1" pg_dump -U "$PG_USUARIO" -Fc "$PG_BASE" > "$dump.parcial" 2>"$dump.err"; then
    errores+=("pg_dump falló: $(head -c 200 "$dump.err" | tr '\n' ' ')")
  elif [ ! -s "$dump.parcial" ]; then
    errores+=("el volcado de la base salió vacío")
  elif ! $DOCKER exec -i "$c-db-1" pg_restore -l < "$dump.parcial" >/dev/null 2>"$dump.err"; then
    errores+=("el volcado de la base no se puede leer: $(head -c 200 "$dump.err" | tr '\n' ' ')")
  else
    mv "$dump.parcial" "$dump"; aviso "   base: $(du -h "$dump" | cut -f1), verificada"
  fi
  : > "$dump.err"; unlink "$dump.err"; [ -e "$dump.parcial" ] && unlink "$dump.parcial"

  # 2. Archivos, configuración y volcado al repositorio del cliente.
  #    Se manda aunque el volcado haya fallado: los archivos de hoy valen más que nada.
  salida="$ESTADO/$c.salida"
  restic_de "$c" backup "$raiz" --host hepta-drive --tag diario --one-file-system \
      --exclude "$raiz/db" --exclude "$raiz/data/appdata_*/preview" --exclude '*.parcial' --exclude '*.part' \
      --json --quiet > "$salida" 2>"$salida.err"
  cod=$?
  case $cod in
    0) ;;
    3) errores+=("restic no pudo leer algunos archivos: $(grep -m1 -o '"message":"[^"]*"' "$salida.err" "$salida" | cut -c1-200)") ;;
    *) errores+=("restic terminó con error $cod: $(tail -c 300 "$salida.err" | tr '\n' ' ')") ;;
  esac
  resumen="$(grep '"message_type":"summary"' "$salida" | tail -1)"
  archivos="$(campo "$resumen" total_files_processed)"; total="$(campo "$resumen" total_bytes_processed)"
  nuevos="$(campo "$resumen" data_added)"; copia="$(grep -o '"snapshot_id":"[0-9a-f]*"' <<<"$resumen" | cut -d'"' -f4 | cut -c1-8)"
  fin="$(date -Is)"; sal=true; [ "${#errores[@]}" -eq 0 ] || sal=false
  {
    printf '{"cliente":"%s","inicio":"%s","fin":"%s","segundos":%s,"ok":%s,' "$c" "$inicio" "$fin" "$(( $(date +%s) - t0 ))" "$sal"
    printf '"archivos":%s,"bytes_total":%s,"bytes_nuevos":%s,"copia":"%s","errores":[' "${archivos:-0}" "${total:-0}" "${nuevos:-0}" "$copia"
    local sep="" e; for e in "${errores[@]:-}"; do [ -n "$e" ] && { printf '%s"%s"' "$sep" "$(echo "$e" | tr -d '\n"\\' | cut -c1-300)"; sep=","; }; done
    printf ']}\n'
  } > "$ESTADO/$c.json"
  cat "$ESTADO/$c.json" >> "$ESTADO/$c.historial.jsonl"
  : > "$salida"; unlink "$salida"; unlink "$salida.err"
  if [ "$sal" = false ]; then
    FALLARON=$((FALLARON + 1)); for e in "${errores[@]}"; do aviso "   ERROR: $e"; done
    aviso "   RESPALDO FALLIDO de $c. No se actualiza ultimo-ok."
  else
    echo "$fin" > "$ESTADO/$c.ultimo-ok"
    aviso "   OK en $(( $(date +%s) - t0 )) s: copia $copia, $(numfmt --to=iec "${nuevos:-0}") nuevos de $(numfmt --to=iec "${total:-0}") ($archivos archivos)"
  fi
}

LISTA="$(clientes con)"
if [ -n "$SOLO" ]; then
  grep -qx "$SOLO" <<<"$LISTA" || { echo "ERROR: '$SOLO' no está dado de alta en el respaldo (hepta-drive-respaldo --alta $SOLO)" >&2; exit 2; }
  LISTA="$SOLO"
fi
for c in $LISTA; do respaldar "$c"; done
# Un cliente con Nextcloud y sin respaldo es una falla, no un detalle
if [ -z "$SOLO" ]; then
  clientes sin > "$ESTADO/sin-respaldo.txt"
  for c in $(clientes sin); do FALLARON=$((FALLARON + 1)); aviso "ERROR: el cliente $c no tiene respaldo configurado (hepta-drive-respaldo --alta $c)"; done
fi
[ "$FALLARON" -eq 0 ] || { aviso "Terminó CON $FALLARON falla/s."; exit 1; }
[ -n "$SOLO" ] || date -Is > "$ESTADO/ultimo-ok"
aviso "Respaldo OK."
