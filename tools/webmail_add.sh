#!/usr/bin/env bash
#
# webmail_add.sh — webmail con marca propia para un cliente de HEPTA Cloud
#
# Se corre EN LA VM DEL NGINX PERIMETRAL (no en la de HEPTA Cloud, no en el
# contenedor). Crea el vhost, saca el certificado por DNS-01 y deja listo el
# directorio de branding para ese cliente.
#
#   sudo ./webmail_add.sh mail.adelanta.com.py
#   sudo ./webmail_add.sh mail.adelanta.com.py --modo redirect
#   sudo ./webmail_add.sh mail.adelanta.com.py --dry-run
#   sudo ./webmail_add.sh mail.adelanta.com.py --quitar
#
# Opciones:
#   --modo proxy|redirect   proxy (default): la URL del cliente se mantiene y
#                           se puede personalizar el logo.
#                           redirect: manda a nuestro webmail genérico. Más
#                           simple, pero el cliente ve mail.hepta.com.py.
#   --con-admin             deja pasar TODO, incluida la interfaz de mailcow.
#                           Por defecto el host del cliente sirve solo el webmail:
#                           la raiz redirige a /SOGo/ y la UI de administracion
#                           queda fuera de alcance. Usá esta opcion solo para
#                           nuestro propio host.
#   --upstream IP           IP interna del mailcow      (default 192.168.10.213)
#   --base FQDN             nombre canónico del mailcow (default mail.hepta.com.py)
#   --cf-ini RUTA           credenciales de Cloudflare  (default /etc/letsencrypt/cloudflare.ini)
#   --hc URL                base de HEPTA Cloud         (default https://cloud.hepta.com.py)
#                           De ahí sale el CSS de marca del cliente: el logo y
#                           los colores se cargan desde Admin > Correo > Gestión,
#                           no hay archivos de branding en esta máquina.
#   --dry-run               muestra todo sin escribir ni pedir certificado
#   --quitar                elimina el vhost de ese host y recarga
#
set -euo pipefail

HOST=""
MODO="proxy"
UPSTREAM="192.168.10.213"
BASE="mail.hepta.com.py"
CF_INI="/etc/letsencrypt/cloudflare.ini"
HC="https://cloud.hepta.com.py"
DRY=0
QUITAR=0
SOLO_WEBMAIL=1

SITES="/etc/nginx/sites-available"
ENABLED="/etc/nginx/sites-enabled"
SNIPPETS="/etc/nginx/snippets"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --modo)     MODO="$2"; shift 2 ;;
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --base)     BASE="$2"; shift 2 ;;
    --cf-ini)   CF_INI="$2"; shift 2 ;;
    --hc)       HC="${2%/}"; shift 2 ;;
    --con-admin) SOLO_WEBMAIL=0; shift ;;
    --dry-run)  DRY=1; shift ;;
    --quitar)   QUITAR=1; shift ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    -*)         rojo "Opción desconocida: $1"; exit 1 ;;
    *)          HOST="$1"; shift ;;
  esac
done

[[ -n "$HOST" ]] || { rojo "Falta el host del webmail. Ej: sudo $0 mail.adelanta.com.py"; exit 1; }
[[ "$HOST" == *.*.* || "$HOST" == *.* ]] || { rojo "Host inválido: $HOST"; exit 1; }
[[ "$MODO" == "proxy" || "$MODO" == "redirect" ]] || { rojo "--modo debe ser proxy o redirect"; exit 1; }

VHOST="$SITES/webmail-$HOST.conf"
SNIPPET="$SNIPPETS/webmail-$HOST.conf"

# ─────────────────────────────────────────────────────── quitar
if [[ $QUITAR -eq 1 ]]; then
  echo "== Quitando $HOST =="
  if [[ $DRY -eq 1 ]]; then
    info "[dry-run] borraría $VHOST, $SNIPPET y $ENABLED/webmail-$HOST.conf"
    exit 0
  fi
  rm -f "$ENABLED/webmail-$HOST.conf" "$VHOST" "$SNIPPET"
  nginx -t && systemctl reload nginx
  verde "Listo. El certificado queda: borralo con  certbot delete --cert-name $HOST"
  exit 0
