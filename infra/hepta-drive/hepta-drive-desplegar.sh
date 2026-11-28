#!/usr/bin/env bash
# hepta-drive-desplegar.sh — lleva a la VM hepta-drive lo que está en el repo de HEPTA Cloud. Corre en hcsvrnd01, como root.
#
#   hepta-drive-desplegar             muestra qué cambiaría (no toca nada)
#   hepta-drive-desplegar --aplicar   copia lo que cambió y reinicia el agente si hace falta
#
# De dónde sale: el clon del repo que ya vive en la VM de HEPTA Cloud (el mismo del deploy de siempre, después de
# su `git pull`). No hace falta git en este nodo ni una clave de GitHub en la DMZ: los archivos pasan con `lxc file`.
#
# Qué lleva:
#   alta-cliente.sh              → /usr/local/sbin/hepta-drive-alta
#   salud/hepta-drive-salud.py   → /usr/local/sbin/hepta-drive-salud
#   agente/main.py               → /opt/hepta-drive/agente/main.py           (reinicia el agente si cambió)
#   agente/hepta-drive-agente.service → /etc/systemd/system/                 (ídem)
# El agente no se reinicia si hay un trabajo en curso (un alta, una baja): avisa y hay que volver a correrlo.
#
# Qué NO lleva, solo compara: shared/compose.yaml y shared/clamd.conf. Reiniciar ClamAV u OnlyOffice corta las subidas
# de todos los clientes un minuto; eso se hace a mano y en un momento tranquilo (ver README, "Antivirus y salud").
set -euo pipefail

PROYECTO="${HD_PROYECTO:-HEPTA}"
ORIGEN="${HD_ORIGEN:-hepta-cloud}"                 # VM de HEPTA Cloud
REPO="${HD_REPO:-/opt/heptacloud}"                 # clon del repo dentro de esa VM
DESTINO="${HD_DESTINO:-hepta-drive}"
BASE="$REPO/infra/hepta-drive"

APLICAR=0
case "${1:-}" in
  --aplicar) APLICAR=1 ;;
  ""|--revisar) ;;
  *) echo "Uso: $0 [--aplicar]" >&2; exit 2 ;;
esac
[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }

en() { local vm="$1"; shift; lxc exec --project "$PROYECTO" "$vm" -- "$@"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

echo "Origen: $ORIGEN:$REPO · $(en "$ORIGEN" git -C "$REPO" log -1 --format='%h %ad %s' --date=format:'%Y-%m-%d %H:%M')"
if [ -n "$(en "$ORIGEN" git -C "$REPO" status --porcelain -- infra/hepta-drive)" ]; then
  echo "AVISO: el clon de $ORIGEN tiene cambios sin commitear en infra/hepta-drive; se lleva lo que hay en disco."
fi
echo

# origen (relativo a infra/hepta-drive) | destino en la VM | permisos | qué hacer si cambia
ARCHIVOS=(
  "alta-cliente.sh|/usr/local/sbin/hepta-drive-alta|0755|"
  "salud/hepta-drive-salud.py|/usr/local/sbin/hepta-drive-salud|0755|"
  "agente/main.py|/opt/hepta-drive/agente/main.py|0644|agente"
  "agente/hepta-drive-agente.service|/etc/systemd/system/hepta-drive-agente.service|0644|agente"
)
SOLO_COMPARAR=(
  "shared/compose.yaml|/opt/hepta-drive/shared/compose.yaml"
  "shared/clamd.conf|/opt/hepta-drive/shared/clamd.conf"
)

traer() {  # traer <ruta en el origen> <archivo local>
  lxc file pull --project "$PROYECTO" "$ORIGEN$1" "$2" 2>/dev/null
}
hash_destino() {
  en "$DESTINO" sh -c "sha256sum '$1' 2>/dev/null | cut -c1-64" || true
}

cambios=0; reiniciar_agente=0
for linea in "${ARCHIVOS[@]}"; do
  IFS='|' read -r rel dest modo accion <<<"$linea"
  local_="$TMP/$(echo "$rel" | tr / _)"
  if ! traer "$BASE/$rel" "$local_"; then echo "  FALTA en el repo: $rel"; continue; fi
  nuevo="$(sha256sum "$local_" | cut -c1-64)"
  actual="$(hash_destino "$dest")"
  if [ "$nuevo" = "$actual" ]; then
    echo "  igual       $dest"
    continue
  fi
  cambios=$((cambios + 1))
  if [ -z "$actual" ]; then echo "  NUEVO       $dest"; else echo "  CAMBIA      $dest"; fi
  if [ -n "$actual" ]; then
    en "$DESTINO" cat "$dest" > "$TMP/actual"
    diff -u --label "en la VM" --label "en el repo" "$TMP/actual" "$local_" | sed -n '1,40p' | sed 's/^/      /' || true
    if [ "$(diff -u "$TMP/actual" "$local_" | wc -l)" -gt 40 ]; then echo "      (…diferencia recortada a 40 líneas)"; fi
  fi
  if [ "$APLICAR" = 1 ]; then
    lxc file push --project "$PROYECTO" --mode "$modo" --uid 0 --gid 0 "$local_" "$DESTINO$dest.nuevo"
    en "$DESTINO" mv -f "$dest.nuevo" "$dest"
    echo "      → copiado"
    [ "$accion" = agente ] && reiniciar_agente=1
  fi
done

echo
for linea in "${SOLO_COMPARAR[@]}"; do
  IFS='|' read -r rel dest <<<"$linea"
  local_="$TMP/$(echo "$rel" | tr / _)"
  traer "$BASE/$rel" "$local_" || { echo "  FALTA en el repo: $rel"; continue; }
  if [ "$(sha256sum "$local_" | cut -c1-64)" = "$(hash_destino "$dest")" ]; then
    echo "  igual       $dest"
  else
    echo "  DISTINTO    $dest (no se copia: revisar a mano, reinicia servicios compartidos)"
  fi
done

PENDIENTE=/var/lib/hepta-drive/agente/reinicio-pendiente
if en "$DESTINO" test -e "$PENDIENTE"; then
  echo; echo "  El agente tiene un reinicio pendiente de una corrida anterior."
  reiniciar_agente=1
fi

if [ "$APLICAR" = 0 ]; then
  echo
  if [ "$cambios" -gt 0 ] || [ "$reiniciar_agente" = 1 ]; then echo "$cambios archivo(s) para llevar. Para aplicarlo: $0 --aplicar"; else echo "Nada para llevar."; fi
  exit 0
fi

if [ "$reiniciar_agente" = 1 ]; then
  echo
  if en "$DESTINO" sh -c 'grep -lsq "\"estado\": \"en_curso\"" /var/lib/hepta-drive/agente/trabajos/*.json'; then
    en "$DESTINO" touch "$PENDIENTE"
    echo "AVISO: hay un trabajo en curso en el agente. Los archivos ya están copiados, pero el agente NO se reinició."
    echo "       Cuando termine, volvé a correr: $0 --aplicar"
    exit 1
  fi
  en "$DESTINO" rm -f "$PENDIENTE"
  en "$DESTINO" systemctl daemon-reload
  en "$DESTINO" systemctl restart hepta-drive-agente
  sleep 3
  echo "Agente: $(en "$DESTINO" systemctl is-active hepta-drive-agente) · $(en "$DESTINO" curl -s -m 5 --cacert /etc/hepta-drive-agente/cert.pem https://10.10.50.220:8888/health || echo 'NO RESPONDE')"
fi
echo "Listo."
