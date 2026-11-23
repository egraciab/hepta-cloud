#!/usr/bin/env bash
#
# tenant_nginx.sh — lo que la API perimetral necesita hacer como root para los tenants de HEPTA ERP
#
# Se instala EN LA VM DEL NGINX PERIMETRAL (dkr-hgsvrlnx003) como /usr/local/sbin/hepta-tenant-nginx, de root y
# 755. La API (usuario www-data) lo corre por sudo y no puede correr nada más que esto y el script del drive: antes
# tenía sudo para nginx, certbot, tee, ln y rm con cualquier argumento, que en la práctica era root.
#
#   hepta-tenant-nginx suspender <tenant>                  las visitas van a la página de aviso de Hepta Cloud
#   hepta-tenant-nginx reactivar <tenant>                  vuelve a responder
#   hepta-tenant-nginx vhost <dominio> <db> [correo]       dominio propio: vhost, certificado por DNS de Cloudflare
#                       [--sin-suspender]                  y, salvo --sin-suspender, suspende <tenant>.erp.hepta.com.py
#   hepta-tenant-nginx quitar-vhost <dominio>              quita un vhost creado por este script
#   hepta-tenant-nginx rehacer-suspendidas                 reescribe las ya suspendidas con el formato actual
#   hepta-tenant-nginx probar                              valida la configuración de nginx (no cambia nada)
#
# <tenant> y <db>: el nombre de la base (prueba) o con el dominio de HEPTA (prueba.erp.hepta.com.py).
# Todo valida sus argumentos y, si nginx -t falla, deja todo como estaba. La última línea de la salida dice el
# resultado; en "vhost" es "ssl=si" o "ssl=no" (el vhost queda andando por HTTP hasta que el DNS apunte bien).
set -euo pipefail

BASE="${HT_BASE:-erp.hepta.com.py}"
SITIOS="${HT_NGINX:-/etc/nginx}"
SUSP="${HT_SUSPENDIDOS:-/etc/nginx/hepta-suspended}"
NGINX="${HT_NGINX_BIN:-nginx}"
CERTBOT="${HT_CERTBOT:-certbot}"
RECARGAR="${HT_RECARGAR:-systemctl reload nginx}"
CF_CRED="${HT_CF_CRED:-/etc/letsencrypt/cloudflare/credentials.ini}"
LIVE="${HT_LIVE:-/etc/letsencrypt/live}"
CORREO_DEF="${HT_CORREO:-admin@hepta.com.py}"
AVISO="${HT_AVISO:-https://cloud.hepta.com.py/suspendida}"
CANDADO="${HT_CANDADO:-/run/hepta-tenant-nginx.candado}"

uso() { sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
error() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || error "corré como root"

# ── Validaciones ──
NOMBRE_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
tenant_de() {   # prueba | prueba.erp.hepta.com.py → prueba
  local v="${1,,}"; v="${v%."$BASE"}"
  [[ "$v" =~ $NOMBRE_RE ]] || return 1
  echo "$v"
}
dominio_ok() {
  [ "${#1}" -le 253 ] && [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || return 1
  case "$1" in www.*|*hepta.com.py) return 1 ;; esac   # el www. lo suma el vhost; los nombres de HEPTA no van por acá
}
correo_ok() { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]]; }

# Un cambio de nginx por vez (la API puede recibir dos pedidos juntos)
exec 9>"$CANDADO"; flock -w 60 9 || error "hay otro cambio de nginx en curso"

valida() { "$NGINX" -t >/dev/null 2>&1; }
recargar() { $RECARGAR; }