fi

# ─────────────────────────────────────────────── verificaciones
echo "== Verificando el entorno =="
FALLO=0

command -v nginx >/dev/null || { rojo "  ! No encuentro nginx: ¿estás en la VM del Nginx perimetral?"; FALLO=1; }

if command -v nginx >/dev/null && [[ "$MODO" == "proxy" ]]; then
  if nginx -V 2>&1 | grep -q -- --with-http_sub_module; then
    info "sub_module presente (hace falta para el logo por cliente)"
  else
    rojo "  ! Este nginx no tiene http_sub_module: el proxy funciona, pero no vas a poder"
    rojo "    inyectar el logo del cliente. En Debian/Ubuntu: apt install nginx-extras"
  fi
fi

command -v certbot >/dev/null || { rojo "  ! No encuentro certbot"; FALLO=1; }

# `http2 on;` es directiva propia recién desde nginx 1.25.1. Antes, HTTP/2 se
# activa como opción del listen. Escribir la sintaxis equivocada hace fallar
# el nginx -t con "unknown directive http2".
LISTEN4="listen 443 ssl;"
LISTEN6="listen [::]:443 ssl;"
HTTP2_LINE="    http2 on;"
NGX_VER="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9][0-9.]*\).*#\1#p' || true)"
if [[ -n "$NGX_VER" ]]; then
  if [[ "$(printf '%s\n1.25.1\n' "$NGX_VER" | sort -V | head -1)" == "1.25.1" ]]; then
    info "nginx $NGX_VER: uso 'http2 on;'"
  else
    LISTEN4="listen 443 ssl http2;"
    LISTEN6="listen [::]:443 ssl http2;"
    HTTP2_LINE=""
    info "nginx $NGX_VER: HTTP/2 va como opción del listen (sintaxis previa a 1.25.1)"
  fi
else
  info "No pude leer la versión de nginx: uso la sintaxis previa a 1.25.1, que es compatible con ambas"
  LISTEN4="listen 443 ssl http2;"
  LISTEN6="listen [::]:443 ssl http2;"
  HTTP2_LINE=""
fi
[[ -f "$CF_INI" ]] || { rojo "  ! No encuentro las credenciales de Cloudflare en $CF_INI (usá --cf-ini)"; FALLO=1; }

# El CNAME tiene que estar publicado ANTES, y SIN el proxy de Cloudflare.
# Con la nube naranja, Cloudflare termina el TLS con su propio certificado y
# el webmail queda fuera de tu control (además de romper todo lo que no sea HTTP).
es_cloudflare() {
  case "$1" in
    104.1[6-9].*|104.2[0-9].*|104.3[01].*|172.6[4-9].*|172.7[01].*|2606:4700:*|2803:f800:*) return 0 ;;
    *) return 1 ;;
  esac
}

DESTINO="$(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1}' | head -1 || true)"
[[ -n "$DESTINO" ]] || DESTINO="$(getent hosts "$HOST" | awk '{print $1}' | head -1 || true)"
ESPERADO="$(getent ahostsv4 "$BASE" 2>/dev/null | awk '{print $1}' | head -1 || true)"
[[ -n "$ESPERADO" ]] || ESPERADO="$(getent hosts "$BASE" | awk '{print $1}' | head -1 || true)"

if [[ -z "$DESTINO" ]]; then
  rojo "  ! $HOST todavía no resuelve. Publicá el CNAME hacia $BASE (nube GRIS en Cloudflare)."
  FALLO=1
elif es_cloudflare "$DESTINO"; then
  rojo "  ! $HOST resuelve a $DESTINO, que es una IP de Cloudflare:"
  rojo "    el registro está con el PROXY ACTIVADO (nube naranja)."
  rojo "    Ponela en GRIS en Cloudflare y esperá un minuto. Con la nube naranja,"
  rojo "    Cloudflare presenta su propio certificado y el webmail no llega a tu Nginx."
  FALLO=1
elif [[ "$DESTINO" != "$ESPERADO" ]]; then
  rojo "  ! $HOST resuelve a $DESTINO pero $BASE resuelve a $ESPERADO."
  rojo "    Revisá que el CNAME apunte a $BASE."
  FALLO=1
