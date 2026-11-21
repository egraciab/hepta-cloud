#!/usr/bin/env bash
# instalar-agente.sh — corre en la VM hepta-drive, como root. Instala o actualiza el agente de alta.
#
#   ./instalar-agente.sh <carpeta con main.py y hepta-drive-agente.service>
#
# La primera vez pide la clave de la API (generala en KeePass, 40 caracteres o más, sin símbolos; no se muestra)
# y crea el certificado propio. Las veces siguientes solo actualiza el programa y reinicia el servicio.
set -euo pipefail
ORIGEN="${1:-$(cd "$(dirname "$0")" && pwd)}"
CONF=/etc/hepta-drive-agente
IP="${HD_IP:-10.10.50.220}"
PERMITIDOS="${HD_PERMITIDOS:-10.10.50.101,$IP}"     # HEPTA Cloud y la propia VM (para probar desde acá)

[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
[ -f "$ORIGEN/main.py" ] && [ -f "$ORIGEN/hepta-drive-agente.service" ] || { echo "ERROR: no encuentro main.py en $ORIGEN" >&2; exit 2; }
[ -x /usr/local/sbin/hepta-drive-alta ] || { echo "ERROR: falta /usr/local/sbin/hepta-drive-alta" >&2; exit 2; }

if ! python3 -c 'import fastapi, uvicorn' 2>/dev/null; then
  echo "Instalando FastAPI y uvicorn…"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-fastapi python3-uvicorn >/dev/null
fi
python3 -c 'import fastapi, uvicorn; print("fastapi", fastapi.__version__, "· uvicorn", uvicorn.__version__)'

install -d -m 700 "$CONF" /var/lib/hepta-drive/agente
install -d -m 755 /opt/hepta-drive/agente
install -m 644 "$ORIGEN/main.py" /opt/hepta-drive/agente/main.py

if [ ! -s "$CONF/cert.pem" ]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=hepta-drive-agente" \
    -addext "subjectAltName=IP:$IP" -keyout "$CONF/clave.pem" -out "$CONF/cert.pem" 2>/dev/null
  chmod 600 "$CONF/clave.pem"; chmod 644 "$CONF/cert.pem"
  echo "Certificado propio creado (10 años): $CONF/cert.pem"
fi

if [ ! -s "$CONF/agente.env" ]; then
  echo "Clave de la API del agente. Generala en KeePass (40 caracteres o más, letras y números) y pegala:"
  read -rsp "  DRIVE_API_KEY: " k; echo
  [[ "$k" =~ ^[A-Za-z0-9_-]{40,128}$ ]] || { echo "ERROR: tiene que tener de 40 a 128 letras, números, guion o guion bajo" >&2; exit 2; }
  ( umask 077; printf 'DRIVE_API_KEY=%s\nALLOWED_IPS=%s\n' "$k" "$PERMITIDOS" > "$CONF/agente.env" )
  unset k
  echo "Clave guardada en $CONF/agente.env (600)."
fi

install -m 644 "$ORIGEN/hepta-drive-agente.service" /etc/systemd/system/hepta-drive-agente.service
systemctl daemon-reload
systemctl enable -q hepta-drive-agente
systemctl restart hepta-drive-agente
sleep 2
systemctl is-active hepta-drive-agente
echo "Prueba: $(curl -s -m 5 --cacert "$CONF/cert.pem" "https://$IP:8888/health" || echo 'NO RESPONDE (ver: journalctl -u hepta-drive-agente -n 30)')"
echo "Huella del certificado: $(openssl x509 -in "$CONF/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"
