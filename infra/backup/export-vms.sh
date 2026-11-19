#!/usr/bin/env bash
# export-vms.sh — Exporta las VMs críticas del MicroCloud (disco completo) a NAS y, opcionalmente, a Google Drive cifrado.
# Es la capa que recupera lo que NO es dato: sistema, imágenes de Docker, módulos Enterprise. Los datos del día
# a día van por hepta-backup.sh (cada 6 h).
#
# Uso:   export-vms.sh [--semanal] [--drive] [VM ...]
#        sin VMs   → exporta la lista CRITICAS
#        --semanal → modo programado: marca el lote como completo, deja solo los últimos LOTES_SEMANALES lotes
#                    completos y anota el resultado para el control de vida (lo mira hepta-backup-retirar.sh)
#        --drive   → además sube el lote al remote rclone GDRIVE_REMOTE
# Corre como root en hcsvrnd01. Cada corrida crea su propia carpeta fechada. Los lotes hechos a mano (sin
# --semanal) nunca se borran solos.
set -euo pipefail

PROJECT="HEPTA"
NAS_MOUNT="${EXPORT_NAS_MOUNT:-/mnt/nas}"
NAS_ROOT="${EXPORT_NAS_ROOT:-$NAS_MOUNT/lxd-exports}"
GDRIVE_REMOTE="gdrive-crypt:lxd-exports"       # remote rclone tipo crypt (ver runbook)
LXD_BACKUPS_DIR="/var/snap/lxd/common/lxd/backups"
MIN_FREE_FACTOR=130                              # % del uso de disco de la VM que debe estar libre (margen)
# hepta-drive y hepta-respaldo: el export trae el sistema y la configuración, NO sus volúmenes de datos
# (hepta-drive-data y hepta-respaldo-repos); esos datos van por restic (infra/hepta-drive/respaldo/).
CRITICAS=(dkr-hgsvrlnx003 HGSVRLNX111 HGSVRLNX104 hepta-cloud retopa-core v-HGSVRLNX004 hepta-drive hepta-respaldo)
LOTES_SEMANALES=4

DRIVE=0
SEMANAL=0
VMS=()
for a in "$@"; do
  case "$a" in
    --drive) DRIVE=1 ;;
    --semanal) SEMANAL=1 ;;
    *) VMS+=("$a") ;;
  esac
