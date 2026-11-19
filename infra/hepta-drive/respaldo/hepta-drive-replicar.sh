#!/usr/bin/env bash
# hepta-drive-replicar.sh — corre en hcsvrnd01 (el nodo que tiene el NAS montado), una vez al día.
# Se instala como /usr/local/sbin/hepta-drive-replicar.
#
# Copia al NAS los repositorios de restic de HEPTA Drive que viven en el servidor de respaldos (contenedor
# hepta-respaldo, pool ceph-hdd). Esa copia en el NAS es la que hepta-backup-drive.sh repos sube a Google Drive.
#
# Reglas:
#   - Solo se replica un repositorio que pasó la verificación de hoy (hepta-respaldo-repos mantener). Un repositorio
#     dañado no se copia encima de la réplica buena.
#   - Cada archivo nuevo se comprueba en el NAS: en un repositorio de restic el nombre de cada archivo es la suma
#     sha256 de su contenido, así que se verifica sin conocer la contraseña.
#   - Se compara por nombre y tamaño, no por fecha: en restic cada archivo es inmutable y su nombre es la suma de
#     su contenido, y el NAS (SMB) no guarda las fechas con la misma precisión que el original.
#   - La réplica queda igual al original (lo que la depuración borró, se borra), pero nunca se borra contra un
#     origen vacío o sin montar.
#   - Avisa también si en la VM hay un cliente con Nextcloud y sin respaldo configurado.
#   - Si algo falla: sale con error y deja el motivo en $DESTINO/ALERTA-replica.txt; hepta-backup-retirar.sh lo
#     suma a la alerta general (ALERTA.txt), que miran el vigía y el informe por correo.
#
# Uso: hepta-drive-replicar.sh [--solo-ver]
set -uo pipefail

PROYECTO="${HEPTA_PROYECTO:-HEPTA}"
SERVIDOR="${HD_SERVIDOR:-hepta-respaldo}"       # contenedor con los repositorios
VM="${HD_VM:-hepta-drive}"
RAIZ="${HD_RAIZ:-/srv/restic}"                  # dentro del contenedor
MONTAJE="${HEPTA_NAS_MONTAJE:-/mnt/nas}"
DESTINO="${HD_DESTINO:-$MONTAJE/hepta-drive-repos}"
MAX_HORAS="${HD_MAX_HORAS:-26}"                 # antigüedad máxima de la verificación del servidor
SOLO_VER=0; [ "${1:-}" = "--solo-ver" ] && SOLO_VER=1

aviso() { echo "[$(date '+%F %H:%M:%S')] $*"; }
ALERTAS=()
alerta() { ALERTAS+=("$*"); aviso "ALERTA: $*"; }
en() { local inst="$1"; shift; lxc exec --project "$PROYECTO" "$inst" -- "$@"; }
campo() { grep -o "\"$2\":[^,}]*" <<<"$1" | head -1 | cut -d: -f2- | tr -d '"'; }

command -v rsync >/dev/null || { echo "ERROR: falta rsync en este nodo (apt install rsync)" >&2; exit 2; }
if [ -z "${HEPTA_SIN_MONTAJE:-}" ] && ! mountpoint -q "$MONTAJE"; then
  echo "ERROR: $MONTAJE no está montado. No se replica nada." >&2; exit 2
fi
mkdir -p "$DESTINO" || { echo "ERROR: no se puede escribir en $DESTINO" >&2; exit 2; }
exec 9>"/tmp/hepta-drive-replicar.candado"; flock -n 9 || { echo "Ya hay una réplica corriendo; salgo." >&2; exit 0; }

# rsync habla con el contenedor a través de lxc exec (no hace falta SSH ni abrir puertos)
PUENTE="$(mktemp)"; LISTA="$(mktemp)"; trap 'unlink "$PUENTE"; unlink "$LISTA"' EXIT
printf '#!/bin/sh\nshift\nexec lxc exec --project %s %s -- "$@"\n' "$PROYECTO" "$SERVIDOR" > "$PUENTE"; chmod 700 "$PUENTE"

AHORA=$(date +%s); T0=$AHORA
if ! en "$SERVIDOR" sh -c "mountpoint -q $RAIZ && command -v rsync >/dev/null"; then
  alerta "el servidor de respaldos no responde, no tiene montado $RAIZ o le falta rsync"
  CLIENTES=""
else
  CLIENTES="$(en "$SERVIDOR" sh -c "ls -1 $RAIZ/_estado/ 2>/dev/null" | sed -n 's/^\([a-z0-9][a-z0-9-]*\)\.json$/\1/p')"
  [ -n "$CLIENTES" ] || alerta "el servidor de respaldos no tiene ningún repositorio verificado todavía"
