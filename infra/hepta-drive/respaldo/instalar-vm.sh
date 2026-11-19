#!/usr/bin/env bash
# instalar-vm.sh — se corre dentro de la VM hepta-drive. Instala el respaldo de archivos por cliente.
# Se puede volver a correr. No programa nada: el cron se agrega después de ver y medir la primera copia.
#
#   instalar-vm.sh <IP del servidor de respaldos> <certificado del servidor (cert.pem)>
set -euo pipefail

IP="${1:-}"; CERT="${2:-}"
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -s "$CERT" ] || { echo "Uso: $0 <IP del servidor> <cert.pem>" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
AQUI="$(cd "$(dirname "$0")" && pwd)"
CONF=/etc/hepta-drive-respaldo

export DEBIAN_FRONTEND=noninteractive
command -v restic >/dev/null || { apt-get update -q; apt-get install -y -q restic; }
restic version
install -m 755 "$AQUI/hepta-drive-respaldo.sh" /usr/local/sbin/hepta-drive-respaldo
install -d -m 700 "$CONF" /var/lib/hepta-drive-respaldo /var/cache/hepta-drive-respaldo
install -m 644 "$CERT" "$CONF/servidor.pem"
printf 'SERVIDOR=https://%s:8000\nCACERT=%s/servidor.pem\n' "$IP" "$CONF" > "$CONF/servidor.conf"

echo "── ¿Llega al servidor? (regla del firewall 10.10.50.220 → $IP tcp/8000)"
COD="$(curl -s -m 8 -o /dev/null -w '%{http_code}' --cacert "$CONF/servidor.pem" "https://$IP:8000/" || true)"
if [ "$COD" = 401 ]; then
  echo "OK: el servidor responde por TLS y pide usuario (401)."
else
  echo "ERROR: esperaba 401 y obtuve '$COD'. Si es 000, la VM no llega al servidor: revisar la regla del MikroTik y la ruta de vuelta."
  exit 1
fi
echo "Listo. Sigue: hepta-drive-respaldo --alta <cliente>"