done
[[ ${#VMS[@]} -eq 0 ]] && VMS=("${CRITICAS[@]}")

# Sin NAS montado no se crea nada (si no, el lote quedaría en el disco del propio nodo)
mountpoint -q "$NAS_MOUNT" || [[ -n "${EXPORT_SIN_MONTAJE:-}" ]] || { echo "ERROR: $NAS_MOUNT no está montado" >&2; exit 1; }
exec 9>/tmp/export-vms.candado
flock -n 9 || { echo "Ya hay un export corriendo; salgo." >&2; exit 0; }

STAMP="$(date +%Y%m%d_%H%M)"
DEST="$NAS_ROOT/$STAMP"
LOG="$NAS_ROOT/export-$STAMP.log"
mkdir -p "$DEST"
exec > >(tee -a "$LOG") 2>&1

T_INICIO=$(date +%s)
echo "== export-vms $STAMP  proyecto=$PROJECT  destino=$DEST  $([[ $SEMANAL == 1 ]] && echo '(lote semanal)')"

# Perfiles y estado del clúster: necesarios para restaurar en otro LXD (DL380)
mkdir -p "$DEST/_meta"
lxc profile list --project "$PROJECT" -f csv -c n | while read -r p; do
  lxc profile show --project "$PROJECT" "$p" > "$DEST/_meta/profile-$p.yaml"
done
lxc list --all-projects -c nspmL,config:limits.memory -f compact > "$DEST/_meta/instances.txt"
lxc cluster list > "$DEST/_meta/cluster.txt"
lxc storage list > "$DEST/_meta/storage.txt"

FALLOS=0
for vm in "${VMS[@]}"; do
  echo "---- $vm"
  if ! lxc info --project "$PROJECT" "$vm" >/dev/null 2>&1; then
    echo "  SKIP: no existe en el proyecto $PROJECT"; FALLOS=$((FALLOS+1)); continue
  fi
  node="$(lxc list --project "$PROJECT" "^${vm}$" -c L -f csv)"
  usage="$(lxc query "/1.0/instances/${vm}/state?project=${PROJECT}" | grep -o '"usage":[0-9]*' | head -1 | cut -d: -f2)"
  usage="${usage:-0}"
  need=$(( usage * MIN_FREE_FACTOR / 100 ))

  # LXD arma el tarball en storage.backups_volume del nodo que aloja la VM (o en $LXD_BACKUPS_DIR si no está definido).
  # Solo informa; nunca aborta: si falta espacio, LXD falla, se registra y se sigue con la siguiente VM.
  bvol="$(lxc config get storage.backups_volume --target "$node" 2>/dev/null | tr -d '[:space:]' || true)"
  echo "  nodo=$node  uso_disco=$((usage/1024/1024/1024)) GiB  staging=${bvol:-$LXD_BACKUPS_DIR}"
  if [[ "$node" == "$(hostname)" ]]; then
    sdir="$LXD_BACKUPS_DIR"
    [[ -n "$bvol" ]] && sdir="/var/snap/lxd/common/lxd/storage-pools/${bvol%%/*}/custom/default_${bvol##*/}"
    [[ -d "$sdir" ]] && echo "  libre en staging: $(df -h --output=avail "$sdir" | tail -1 | tr -d ' ')"
  fi

  lxc config show --project "$PROJECT" --expanded "$vm" > "$DEST/$vm.config.yaml"
  out="$DEST/$vm.tar.zst"
  t0=$(date +%s)
  if lxc export --project "$PROJECT" "$vm" "$out" --instance-only --compression zstd; then
    :
  else
    echo "  zstd falló, reintento con gzip"
    out="$DEST/$vm.tar.gz"
    lxc export --project "$PROJECT" "$vm" "$out" --instance-only || { echo "  ERROR exportando $vm"; FALLOS=$((FALLOS+1)); continue; }
  fi
  if [[ ! -s "$out" ]]; then echo "  ERROR: el export de $vm salió vacío"; FALLOS=$((FALLOS+1)); continue; fi
  sha256sum "$out" > "$out.sha256"
  echo "  OK $(du -h "$out" | cut -f1) en $(( $(date +%s) - t0 )) s"
done

echo "== resumen ($(( ($(date +%s) - T_INICIO) / 60 )) min en total)"; ls -lh "$DEST"; df -h "$NAS_MOUNT" | tail -1
(( FALLOS == 0 )) || echo "== $FALLOS VM(s) con problemas, revisar arriba"

if (( SEMANAL == 1 )); then
  if (( FALLOS == 0 )); then
    date -Is > "$DEST/_LOTE_COMPLETO"
    date -Is > "$NAS_ROOT/ultimo-lote-ok"; rm -f "$NAS_ROOT/ultimo-lote-fallo"
    # Quedan los últimos $LOTES_SEMANALES lotes completos; los hechos a mano (sin la marca) no se tocan
    for viejo in $(ls -1d "$NAS_ROOT"/[0-9]*_[0-9]*/ 2>/dev/null | sort -r | while read -r d; do [[ -f "$d/_LOTE_COMPLETO" ]] && echo "$d"; done | tail -n +$((LOTES_SEMANALES + 1))); do
      echo "== se borra el lote viejo $(basename "$viejo")"
      rm -rf "${viejo%/}" "$NAS_ROOT/export-$(basename "$viejo").log"
    done
  else
    echo "$(date -Is) lote $STAMP: $FALLOS VM(s) con problemas (ver $LOG)" > "$NAS_ROOT/ultimo-lote-fallo"
  fi
fi

if (( DRIVE == 1 )); then
  echo "== subiendo a $GDRIVE_REMOTE/$STAMP"
  rclone copy "$DEST" "$GDRIVE_REMOTE/$STAMP" --transfers 2 --checkers 4 --progress --stats 1m
  rclone check "$DEST" "$GDRIVE_REMOTE/$STAMP" --one-way && echo "== Drive verificado"
fi
exit $FALLOS
