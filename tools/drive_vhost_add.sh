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
#   sudo ./drive_vhost_add.sh <slug> --dominio drive.cliente.com.py            suma el dominio propio del cliente
#   sudo ./drive_vhost_add.sh <slug> --dominio drive.cliente.com.py --probar   ensaya el certificado sin emitirlo
#   sudo ./drive_vhost_add.sh <slug> --quitar-dominio drive.cliente.com.py     lo quita (el certificado queda)
#
# El certificado es el de drive.hepta.com.py, que incluye *.drive.hepta.com.py: no hay que emitir uno por cliente.
# El dominio propio se SUMA: <slug>.drive.hepta.com.py sigue andando (las aplicaciones de los usuarios quedan atadas
# a la dirección con la que se conectaron). Necesita su certificado, que se pide por HTTP: el dominio ya tiene que
# apuntar acá (un CNAME a <slug>.drive.hepta.com.py). La renovación la hace certbot sola.
# Si algo falla (certificado o nginx -t), deja todo como estaba.
set -euo pipefail

UPSTREAM="${HD_UPSTREAM:-10.10.50.220}"
DOMINIO="${HD_DOMINIO:-drive.hepta.com.py}"
CERT="${HD_CERT:-/etc/letsencrypt/live/drive.hepta.com.py}"
SITIOS="${HD_NGINX:-/etc/nginx}"
NGINX="${HD_NGINX_BIN:-nginx}"

WEBROOT="${HD_WEBROOT:-/var/www/letsencrypt}"
CERTBOT="${HD_CERTBOT:-certbot}"
LIVE="${HD_LIVE:-/etc/letsencrypt/live}"

SLUG="${1:-}"; ARG2="${2:-}"; ARG3="${3:-}"; ARG4="${4:-}"
[[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]] || { sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
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

# ── Dominio propio del cliente ──
dominio_ok() {
  [ "${#1}" -le 253 ] && [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || return 1
  case "$1" in *hepta.com.py) return 1 ;; esac      # los nombres de HEPTA no se manejan por acá
}
if [ "$ARG2" = "--dominio" ] || [ "$ARG2" = "--quitar-dominio" ]; then
  PROPIO="$ARG3"
  dominio_ok "$PROPIO" || { echo "ERROR: dominio inválido (tiene que ser el nombre completo, por ejemplo drive.cliente.com.py)" >&2; exit 2; }
  CONFP="$SITIOS/sites-available/$PROPIO.conf"; ENLACEP="$SITIOS/sites-enabled/$PROPIO.conf"
  MARCA="# hepta-drive: $SLUG"
  # Un archivo con ese nombre que no es de este cliente no se toca
  if [ -e "$CONFP" ] && ! head -1 "$CONFP" | grep -qxF "$MARCA"; then
    echo "ERROR: ya hay un vhost para $PROPIO que no es del drive de $SLUG. No se toca." >&2; exit 1
  fi
  if [ "$ARG2" = "--quitar-dominio" ]; then
    [ -e "$CONFP" ] || [ -L "$ENLACEP" ] || { echo "No hay vhost de $PROPIO."; exit 0; }
    [ -L "$ENLACEP" ] && unlink "$ENLACEP"
    [ -e "$CONFP" ] && mv "$CONFP" "$CONFP.quitado-$(date +%Y%m%d_%H%M)"
    recargar && echo "Quitado: $PROPIO (el certificado queda; vence solo si no se renueva)."
    exit 0
  fi
  [ -e "$CONF" ] || { echo "ERROR: $FQDN todavía no está publicado; primero va el vhost normal" >&2; exit 1; }
  PUERTO="$(grep -o "proxy_pass http://$UPSTREAM:[0-9]*" "$CONF" | head -1 | grep -o '[0-9]*$')"
  [[ "$PUERTO" =~ ^8[0-9]{3}$ ]] || { echo "ERROR: no pude leer el puerto del vhost de $FQDN" >&2; exit 1; }

  PUERTO80="$MARCA
server {
    listen 80;
    server_name $PROPIO;
    location ^~ /.well-known/acme-challenge/ { root $WEBROOT; default_type text/plain; }
    location / { return 301 https://\$host\$request_uri; }
}"
  install -d -m 755 "$WEBROOT"
  PREVIO=""; [ -e "$CONFP" ] && { PREVIO="$CONFP.previo-$(date +%Y%m%d_%H%M%S)"; cp -p "$CONFP" "$PREVIO"; }
  deshacer() { if [ -n "$PREVIO" ]; then cp -p "$PREVIO" "$CONFP"; else [ -L "$ENLACEP" ] && unlink "$ENLACEP"; [ -e "$CONFP" ] && unlink "$CONFP"; fi; "$NGINX" -t >/dev/null 2>&1 && systemctl reload nginx || true; }

  # 1. Sin certificado todavía: se atiende solo el puerto 80, para la comprobación de Let's Encrypt
  if [ ! -s "$LIVE/$PROPIO/fullchain.pem" ] || [ "$ARG4" = "--probar" ]; then
    if [ -z "$PREVIO" ]; then
      echo "$PUERTO80" > "$CONFP"; ln -sfn "$CONFP" "$ENLACEP"
      if ! "$NGINX" -t >/dev/null 2>&1; then "$NGINX" -t 2>&1 | tail -3 || true; deshacer; echo "ERROR: nginx -t falló. Dejé todo como estaba." >&2; exit 1; fi
      systemctl reload nginx
    fi
    EXTRA=(); [ "$ARG4" = "--probar" ] && EXTRA=(--dry-run)
    if ! SALIDA="$("$CERTBOT" certonly --webroot -w "$WEBROOT" -d "$PROPIO" --non-interactive --agree-tos --keep-until-expiring "${EXTRA[@]}" 2>&1)"; then
      deshacer
      echo "ERROR: no se pudo obtener el certificado de $PROPIO. Lo más común: el dominio todavía no apunta acá. $(echo "$SALIDA" | grep -iE 'detail|error|problem|account' | head -3 | tr '\n' ' ' | cut -c1-300)" >&2
      exit 1
    fi
    if [ "$ARG4" = "--probar" ]; then deshacer; echo "OK (ensayo): el certificado de $PROPIO se puede emitir. No se cambió nada."; exit 0; fi
  fi
  [ -s "$LIVE/$PROPIO/fullchain.pem" ] || { deshacer; echo "ERROR: certbot terminó bien pero no encuentro el certificado en $LIVE/$PROPIO" >&2; exit 1; }

  # 2. Con certificado: el vhost completo, igual al del nombre de HEPTA
  echo "$PUERTO80
server {
    listen 443 ssl http2;
    server_name $PROPIO;

    ssl_certificate     $LIVE/$PROPIO/fullchain.pem;
    ssl_certificate_key $LIVE/$PROPIO/privkey.pem;

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
}" > "$CONFP"
  ln -sfn "$CONFP" "$ENLACEP"
  if "$NGINX" -t >/dev/null 2>&1; then
    systemctl reload nginx
    echo "OK: https://$PROPIO → $UPSTREAM:$PUERTO (además de https://$FQDN)"
  else
    "$NGINX" -t 2>&1 | tail -3 || true
    deshacer
    echo "ERROR: nginx -t falló. Dejé todo como estaba." >&2; exit 1
  fi
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