else
  info "$HOST -> $DESTINO (coincide con $BASE, sin proxy)"
fi

if [[ $FALLO -eq 1 && $DRY -eq 0 ]]; then
  rojo "Corregí lo de arriba y volvé a correrlo (o probá con --dry-run)."
  exit 1
fi

# ────────────────────────────────────────────────── certificado
echo
echo "== Certificado =="
CERT_DIR="/etc/letsencrypt/live/$HOST"
if [[ -d "$CERT_DIR" ]]; then
  info "Ya existe $CERT_DIR, lo reutilizo"
elif [[ $DRY -eq 1 ]]; then
  info "[dry-run] pediría: certbot certonly --dns-cloudflare -d $HOST"
else
  info "Pidiendo certificado por DNS-01 (no necesita el puerto 80)..."
  certbot certonly \
    --dns-cloudflare \
    --dns-cloudflare-credentials "$CF_INI" \
    --dns-cloudflare-propagation-seconds 30 \
    -d "$HOST" \
    --non-interactive --agree-tos \
    --deploy-hook "systemctl reload nginx"
fi

# ──────────────────────────────────────────────────────── vhost
echo
echo "== vhost =="

if [[ "$MODO" == "redirect" ]]; then
  IFS= read -r -d '' CONF <<CONFEOF || true
# webmail de $HOST — modo redirect (generado por webmail_add.sh)
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    return 301 https://\$host\$request_uri;
}

server {
    $LISTEN4
    $LISTEN6
$HTTP2_LINE
    server_name $HOST;

    ssl_certificate     /etc/letsencrypt/live/$HOST/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$HOST/privkey.pem;

    return 301 https://$BASE/SOGo/;
}
CONFEOF
else
  # Las directivas del proxy van a un snippet aparte para no repetirlas en cada
  # location cuando restringimos el host a solo-webmail.
  #
  # ?admin=1 le avisa a HEPTA Cloud que este host SI puede administrar, para que
  # no esconda los enlaces "Iniciar sesion como administrador" del login.
  CSS_Q=""; [[ $SOLO_WEBMAIL -eq 0 ]] && CSS_Q="?admin=1"
  IFS= read -r -d '' PROXY <<PROXYEOF || true
# proxy hacia mailcow para $HOST (generado por webmail_add.sh)
proxy_pass https://$UPSTREAM;

# Sin estas dos, el TLS hacia mailcow falla por nombre de certificado
proxy_ssl_server_name on;
proxy_ssl_name $BASE;

proxy_set_header Host              \$host;
proxy_set_header X-Real-IP         \$remote_addr;
proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto \$scheme;

# Branding del cliente: lo sirve HEPTA Cloud desde la base de datos,
# así el logo se cambia desde el admin sin tocar este servidor.
# sub_filter no puede tocar HTML comprimido, por eso vaciamos Accept-Encoding.
proxy_set_header Accept-Encoding "";
sub_filter '</head>' '<link rel="stylesheet" href="$HC/api/public/mail-branding/$HOST.css$CSS_Q"><script defer src="$HC/api/public/mail-branding/$HOST.js"></script></head>';
sub_filter_once on;
# sub_filter_types ya incluye text/html por defecto: declararlo avisa
# "duplicate MIME type" en el nginx -t.

proxy_http_version 1.1;                    # SOGo usa websockets
proxy_set_header Upgrade    \$http_upgrade;
proxy_set_header Connection "upgrade";

