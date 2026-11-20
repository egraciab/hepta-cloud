#!/usr/bin/env bash
#
# drive_vhost_add.sh — vhost de un cliente de HEPTA Drive (Nextcloud)
#
# Se corre EN LA VM DEL NGINX PERIMETRAL (dkr-hgsvrlnx003), como root. Crea el vhost igual al de
# drive.hepta.com.py, apuntando al puerto de la instancia del cliente en la VM hepta-drive.
#
#   sudo ./drive_vhost_add.sh <slug> <puerto>             crea  <slug>.drive.hepta.com.py → 10.10.50.220:<puerto>
#   sudo ./drive_vhost_add.sh <slug> <puerto> --dry-run   muestra el vhost y no toca nada
#   sudo ./drive_vhost_add.sh <slug> --quitar             lo quita
#
# El certificado es el de drive.hepta.com.py, que incluye *.drive.hepta.com.py: no hay que emitir uno por cliente.
# El dominio propio del cliente (drive.cliente.com.py) es otro paso, con su propio certificado.
# Si nginx -t falla, deja todo como estaba.
set -euo pipefail

UPSTREAM="${HD_UPSTREAM:-10.10.50.220}"
DOMINIO="${HD_DOMINIO:-drive.hepta.com.py}"
CERT="${HD_CERT:-/etc/letsencrypt/live/drive.hepta.com.py}"
SITIOS="${HD_NGINX:-/etc/nginx}"
NGINX="${HD_NGINX_BIN:-nginx}"

SLUG="${1:-}"; ARG2="${2:-}"; ARG3="${3:-}"
[[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]] || { sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
FQDN="$SLUG.$DOMINIO"
CONF="$SITIOS/sites-available/$FQDN.conf"; ENLACE="$SITIOS/sites-enabled/$FQDN.conf"

recargar() { "$NGINX" -t 2>&1 | tail -2 && systemctl reload nginx; }

if [ "$ARG2" = "--quitar" ]; then
  [ -e "$CONF" ] || [ -L "$ENLACE" ] || { echo "No hay vhost de $FQDN."; exit 0; }
  [ -L "$ENLACE" ] && unlink "$ENLACE"
  [ -e "$CONF" ] && mv "$CONF" "$CONF.quitado-$(date +%Y%m%d_%H%M)"
  recargar && echo "Quitado: $FQDN (el archivo quedó renombrado en sites-available)."
  exit 0
fi

PUERTO="$ARG2"
[[ "$PUERTO" =~ ^8[0-9]{3}$ ]] && [ "$PUERTO" -ge 8081 ] && [ "$PUERTO" -le 8199 ] || { echo "ERROR: el puerto tiene que estar entre 8081 y 8199" >&2; exit 2; }
[ -s "$CERT/fullchain.pem" ] || { echo "ERROR: no encuentro el certificado en $CERT" >&2; exit 1; }
if command -v openssl >/dev/null && ! openssl x509 -in "$CERT/fullchain.pem" -noout -ext subjectAltName 2>/dev/null | grep -q "\*\.$DOMINIO"; then
  echo "ERROR: el certificado de $CERT no incluye *.$DOMINIO" >&2; exit 1
fi

VHOST="server {
    listen 80;
    server_name $FQDN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl http2;
    server_name $FQDN;

    ssl_certificate     $CERT/fullchain.pem;
    ssl_certificate_key $CERT/privkey.pem;

    client_max_body_size 10G;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    add_header Strict-Transport-Security \"max-age=15552000\" always;

    location = /.well-known/carddav { return 301 /remote.php/dav/; }
    location = /.well-known/caldav  { return 301 /remote.php/dav/; }

    location / {
        proxy_pass http://$UPSTREAM:$PUERTO;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}"

if [ "$ARG3" = "--dry-run" ]; then echo "# $CONF"; echo "$VHOST"; exit 0; fi

# Otro vhost ya usa ese puerto: casi seguro es un error de tipeo
OTRO="$(grep -ls "proxy_pass http://$UPSTREAM:$PUERTO;" "$SITIOS"/sites-enabled/* 2>/dev/null | grep -v "/$FQDN.conf$" | head -1 || true)"
[ -z "$OTRO" ] || { echo "ERROR: el puerto $PUERTO ya lo usa $OTRO" >&2; exit 1; }

PREVIO=""; [ -e "$CONF" ] && { PREVIO="$CONF.previo-$(date +%Y%m%d_%H%M%S)"; cp -p "$CONF" "$PREVIO"; }
echo "$VHOST" > "$CONF"
ln -sfn "$CONF" "$ENLACE"
if "$NGINX" -t >/dev/null 2>&1; then
  systemctl reload nginx
  echo "OK: https://$FQDN → $UPSTREAM:$PUERTO"
  echo "Probar: curl -sI https://$FQDN/status.php | head -1    (tiene que dar 200; si no resuelve, falta el DNS)"
else
  "$NGINX" -t 2>&1 | tail -3 || true
  if [ -n "$PREVIO" ]; then cp -p "$PREVIO" "$CONF"; else unlink "$ENLACE"; unlink "$CONF"; fi
  echo "ERROR: nginx -t falló. Dejé todo como estaba." >&2; exit 1
fi
