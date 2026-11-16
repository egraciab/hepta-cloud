#!/usr/bin/env bash
# hepta-backup-drive.sh — copia fuera de sitio: sube los respaldos del NAS a Google Drive, CIFRADOS.
# Corre en hcsvrnd01. Usa el remote de rclone "gdrive-crypt" (tipo crypt sobre Google Drive): los archivos y
# sus nombres se cifran antes de salir del nodo; en Drive solo se ve ruido. Sin las dos contraseñas del crypt
# (están en KeePass) la copia no se puede leer: ni Google ni quien entre a la cuenta.
#
#   hepta-backup-drive.sh datos     respaldos de datos (/mnt/nas/hepta-backups): UNA corrida por día y por VM
#                                   (la última de cada día que el NAS conserva) y los paquetes de carpetas
#   hepta-backup-drive.sh exports   export semanal de las VM completas: los lotes marcados como completos
#   ... --solo-ver                  muestra qué subiría y qué borraría, sin tocar Drive
#
# Drive queda igual a esa selección: lo que el NAS ya depuró se borra también de Drive (va a la papelera de
# Drive, que lo guarda 30 días). Después de subir, compara cada archivo con su copia cifrada (cryptcheck).
# Resultado en el NAS: ultimo-drive-<modo>-ok / ultimo-drive-<modo>-fallo (los lee el informe por correo).
set -uo pipefail

MONTAJE="${HEPTA_NAS_MONTAJE:-/mnt/nas}"
NAS="${HEPTA_NAS:-$MONTAJE/hepta-backups}"
EXPORTS="${HEPTA_EXPORTS:-$MONTAJE/lxd-exports}"
REMOTO="${HEPTA_DRIVE_REMOTO:-gdrive-crypt}"
LIMITE="${HEPTA_DRIVE_LIMITE:-}"           # tope de subida, por ejemplo 20M (megabytes por segundo); vacío = sin tope
MODO="${1:-}"; SOLO_VER=0; [ "${2:-}" = "--solo-ver" ] && SOLO_VER=1

case "$MODO" in datos|exports) ;; *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2;; esac
aviso() { echo "[$(date '+%F %H:%M:%S')] $*"; }
command -v rclone >/dev/null || { echo "ERROR: falta rclone" >&2; exit 2; }
[ -n "${HEPTA_SIN_MONTAJE:-}" ] || mountpoint -q "$MONTAJE" || { echo "ERROR: $MONTAJE no está montado" >&2; exit 2; }
rclone listremotes 2>/dev/null | grep -qx "$REMOTO:" || { echo "ERROR: no existe el remote '$REMOTO' en rclone (ver README)" >&2; exit 2; }
exec 9>"/tmp/hepta-backup-drive-$MODO.candado"; flock -n 9 || { echo "Ya hay una subida de $MODO corriendo; salgo." >&2; exit 0; }

FILTRO="$(mktemp)"; trap 'rm -f "$FILTRO"' EXIT
if [ "$MODO" = datos ]; then
  ORIGEN="$NAS"; DESTINO="$REMOTO:hepta-backups"
  for d in "$NAS"/*/; do
    vm="$(basename "$d")"; [ -d "$d/dumps" ] || continue
    # La última corrida de cada día
    ls -1 "$d/dumps" | grep -E '^[0-9]{8}_[0-9]{4}$' | sort | awk -F_ '{u[$1]=$0} END{for(k in u) print u[k]}' | sort |
      while read -r marca; do echo "+ /$vm/dumps/$marca/**"; done
    echo "+ /$vm/archivos/archivos-*.tar.zst"
    echo "+ /$vm/estado.json"; echo "+ /$vm/historial.jsonl"
  done > "$FILTRO"
else
  ORIGEN="$EXPORTS"; DESTINO="$REMOTO:lxd-exports"
  for d in "$EXPORTS"/[0-9]*_[0-9]*/; do
    [ -f "$d/_LOTE_COMPLETO" ] || continue
    lote="$(basename "$d")"; echo "+ /$lote/**"; echo "+ /export-$lote.log"
  done > "$FILTRO"
fi
[ -s "$FILTRO" ] || { aviso "No hay nada para subir ($MODO)."; exit 0; }
echo "- **" >> "$FILTRO"

OPC=(--filter-from "$FILTRO" --transfers 2 --checkers 4 --retries 3 --low-level-retries 10 --stats 5m --stats-one-line)
[ -n "$LIMITE" ] && OPC+=(--bwlimit "$LIMITE")

if [ "$SOLO_VER" = 1 ]; then
  aviso "Simulación ($MODO): $ORIGEN → $DESTINO"
  rclone sync "$ORIGEN" "$DESTINO" "${OPC[@]}" --delete-excluded --dry-run 2>&1 | grep -v '^$' | tail -40
  exit 0
fi

T0=$(date +%s)
aviso "Subida de $MODO: $ORIGEN → $DESTINO"
fallo() {
  echo "$(date -Is) $MODO: $*" > "$NAS/ultimo-drive-$MODO-fallo"
  aviso "FALLÓ la copia a Drive ($MODO): $*"; exit 1
}
rclone sync "$ORIGEN" "$DESTINO" "${OPC[@]}" --delete-excluded 2>&1 | tail -15
[ "${PIPESTATUS[0]}" -eq 0 ] || fallo "rclone sync terminó con error (ver el log)"
aviso "Verificando contra la copia cifrada…"
rclone cryptcheck "$ORIGEN" "$DESTINO" --filter-from "$FILTRO" --one-way --checkers 4 2>&1 | tail -4
[ "${PIPESTATUS[0]}" -eq 0 ] || fallo "la verificación encontró diferencias entre el NAS y Drive"

TAM="$(rclone size "$DESTINO" 2>/dev/null | sed -n 's/^Total size: \([^(]*\).*/\1/p' | sed 's/ *$//')"
{ date -Is; echo "${TAM:-?} en Drive · $(( ($(date +%s) - T0) / 60 )) min"; } > "$NAS/ultimo-drive-$MODO-ok"
rm -f "$NAS/ultimo-drive-$MODO-fallo"
aviso "Copia a Drive OK ($MODO): ${TAM:-?} en Drive, $(( ($(date +%s) - T0) / 60 )) min."