# ── Suspensión ──
susp_conf() { echo "$SUSP/$1.$BASE.conf"; }
suspender() {
  local t="$1" f; f="$(susp_conf "$t")"
  mkdir -p "$SUSP"
  local tmp; tmp="$(mktemp "$SUSP/.nuevo.XXXXXX")"
  # Las visitas van a la página de aviso de Hepta Cloud (servicio en pausa, datos a salvo, cómo reactivar)
  printf '# Suspendido por Hepta Cloud — %s\n# tenant: %s\nif ($host = "%s.%s") {\n    return 302 %s?i=%s;\n}\n' \
    "$(date -u +%FT%TZ)" "$t" "$t" "$BASE" "$AVISO" "$t" > "$tmp"
  chmod 644 "$tmp"
  local previo=""; [ -e "$f" ] && { previo="$(mktemp)"; cp -p "$f" "$previo"; }
  mv "$tmp" "$f"
  if ! valida; then
    if [ -n "$previo" ]; then mv "$previo" "$f"; else unlink "$f"; fi
    error "nginx -t falló; no se suspendió $t"
  fi
  [ -n "$previo" ] && unlink "$previo"
  recargar
  echo "suspendida: $t.$BASE"
}
reactivar() {
  local t="$1" f; f="$(susp_conf "$t")"
  [ -e "$f" ] || { echo "no estaba suspendida: $t.$BASE"; return 0; }
  local previo; previo="$(mktemp)"; cp -p "$f" "$previo"; unlink "$f"
  if ! valida; then mv "$previo" "$f"; error "nginx -t falló; $t sigue suspendida"; fi
  unlink "$previo"
  recargar
  echo "reactivada: $t.$BASE"
}

# ── Dominio propio de un tenant ──
bloques() {   # $1 dominio, $2 host interno, $3 http|https
  local d="$1" h="$2"
  local proxy="        proxy_set_header Host $h;
        proxy_set_header X-Forwarded-Host $h;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP \$remote_addr;"
  local loc="    client_max_body_size 100m;

    location / {
        proxy_pass http://odoo19_backend;
$proxy
        proxy_read_timeout 720s;
        proxy_connect_timeout 720s;
        proxy_send_timeout 720s;
    }

    location /websocket {
        proxy_pass http://odoo19_evented;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
$proxy
        proxy_read_timeout 720s;
        proxy_send_timeout 720s;
    }"
  if [ "$3" = https ]; then
    cat <<EOF
server {
    listen 443 ssl;
    server_name $d www.$d;
    ssl_certificate     $LIVE/$d/fullchain.pem;
    ssl_certificate_key $LIVE/$d/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

$loc
}

server {
    listen 80;
    server_name $d www.$d;
    return 301 https://\$host\$request_uri;
}
EOF
  else
    cat <<EOF
server {
    listen 80;
    server_name $d www.$d;

$loc
}
EOF
  fi
}