fi

for c in $CLIENTES; do
  aviso "── $c"
  est="$(en "$SERVIDOR" cat "$RAIZ/_estado/$c.json" 2>/dev/null | head -1)"
  if [ "$(campo "$est" ok)" != true ]; then
    alerta "$c: el servidor de respaldos informa problemas: $(grep -o '"errores":.*' <<<"$est" | cut -c1-240). No se replica."; continue
  fi
  t="$(campo "$est" t)"; edad=$(( (AHORA - $(date -d "$t" +%s 2>/dev/null || echo 0)) / 3600 ))
  if [ "$edad" -ge "$MAX_HORAS" ]; then alerta "$c: la última verificación del repositorio es de hace $edad h. No se replica."; continue; fi
  if ! en "$SERVIDOR" test -s "$RAIZ/$c/config"; then alerta "$c: el repositorio no tiene archivo config. No se replica."; continue; fi

  if [ "$SOLO_VER" = 1 ]; then
    rsync -rtn --size-only --delete --stats -e "$PUENTE" "x:$RAIZ/$c/" "$DESTINO/$c/" 2>&1 | grep -E "Number of (regular )?files transferred|Number of deleted|Total transferred" | sed 's/^/   /'
    continue
  fi
  mkdir -p "$DESTINO/$c"
  if ! rsync -rt --size-only --delete --out-format='%n' -e "$PUENTE" "x:$RAIZ/$c/" "$DESTINO/$c/" > "$LISTA" 2>"$DESTINO/.$c.err"; then
    alerta "$c: la copia al NAS falló: $(tail -c 240 "$DESTINO/.$c.err" | tr '\n' ' ')"; continue
  fi
  # Verificación: nombre del archivo = sha256 de su contenido (todo menos "config")
  malos=0; nuevos=0
  while read -r f; do
    case "$f" in data/*/*|index/*|snapshots/*|keys/*) ;; *) continue;; esac
    [ -f "$DESTINO/$c/$f" ] || continue
    nuevos=$((nuevos + 1))
    [ "$(sha256sum "$DESTINO/$c/$f" | cut -d' ' -f1)" = "$(basename "$f")" ] || { malos=$((malos + 1)); aviso "   NO COINCIDE: $f"; }
  done < "$LISTA"
  if [ "$malos" -gt 0 ]; then alerta "$c: $malos archivo/s copiados al NAS no coinciden con su suma"; continue; fi
  # Segunda pasada en seco: no tiene que quedar nada por copiar ni por borrar
  RESTO="$(rsync -rtn --size-only --delete --out-format='%i %n' -e "$PUENTE" "x:$RAIZ/$c/" "$DESTINO/$c/" 2>&1 | grep -v '/$' | grep -v ' locks/')"
  if [ -n "$RESTO" ]; then
    aviso "   Diferencias que quedaron ($(wc -l <<<"$RESTO")):"; head -5 <<<"$RESTO" | sed 's/^/     /'
    alerta "$c: la réplica del NAS no quedó igual al original ($(wc -l <<<"$RESTO") diferencia/s; la primera: $(head -1 <<<"$RESTO" | cut -c1-80))"; continue
  fi
  echo "$est" > "$DESTINO/$c.estado.json"
  aviso "   OK: $nuevos archivo/s nuevos verificados · $(campo "$est" copias) copia/s · $(du -sh "$DESTINO/$c" | cut -f1) en el NAS"
done

# Un cliente con Nextcloud y sin respaldo configurado
SIN="$(en "$VM" cat /var/lib/hepta-drive-respaldo/sin-respaldo.txt 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
[ -z "$SIN" ] || alerta "en $VM hay clientes SIN respaldo configurado: $SIN"

[ "$SOLO_VER" = 1 ] && exit 0
if [ "${#ALERTAS[@]}" -gt 0 ]; then
  { date '+%F %T'; printf '%s\n' "${ALERTAS[@]}"; } > "$DESTINO/ALERTA-replica.txt"
  aviso "Terminó CON ${#ALERTAS[@]} alerta/s (ver $DESTINO/ALERTA-replica.txt)"; exit 1
fi
[ -e "$DESTINO/ALERTA-replica.txt" ] && unlink "$DESTINO/ALERTA-replica.txt"
date -Is > "$DESTINO/ultimo-replica-ok"
aviso "Réplica OK en $(( $(date +%s) - T0 )) s: $(du -sh "$DESTINO" | cut -f1) en $DESTINO"
