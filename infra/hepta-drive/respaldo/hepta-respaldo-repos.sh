#!/usr/bin/env bash
# hepta-respaldo-repos.sh — corre en el servidor de respaldos de HEPTA Drive (contenedor hepta-respaldo).
# Se instala como /usr/local/sbin/hepta-respaldo-repos.
#
# Los repositorios de restic viven en $RAIZ/<cliente>/ (volumen del pool ceph-hdd). rest-server los publica en modo
# "solo agregar" y con un usuario por cliente: la VM hepta-drive puede sumar copias a SU repositorio y nada más.
# Lo que la VM no puede hacer se hace acá, sobre los archivos y sin pasar por rest-server:
#
#   hepta-respaldo-repos alta <cliente>      crea el usuario y el repositorio (pide las dos contraseñas, no las muestra)
#   hepta-respaldo-repos mantener [cliente]  depura el histórico (14 diarios, 8 semanales, 6 mensuales), verifica el
#                                            repositorio y anota el estado. Sin cliente: todos. Va por cron, una vez al día.
#   hepta-respaldo-repos estado              cómo está cada repositorio
#   hepta-respaldo-repos copias <cliente>    lista las copias de un cliente
#
# Las contraseñas nacen en KeePass. La de acceso queda como hash en el htpasswd; la del repositorio, en
# $CONF/claves/<cliente> (600, root): hace falta para depurar y verificar.
# Dar de baja un cliente no tiene comando a propósito: se borra a mano, 30 días después de la baja (ver el runbook).
set -uo pipefail

CONF="${HR_CONF:-/etc/hepta-respaldo}"
RAIZ="${HR_RAIZ:-/srv/restic}"
USUARIO="${HR_USUARIO:-restic}"          # dueño de los repositorios; el mismo con el que corre rest-server
DIARIOS="${HR_DIARIOS:-14}"; SEMANALES="${HR_SEMANALES:-8}"; MENSUALES="${HR_MENSUALES:-6}"
MAX_HORAS="${HR_MAX_HORAS:-30}"          # una copia más vieja que esto es una falla
ESTADO="$RAIZ/_estado"

[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
for h in restic htpasswd flock; do
  command -v "$h" >/dev/null || { echo "ERROR: falta el programa '$h' (apt install restic apache2-utils util-linux)" >&2; exit 2; }
done
aviso() { echo "[$(date '+%F %H:%M:%S')] $*"; }
nombre_ok() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]]; }
como_dueno() { if [ "$(id -un)" = "$USUARIO" ]; then "$@"; else runuser -u "$USUARIO" -- "$@"; fi; }