vhost() {
  local d="$1" t="$2" correo="$3" suspender_sub="$4"
  local h="$t.$BASE" conf="$SITIOS/sites-available/$d.conf" enlace="$SITIOS/sites-enabled/$d.conf"
  local marca="# hepta-tenant: $t"
  # Un vhost con ese nombre que no creó este script, o que es de otro tenant, no se toca
  if [ -e "$conf" ] && ! head -1 "$conf" | grep -qxF "$marca"; then
    error "ya hay un vhost para $d que no es del tenant $t (o lo creó la API vieja). No se toca: revisarlo a mano."
  fi
  local previo=""; [ -e "$conf" ] && { previo="$(mktemp)"; cp -p "$conf" "$previo"; }
  deshacer() {
    if [ -n "$previo" ]; then cp -p "$previo" "$conf"; else [ -L "$enlace" ] && unlink "$enlace"; [ -e "$conf" ] && unlink "$conf"; fi
    valida && recargar || true
  }
  escribir() { { echo "$marca"; bloques "$d" "$h" "$1"; } > "$conf.nuevo"; chmod 644 "$conf.nuevo"; mv "$conf.nuevo" "$conf"; }

  # 1. Por HTTP (lo que haya andando sigue igual si ya tenía certificado)
  if [ -s "$LIVE/$d/fullchain.pem" ]; then escribir https; else escribir http; fi
  [ -L "$enlace" ] || ln -s "$conf" "$enlace"
  valida || { deshacer; error "nginx -t falló con el vhost de $d; dejé todo como estaba"; }
  recargar

  # 2. Certificado por DNS de Cloudflare (no necesita que el dominio ya apunte acá)
  local ssl=no registro; registro="$(mktemp)"
  if [ -s "$LIVE/$d/fullchain.pem" ]; then
    ssl=si
  elif [ -r "$CF_CRED" ]; then
    if timeout 150 "$CERTBOT" certonly --dns-cloudflare --dns-cloudflare-credentials "$CF_CRED" \
         --dns-cloudflare-propagation-seconds 20 -d "$d" -d "www.$d" \
         --non-interactive --agree-tos --keep-until-expiring --email "$correo" >"$registro" 2>&1; then
      ssl=si
    else
      echo "certbot no pudo: $(tail -3 "$registro" | tr '\n' ' ' | cut -c1-280)"
    fi
  else
    echo "falta la credencial de Cloudflare ($CF_CRED): sin certificado"
  fi
  unlink "$registro"

  # 3. Con certificado, el vhost pasa a HTTPS
  if [ "$ssl" = si ] && ! grep -q 'listen 443' "$conf"; then
    local http; http="$(mktemp)"; cp -p "$conf" "$http"
    escribir https
    if ! valida; then cp -p "$http" "$conf"; valida && recargar || true; ssl=no; echo "nginx -t falló con HTTPS: quedó por HTTP"; else recargar; fi
    unlink "$http"
  fi
  [ -n "$previo" ] && unlink "$previo"

  # 4. El subdominio de HEPTA deja de responder (el cliente entra solo por su dominio)
  if [ "$suspender_sub" = si ]; then suspender "$t"; fi
  echo "vhost: $d → $h"
  echo "ssl=$ssl"
}

quitar_vhost() {
  local d="$1" conf="$SITIOS/sites-available/$1.conf" enlace="$SITIOS/sites-enabled/$1.conf"
  [ -e "$conf" ] || [ -L "$enlace" ] || { echo "no hay vhost de $d"; return 0; }
  head -1 "$conf" 2>/dev/null | grep -q '^# hepta-tenant: ' || error "el vhost de $d no lo creó este script. No se toca: quitarlo a mano."
  [ -L "$enlace" ] && unlink "$enlace"
  mv "$conf" "$conf.quitado-$(date +%Y%m%d_%H%M)"
  valida || error "nginx -t falla después de quitar $d (revisar a mano)"
  recargar
  echo "quitado: $d (el archivo quedó renombrado en sites-available)"
}

# ── Verbos ──
case "${1:-}" in
  suspender|reactivar)
    t="$(tenant_de "${2:-}")" || error "tenant inválido"
    "$1" "$t" ;;
  vhost)
    d="${2:-}"; d="${d,,}"
    dominio_ok "$d" || error "dominio inválido (sin www. y sin los nombres de HEPTA, por ejemplo cliente.com.py)"
    t="$(tenant_de "${3:-}")" || error "db inválida"
    correo="$CORREO_DEF"; sub=si
    for a in "${@:4}"; do
      case "$a" in
        --sin-suspender) sub=no ;;
        *) correo_ok "$a" || error "correo inválido"; correo="$a" ;;
      esac
    done
    vhost "$d" "$t" "$correo" "$sub" ;;
  quitar-vhost)
    d="${2:-}"; d="${d,,}"; dominio_ok "$d" || error "dominio inválido"
    quitar_vhost "$d" ;;
  rehacer-suspendidas)
    # Vuelve a escribir los fragmentos de las ya suspendidas con el formato actual (página de aviso)
    n=0; for f in "$SUSP"/*."$BASE".conf; do
      [ -e "$f" ] || continue
      t="$(basename "$f" ".$BASE.conf")"; t="$(tenant_de "$t")" || { echo "se saltea $f (nombre raro)"; continue; }
      suspender "$t" >/dev/null && n=$((n + 1))
    done
    echo "rehechas: $n" ;;
  probar)
    valida && echo "nginx -t: OK" || error "nginx -t falla" ;;
  *) uso ;;
esac
