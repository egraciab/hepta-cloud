#!/usr/bin/env bash
# hepta-backup-retirar.sh — corre en el nodo del clúster que tiene el NAS montado (hcsvrnd01).
# Retira de cada VM lo que dejó hepta-backup.sh y lo guarda en el NAS con histórico.
# Las VM no conocen el NAS ni tienen credenciales de él: si una VM se compromete, no alcanza sus respaldos.
#
#   - Corridas de volcados: se copian las que faltan y se verifica cada archivo con sha256.
#   - Carpetas de datos (filestore, uploads): un paquete por día.
#   - Histórico de volcados en el NAS: todo lo de 2 días, uno por día hasta 14 días, uno por semana hasta 8 semanas.
#   - Control de vida: si una VM no tiene un respaldo bueno en las últimas MAX_HORAS, o no responde,
#     el script termina con error y deja el motivo en $NAS/ALERTA.txt (el monitoreo mira ese archivo).
#
# Uso: hepta-backup-retirar.sh [VM ...]     (sin argumentos: todas las de VMS)
set -uo pipefail

PROYECTO="${HEPTA_PROYECTO:-HEPTA}"
VMS="${HEPTA_VMS:-hepta-cloud retopa-core HGSVRLNX104 HGSVRLNX111}"
MONTAJE="${HEPTA_NAS_MONTAJE:-/mnt/nas}"
NAS="${HEPTA_NAS:-$MONTAJE/hepta-backups}"
ORIGEN=/var/backups/hepta
MAX_HORAS="${HEPTA_MAX_HORAS:-7}"
DIAS_ARCHIVOS=7

[ $# -gt 0 ] && VMS="$*"
aviso() { echo "[$(date '+%F %H:%M:%S')] $*"; }
ALERTAS=()
alerta() { ALERTAS+=("$*"); aviso "ALERTA: $*"; }
en_vm() { local vm="$1"; shift; lxc exec --project "$PROYECTO" "$vm" -- "$@"; }

# Sin NAS montado no se escribe nada: si no, los "respaldos" quedarían en el disco del propio nodo.
if [ -z "${HEPTA_SIN_MONTAJE:-}" ] && ! mountpoint -q "$MONTAJE"; then
  echo "ERROR: $MONTAJE no está montado. No se retira nada." >&2; exit 2
fi
mkdir -p "$NAS" || { echo "ERROR: no se puede escribir en $NAS" >&2; exit 2; }
exec 9>"/tmp/hepta-backup-retirar.candado"; flock -n 9 || { echo "Ya hay un retiro corriendo; salgo." >&2; exit 0; }

AHORA=$(date +%s); HOY=$(date +%Y%m%d)

for vm in $VMS; do
  aviso "── $vm"
  dest="$NAS/$vm"; mkdir -p "$dest/dumps" "$dest/archivos"

  # ── Control de vida ──
  ultimo="$(en_vm "$vm" cat "$ORIGEN/ultimo-ok" 2>/dev/null)" || ultimo=""
  if [ -z "$ultimo" ]; then alerta "$vm: no responde o nunca tuvo un respaldo bueno"; continue; fi
  edad=$(( (AHORA - $(date -d "$ultimo" +%s)) / 3600 ))
  if [ "$edad" -ge "$MAX_HORAS" ]; then alerta "$vm: el último respaldo bueno es de hace $edad h ($ultimo)"; fi
  en_vm "$vm" cat "$ORIGEN/estado.json" > "$dest/estado.json" 2>/dev/null
  grep -q '"ok":true' "$dest/estado.json" || alerta "$vm: la última corrida falló: $(grep -o '"errores":.*' "$dest/estado.json" | cut -c1-240)"

  # ── Corridas de volcados que faltan en el NAS ──
  for marca in $(en_vm "$vm" sh -c "ls -1 $ORIGEN/dumps 2>/dev/null" | grep -E '^[0-9]{8}_[0-9]{4}$' | sort); do
    [ -d "$dest/dumps/$marca" ] && continue
    # Una corrida de más de 2 días que no está en el NAS ya fue depurada por el histórico: no se vuelve a traer.
    [ $(( (AHORA - $(date -d "${marca:0:4}-${marca:4:2}-${marca:6:2}" +%s)) / 86400 )) -gt 2 ] && [ -n "$(ls -A "$dest/dumps" 2>/dev/null)" ] && continue
    tmp="$dest/dumps/.$marca.parcial"; rm -rf "$tmp"; mkdir -p "$tmp"
    if en_vm "$vm" tar -C "$ORIGEN/dumps/$marca" -cf - . | tar -C "$tmp" -xf - \
       && en_vm "$vm" sh -c "cd $ORIGEN/dumps/$marca && sha256sum *" > "$tmp/.sumas" \
       && ( cd "$tmp" && sha256sum --quiet -c .sumas ); then
      mv "$tmp/.sumas" "$tmp/_sha256.txt"; mv "$tmp" "$dest/dumps/$marca"
      aviso "   volcados $marca: $(du -sh "$dest/dumps/$marca" | cut -f1), verificados"
    else
      rm -rf "$tmp"; alerta "$vm: la copia de la corrida $marca no coincide con el original"
    fi
  done

  # ── Carpetas de datos: un paquete por día ──
  if ! ls "$dest/archivos/archivos-$HOY".tar* >/dev/null 2>&1 && en_vm "$vm" test -d "$ORIGEN/archivos"; then
    f="$dest/archivos/archivos-$HOY.tar.zst"
    if en_vm "$vm" tar -C "$ORIGEN" -cf - archivos | zstd -q -T0 -o "$f.parcial" && zstd -q -t "$f.parcial"; then
      mv "$f.parcial" "$f"; aviso "   carpetas de datos: $(du -h "$f" | cut -f1)"
    else rm -f "$f.parcial"; alerta "$vm: no se pudo empaquetar las carpetas de datos"; fi
  fi
  ls -1 "$dest/archivos"/archivos-*.tar.zst 2>/dev/null | sort -r | tail -n +$((DIAS_ARCHIVOS + 1)) | xargs -r rm -f

  # ── Histórico de volcados: 2 días completos · 1 por día hasta 14 días · 1 por semana hasta 8 semanas ──
  declare -A visto=()
  for marca in $(ls -1 "$dest/dumps" | grep -E '^[0-9]{8}_[0-9]{4}$' | sort); do
    dia="${marca%%_*}"; t=$(date -d "${dia:0:4}-${dia:4:2}-${dia:6:2}" +%s); dias=$(( (AHORA - t) / 86400 ))
    if   [ "$dias" -le 2 ];  then clave="todas-$marca"
    elif [ "$dias" -le 14 ]; then clave="dia-$dia"
    elif [ "$dias" -le 56 ]; then clave="semana-$(date -d "@$t" +%G%V)"
    else clave=""; fi
    if [ -n "$clave" ] && [ -z "${visto[$clave]:-}" ]; then visto[$clave]=1; else rm -rf "${dest:?}/dumps/$marca"; fi
  done
  unset visto
done

if [ "${#ALERTAS[@]}" -gt 0 ]; then
  { date '+%F %T'; printf '%s\n' "${ALERTAS[@]}"; } > "$NAS/ALERTA.txt"
  aviso "Terminó CON ${#ALERTAS[@]} alerta/s (ver $NAS/ALERTA.txt)"; exit 1
fi
rm -f "$NAS/ALERTA.txt"; date -Is > "$NAS/ultimo-retiro-ok"
aviso "Retiro OK: $(du -sh "$NAS" | cut -f1) en $NAS"