# restic directo sobre la carpeta del repositorio, como el dueño de los archivos
restic_de() {   # restic_de <cliente> <args...>
  local c="$1"; shift
  RESTIC_PASSWORD="$(cat "$CONF/claves/$c")" RESTIC_REPOSITORY="$RAIZ/$c" RESTIC_CACHE_DIR="$RAIZ/_cache" \
    como_dueno restic "$@"
}
repos() { local f; for f in "$CONF"/claves/*; do [ -f "$f" ] && basename "$f"; done; return 0; }

alta() {
  local c="$1" k1 k2
  nombre_ok "$c" || { echo "ERROR: nombre de cliente inválido (minúsculas, números y guiones)" >&2; exit 2; }
  [ -e "$RAIZ/$c" ] && { echo "ERROR: ya existe $RAIZ/$c" >&2; exit 2; }
  echo "Alta del repositorio de '$c'. Generá las dos en KeePass y pegalas (no se muestra lo que escribís):"
  read -rsp "  1) Clave de acceso al servidor de respaldos (usuario $c): " k1; echo
  read -rsp "  2) Contraseña del repositorio de $c: " k2; echo
  [ "${#k1}" -ge 20 ] && [ "${#k2}" -ge 20 ] || { echo "ERROR: las dos tienen que tener 20 caracteres o más" >&2; exit 2; }
  [ "$k1" != "$k2" ] || { echo "ERROR: tienen que ser dos contraseñas distintas" >&2; exit 2; }
  case "$k1$k2" in *"'"*) echo "ERROR: generalas sin comilla simple (')" >&2; exit 2;; esac
  install -d -m 700 "$CONF/claves"
  touch "$CONF/htpasswd"; chown "root:$USUARIO" "$CONF/htpasswd"; chmod 640 "$CONF/htpasswd"
  printf '%s\n' "$k1" | htpasswd -B -i "$CONF/htpasswd" "$c" >/dev/null || { echo "ERROR: no pude crear el usuario" >&2; exit 1; }
  ( umask 077; printf '%s\n' "$k2" > "$CONF/claves/$c" )
  unset k1 k2
  install -d -m 700 -o "$USUARIO" -g "$USUARIO" "$RAIZ/$c" "$RAIZ/_cache"
  if restic_de "$c" init >/dev/null; then
    aviso "Repositorio de $c creado en $RAIZ/$c. Usuario de acceso: $c."
    echo "Falta, en la VM hepta-drive: hepta-drive-respaldo.sh --alta $c   (con las mismas dos contraseñas)"
  else
    echo "ERROR: restic init falló; revisá permisos de $RAIZ" >&2; exit 1
  fi
}

mantener_uno() {
  local c="$1" errores=() t0 ultima copias edad bytes sal
  t0=$(date +%s); aviso "── $c"
  # Un candado viejo (una copia que se cortó) frena la depuración: restic unlock solo quita los que ya no tienen dueño
  restic_de "$c" unlock >/dev/null 2>&1
  if ! restic_de "$c" forget --keep-daily "$DIARIOS" --keep-weekly "$SEMANALES" --keep-monthly "$MENSUALES" \
        --group-by host --prune --quiet 2>"$ESTADO/.$c.err"; then
    errores+=("la depuración falló: $(tail -c 300 "$ESTADO/.$c.err" | tr '\n' ' ')")
  fi
  # Verificación de la estructura todos los días; los domingos lee además una séptima parte de los datos
  local extra=(); [ "$(date +%u)" = 7 ] && extra=(--read-data-subset "$(( $(date +%V) % 7 + 1 ))/7")
  if ! restic_de "$c" check "${extra[@]}" >"$ESTADO/.$c.err" 2>&1; then
    errores+=("la verificación encontró problemas: $(tail -c 300 "$ESTADO/.$c.err" | tr '\n' ' ')")
  fi
  ultima="$(restic_de "$c" snapshots --json 2>/dev/null | grep -o '"time":"[^"]*"' | cut -d'"' -f4 | sort | tail -1)"
  copias="$(restic_de "$c" snapshots --json 2>/dev/null | grep -o '"short_id"' | wc -l)"
  if [ -z "$ultima" ]; then
    errores+=("el repositorio no tiene ninguna copia"); edad=-1
  else
    edad=$(( ($(date +%s) - $(date -d "$ultima" +%s)) / 3600 ))
    [ "$edad" -lt "$MAX_HORAS" ] || errores+=("la última copia es de hace $edad h ($ultima)")
  fi
  bytes="$(du -sb "$RAIZ/$c" 2>/dev/null | cut -f1)"
  sal=true; [ "${#errores[@]}" -eq 0 ] || sal=false
  {
    printf '{"cliente":"%s","t":"%s","ok":%s,"copias":%s,"ultima":"%s","horas":%s,"bytes":%s,"segundos":%s,"errores":[' \
      "$c" "$(date -Is)" "$sal" "${copias:-0}" "$ultima" "$edad" "${bytes:-0}" "$(( $(date +%s) - t0 ))"
    local sep="" e; for e in "${errores[@]:-}"; do [ -n "$e" ] && { printf '%s"%s"' "$sep" "$(echo "$e" | tr -d '\n"\\' | cut -c1-300)"; sep=","; }; done
    printf ']}\n'
  } > "$ESTADO/$c.json"
  : > "$ESTADO/.$c.err"; unlink "$ESTADO/.$c.err"
  if [ "$sal" = true ]; then
    aviso "   OK: $copias copia/s, la última de hace $edad h, $(numfmt --to=iec "${bytes:-0}") en disco"
  else
    FALLARON=$((FALLARON + 1)); for e in "${errores[@]}"; do aviso "   ERROR: $e"; done
  fi
}

case "${1:-}" in
  alta) [ -n "${2:-}" ] || { echo "Uso: $0 alta <cliente>" >&2; exit 2; }; alta "$2" ;;
  copias) nombre_ok "${2:-}" && [ -f "$CONF/claves/$2" ] || { echo "Uso: $0 copias <cliente>" >&2; exit 2; }
          restic_de "$2" snapshots --compact ;;
  estado)
    for c in $(repos); do
      if [ -f "$ESTADO/$c.json" ]; then cat "$ESTADO/$c.json"; else echo "{\"cliente\":\"$c\",\"ok\":false,\"errores\":[\"todavía no corrió el mantenimiento\"]}"; fi
    done ;;
  mantener)
    install -d -m 700 -o "$USUARIO" -g "$USUARIO" "$ESTADO" "$RAIZ/_cache"
    exec 9>"$ESTADO/.candado"; flock -n 9 || { echo "Ya hay un mantenimiento corriendo; salgo." >&2; exit 0; }
    FALLARON=0; LISTA="$(repos)"
    if [ -n "${2:-}" ]; then grep -qx "$2" <<<"$LISTA" || { echo "ERROR: no existe el repositorio '$2'" >&2; exit 2; }; LISTA="$2"; fi
    [ -n "$LISTA" ] || { aviso "No hay repositorios dados de alta."; exit 0; }
    for c in $LISTA; do mantener_uno "$c"; done
    if [ "$FALLARON" -gt 0 ]; then aviso "Terminó CON $FALLARON repositorio/s con problemas."; exit 1; fi
    [ -n "${2:-}" ] || date -Is > "$ESTADO/ultimo-ok"
    aviso "Mantenimiento OK." ;;
  *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
