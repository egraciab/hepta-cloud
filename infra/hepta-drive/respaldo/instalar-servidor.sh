#!/usr/bin/env bash
# instalar-servidor.sh — se corre UNA vez dentro del contenedor hepta-respaldo (servidor de respaldos de HEPTA Drive).
# Se puede volver a correr: no pisa el certificado, los usuarios ni los repositorios.
#
#   instalar-servidor.sh <IP del servidor>      por ejemplo: instalar-servidor.sh 10.10.10.20
#
# Deja: restic y rest-server instalados, el usuario "restic" dueño de /srv/restic (volumen del pool ceph-hdd),
# un certificado propio para esa IP, el servicio hepta-rest-server (solo agregar, un usuario por cliente, TLS,
# puerto 8000) y el mantenimiento diario programado.
set -euo pipefail

IP="${1:-}"
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Uso: $0 <IP del servidor>" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ=/srv/restic; CONF=/etc/hepta-respaldo
# rest-server no está en los paquetes de Ubuntu 24.04: se baja la versión fijada y se compara su suma.
RS_VERSION=0.12.1
RS_SHA256=58f886043c62b7908a1b8b684e0d2388dfaabecaf2fbcd3e0aaa5a3be2f2306f
RS_URL="https://github.com/restic/rest-server/releases/download/v$RS_VERSION/rest-server_${RS_VERSION}_linux_amd64.tar.gz"

paso() { echo; echo "── $*"; }

mountpoint -q "$RAIZ" || { echo "ERROR: $RAIZ no es un volumen montado. Sin el volumen de ceph-hdd los respaldos caerían en el disco del contenedor." >&2; exit 2; }

paso "Paquetes"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q restic apache2-utils cron openssl curl ca-certificates
systemctl enable --now cron >/dev/null

paso "rest-server $RS_VERSION"
if /usr/local/bin/rest-server --version 2>/dev/null | grep -q "rest-server $RS_VERSION "; then
  echo "ya estaba instalado"
else
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/rs.tgz" "$RS_URL"
  echo "$RS_SHA256  $TMP/rs.tgz" | sha256sum -c -
  tar -xzf "$TMP/rs.tgz" -C "$TMP" --strip-components=1
  install -m 755 "$TMP/rest-server" /usr/local/bin/rest-server
  /usr/local/bin/rest-server --version
fi

paso "Usuario y carpetas"
id restic >/dev/null 2>&1 || useradd --system --home-dir "$RAIZ" --no-create-home --shell /usr/sbin/nologin restic
chown restic:restic "$RAIZ"; chmod 750 "$RAIZ"
install -d -m 750 -o root -g restic "$CONF" "$CONF/tls"
install -d -m 700 -o root -g root "$CONF/claves"
[ -f "$CONF/htpasswd" ] || install -m 640 -o root -g restic /dev/null "$CONF/htpasswd"

paso "Certificado propio para $IP"
if [ -s "$CONF/tls/cert.pem" ] && [ -s "$CONF/tls/key.pem" ]; then
  echo "ya existe (vence: $(openssl x509 -in "$CONF/tls/cert.pem" -noout -enddate | cut -d= -f2))"
  openssl x509 -in "$CONF/tls/cert.pem" -noout -ext subjectAltName | grep -q "$IP" || echo "AVISO: el certificado que hay NO es para $IP"
else
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=hepta-respaldo" \
    -addext "subjectAltName=IP:$IP" -keyout "$CONF/tls/key.pem" -out "$CONF/tls/cert.pem" 2>/dev/null
  chown root:restic "$CONF/tls/key.pem" "$CONF/tls/cert.pem"; chmod 640 "$CONF/tls/key.pem"; chmod 644 "$CONF/tls/cert.pem"
  echo "creado, vale 10 años"
fi

paso "Servicio"
cat > /etc/systemd/system/hepta-rest-server.service <<UNIT
[Unit]
Description=HEPTA Drive: servidor de respaldos (rest-server, solo agregar)
After=network-online.target
Wants=network-online.target
RequiresMountsFor=$RAIZ

[Service]
User=restic
Group=restic
ExecStart=/usr/local/bin/rest-server --path $RAIZ --listen :8000 --append-only --private-repos --tls --tls-cert $CONF/tls/cert.pem --tls-key $CONF/tls/key.pem --htpasswd-file $CONF/htpasswd
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
install -m 755 "$AQUI/hepta-respaldo-repos.sh" /usr/local/sbin/hepta-respaldo-repos
systemctl daemon-reload
systemctl enable hepta-rest-server >/dev/null 2>&1
systemctl restart hepta-rest-server
sleep 2
systemctl is-active hepta-rest-server

paso "Mantenimiento diario (09:00 UTC = 06:00 de Paraguay, después de la copia de la noche)"
echo '0 9 * * * root /usr/local/sbin/hepta-respaldo-repos mantener >> /var/log/hepta-respaldo.log 2>&1' > /etc/cron.d/hepta-respaldo
cat /etc/cron.d/hepta-respaldo

paso "Prueba"
COD="$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CONF/tls/cert.pem" "https://$IP:8000/" || true)"
if [ "$COD" = 401 ]; then echo "OK: responde por TLS y pide usuario (401)."; else echo "ERROR: esperaba 401 y respondió '$COD'"; exit 1; fi
df -h "$RAIZ" | tail -1
echo
echo "Listo. Sigue: hepta-respaldo-repos alta <cliente>"