proxy_read_timeout 300s;
proxy_buffering off;
PROXYEOF

  if [[ $SOLO_WEBMAIL -eq 1 ]]; then
    IFS= read -r -d '' LOCATIONS <<LOCEOF || true
    # Host de cliente: se bloquea la superficie de administracion de mailcow,
    # el resto pasa. Es a proposito al reves de una lista blanca: mailcow
    # necesita muchas rutas para que el login de una casilla funcione
    # (/, /user, /edit/..., /cache/..., /qhandler/..., /logout, estaticos,
    # /SOGo/...), y olvidar una sola rompe el acceso del cliente.
    #
    # No hace falta redirigir / a /SOGo: mailcow ya manda a /SOGo/so/ al
    # entrar con una casilla. Y / tiene que servir el login — es justamente
    # la pantalla que lleva el logo del cliente.
    #
    # OJO: esto reduce superficie, no reemplaza autenticacion. Quien tenga la
    # clave de admin sigue entrando por $BASE; lo que se logra acá es que la
    # UI de administracion no exista bajo la marca del cliente.
    # /api/v1/ NO se bloquea: la propia UI de mailcow la usa con la sesion del
    # usuario (p.ej. /api/v1/get/passwordpolicy/html en el login). Bloquearla
    # rompe la pantalla del cliente. El acceso por API key sigue protegido por
    # la restriccion de IP de la key en mailcow.
    location ^~ /admin        { return 404; }   # panel de administrador
    location ^~ /domainadmin  { return 404; }   # panel de admin de dominio
    location ^~ /rspamd       { return 404; }   # UI de rspamd
    location ^~ /debug        { return 404; }

    location / { include $SNIPPET; }
LOCEOF
  else
    IFS= read -r -d '' LOCATIONS <<LOCEOF || true
    location / { include $SNIPPET; }
LOCEOF
  fi

  IFS= read -r -d '' CONF <<CONFEOF || true
# webmail de $HOST — modo proxy con branding (generado por webmail_add.sh)
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    return 301 https://\$host\$request_uri;
}

server {
    $LISTEN4
    $LISTEN6
$HTTP2_LINE
    server_name $HOST;

    ssl_certificate     /etc/letsencrypt/live/$HOST/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$HOST/privkey.pem;

    client_max_body_size 0;          # adjuntos grandes: el límite lo pone mailcow

$LOCATIONS
}
CONFEOF
fi

if [[ $DRY -eq 1 ]]; then
  if [[ "$MODO" == "proxy" ]]; then
    info "[dry-run] escribiría $SNIPPET con las directivas del proxy:"
    echo
    echo "$PROXY" | sed 's/^/    /'
    echo
  fi
  info "[dry-run] escribiría $VHOST con este contenido:"
  echo
  echo "$CONF" | sed 's/^/    /'
  echo
  info "[dry-run] y después: ln -s, nginx -t, systemctl reload nginx"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ "$MODO" == "proxy" ]]; then
  mkdir -p "$SNIPPETS"
  [[ -f "$SNIPPET" ]] && cp "$SNIPPET" "$SNIPPET.bak-$STAMP"
  echo "$PROXY" > "$SNIPPET"
  verde "  + $SNIPPET"
else
  # En modo redirect no hay proxy: si quedó un snippet de una corrida anterior, lo saco.
  rm -f "$SNIPPET"
fi

if [[ -f "$VHOST" ]]; then
  cp "$VHOST" "$VHOST.bak-$STAMP"
  info "Respaldo del vhost anterior guardado"
fi
echo "$CONF" > "$VHOST"
ln -sf "$VHOST" "$ENABLED/webmail-$HOST.conf"
verde "  + $VHOST"

echo
echo "== Probando la configuración =="
if nginx -t; then
  systemctl reload nginx
  verde "Nginx recargado."
else
  rojo "nginx -t falló: NO recargué nada. Revisá el error de arriba."
  exit 1
fi

echo
verde "Listo: https://$HOST"
if [[ "$MODO" == "proxy" ]]; then
  if [[ $SOLO_WEBMAIL -eq 1 ]]; then
    info "Este host sirve SOLO el webmail: la raíz redirige a /SOGo/ y la UI de mailcow no se expone."
  else
    info "Este host deja pasar TODO, incluida la UI de administración de mailcow (--con-admin)."
  fi
fi
echo
echo "Ahora, desde HEPTA Cloud (Admin > Correo > Gestión, en este dominio):"
echo "   1. cargá el host del webmail: $HOST"
echo "   2. subí el logo del cliente y elegí el color"
if [[ "$MODO" == "proxy" ]]; then
  echo
  echo "El CSS de marca sale de $HC/api/public/mail-branding/$HOST.css"
  echo "y cachea 5 minutos: después de cambiar el logo, Ctrl+Shift+R."
fi
