#!/usr/bin/env bash
#
# tenant_nginx.sh — lo que la API perimetral necesita hacer como root para los tenants de HEPTA ERP
#
# Se instala EN LA VM DEL NGINX PERIMETRAL (dkr-hgsvrlnx003) como /usr/local/sbin/hepta-tenant-nginx, de root y
# 755. La API (usuario www-data) lo corre por sudo y no puede correr nada más que esto y el script del drive: antes
# tenía sudo para nginx, certbot, tee, ln y rm con cualquier argumento, que en la práctica era root.
#
#   hepta-tenant-nginx suspender <tenant>                  las visitas (subdominio y dominio propio) van al aviso
#   hepta-tenant-nginx reactivar <tenant>                  vuelve a responder
#   hepta-tenant-nginx vhost <dominio> <db> [correo]       dominio propio: vhost, certificado por DNS de Cloudflare
#                       [--sin-suspender]                  y, salvo --sin-suspender, el subdominio manda al dominio
#   hepta-tenant-nginx quitar-vhost <dominio>              quita un vhost creado por este script
#   hepta-tenant-nginx listar                              las suspendidas (no cuenta las que pasaron a su dominio)
#   hepta-tenant-nginx enganchar <dominio> <tenant> [--probar]   vhost de dominio propio que ya existía: que lo
#                                                          corte la suspensión y el subdominio mande al dominio
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
SUSPD="${HT_SUSP_DOMINIOS:-/etc/nginx/hepta-suspended-dominios}"
NGINX="${HT_NGINX_BIN:-nginx}"
CERTBOT="${HT_CERTBOT:-certbot}"
RECARGAR="${HT_RECARGAR:-systemctl reload nginx}"
CF_CRED="${HT_CF_CRED:-/etc/letsencrypt/cloudflare/credentials.ini}"
LIVE="${HT_LIVE:-/etc/letsencrypt/live}"
CORREO_DEF="${HT_CORREO:-admin@hepta.com.py}"
AVISO="${HT_AVISO:-https://cloud.hepta.com.py/suspendida}"
CANDADO="${HT_CANDADO:-/run/hepta-tenant-nginx.candado}"

uso() { sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
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
# Dos fragmentos por tenant:
#   $SUSP/<t>.erp.hepta.com.py.conf   lo incluye el server del comodín *.erp.hepta.com.py. Es de un tipo:
#        suspendido → manda a la página de aviso · migrado → manda al dominio propio del cliente (301)
#   $SUSPD/<t>.conf                   lo incluyen los vhosts del dominio propio de ese tenant: existe solo
#        mientras está suspendido, y manda a la página de aviso sin mirar el nombre
# Así "suspender" corta el subdominio de HEPTA y también el dominio propio, y "reactivar" no le devuelve la vida
# a un subdominio que se apagó a propósito al pasar al dominio propio.
susp_conf() { echo "$SUSP/$1.$BASE.conf"; }
dom_conf() { echo "$SUSPD/$1.conf"; }
tipo_de() { [ -e "$1" ] || { echo ninguno; return; }; grep -q '^# tipo: migrado' "$1" && echo migrado || echo suspendido; }

# Escribe varios archivos juntos: si nginx -t falla, vuelve todos a como estaban. Uso: aplicar <dest> <contenido|-> ...
aplicar() {
  local -a dest=() prev=()
  while [ $# -ge 2 ]; do
    local f="$1" c="$2"; shift 2
    mkdir -p "$(dirname "$f")"
    local p=""; [ -e "$f" ] && { p="$(mktemp)"; cp -p "$f" "$p"; }
    dest+=("$f"); prev+=("${p:--}")
    if [ "$c" = - ]; then [ -e "$f" ] && unlink "$f"; else
      local tmp; tmp="$(mktemp "$(dirname "$f")/.nuevo.XXXXXX")"; printf '%s\n' "$c" > "$tmp"; chmod 644 "$tmp"; mv "$tmp" "$f"; fi
  done
  if ! valida; then
    local i; for i in "${!dest[@]}"; do
      if [ "${prev[$i]}" = - ]; then [ -e "${dest[$i]}" ] && unlink "${dest[$i]}"; else mv "${prev[$i]}" "${dest[$i]}"; fi
    done
    return 1
  fi
  local x; for x in "${prev[@]}"; do [ "$x" = - ] || unlink "$x"; done
  recargar
}
frag_suspendido() { printf '# Suspendido por Hepta Cloud — %s\n# tipo: suspendido\n# tenant: %s\nif ($host = "%s.%s") {\n    return 302 %s?i=%s;\n}\n' "$(date -u +%FT%TZ)" "$1" "$1" "$BASE" "$AVISO" "$1"; }
frag_migrado() { printf '# Subdominio de HEPTA apagado: el cliente usa su dominio propio — %s\n# tipo: migrado\n# tenant: %s\n# dominio: %s\nif ($host = "%s.%s") {\n    return 301 https://%s$request_uri;\n}\n' "$(date -u +%FT%TZ)" "$1" "$2" "$1" "$BASE" "$2"; }
frag_dominio() { printf '# Suspendido por Hepta Cloud — %s\n# tenant: %s\nreturn 302 %s?i=%s&d=$host;\n' "$(date -u +%FT%TZ)" "$1" "$AVISO" "$1"; }

suspender() {
  local t="$1" a; a="$(susp_conf "$t")"
  local -a cambios=("$(dom_conf "$t")" "$(frag_dominio "$t")")
  [ "$(tipo_de "$a")" = migrado ] || cambios+=("$a" "$(frag_suspendido "$t")")   # el migrado ya lleva al dominio propio, que queda cortado
  aplicar "${cambios[@]}" || error "nginx -t falló; no se suspendió $t (quedó como estaba)"
  echo "suspendida: $t.$BASE$([ "$(tipo_de "$a")" = migrado ] && echo " y su dominio propio")"
}
reactivar() {
  local t="$1" a d; a="$(susp_conf "$t")"; d="$(dom_conf "$t")"
  local -a cambios=()
  [ -e "$d" ] && cambios+=("$d" -)
  [ "$(tipo_de "$a")" = suspendido ] && cambios+=("$a" -)
  [ ${#cambios[@]} -gt 0 ] || { echo "no estaba suspendida: $t.$BASE"; return 0; }
  aplicar "${cambios[@]}" || error "nginx -t falló; $t sigue suspendida"
  echo "reactivada: $t.$BASE"
}
migrar() {   # el subdominio de HEPTA pasa a mandar al dominio propio
  local t="$1" d="$2"
  aplicar "$(susp_conf "$t")" "$(frag_migrado "$t" "$d")" || error "nginx -t falló; el subdominio de $t quedó como estaba"
  echo "subdominio: $t.$BASE → https://$d"
}
listar() {   # los suspendidos de verdad (no los que pasaron a su dominio)
  local f t
  for f in "$SUSP"/*."$BASE".conf; do [ -e "$f" ] || continue; [ "$(tipo_de "$f")" = suspendido ] && basename "$f" ".$BASE.conf"; done
  for f in "$SUSPD"/*.conf; do [ -e "$f" ] || continue; t="$(basename "$f" .conf)"; [ "$(tipo_de "$(susp_conf "$t")")" = migrado ] && echo "$t"; done
  return 0
}

# Vhost de dominio propio que ya existía (lo creó la API vieja o se hizo a mano): se le suma la línea que lo corta
# cuando el tenant se suspende, y el subdominio de HEPTA pasa a mandar al dominio propio. No cambia nada más.
enganchar() {
  local d="$1" t="$2" probar="$3" conf="$SITIOS/sites-available/$1.conf"
  [ -f "$conf" ] || error "no existe $conf (¿el vhost de $d tiene otro nombre? buscarlo con: grep -l '$d' $SITIOS/sites-enabled/*)"
  grep -q "$t.$BASE" "$conf" || error "$conf no apunta a $t.$BASE. No se toca."
  local inc="    include $SUSPD/$t.con[f];   # hepta: corte por suspensión"
  local nuevo; nuevo="$(mktemp)"
  if grep -qF "$SUSPD/$t.con[f]" "$conf"; then cp -p "$conf" "$nuevo"; else
    awk -v inc="$inc" -v d="$d" '{ print } $0 ~ "^[ \t]*server_name[ \t]" && index($0, d) { print inc }' "$conf" > "$nuevo"
  fi
  if [ "$probar" = si ]; then
    diff -u "$conf" "$nuevo" || true
    echo "subdominio: $(tipo_de "$(susp_conf "$t")") → pasaría a migrado (https://$d)"
    unlink "$nuevo"; return 0
  fi
  grep -qF "$SUSPD/$t.con[f]" "$nuevo" || { unlink "$nuevo"; error "no encontré un server_name con $d en $conf"; }
  mkdir -p "$SUSPD"
  cp -p "$conf" "$conf.antes-enganche-$(date +%Y%m%d_%H%M)"
  local -a cambios=("$conf" "$(cat "$nuevo")")
  [ "$(tipo_de "$(susp_conf "$t")")" = suspendido ] && [ ! -e "$(dom_conf "$t")" ] && cambios+=("$(susp_conf "$t")" "$(frag_migrado "$t" "$d")")
  [ "$(tipo_de "$(susp_conf "$t")")" = ninguno ] && cambios+=("$(susp_conf "$t")" "$(frag_migrado "$t" "$d")")
  unlink "$nuevo"
  aplicar "${cambios[@]}" || error "nginx -t falló; $conf quedó como estaba"
  echo "enganchado: $d (tenant $t); subdominio: $(tipo_de "$(susp_conf "$t")")"
}

# ── Dominio propio de un tenant ──
bloques() {   # $1 dominio, $2 host interno, $3 http|https, $4 tenant
  local d="$1" h="$2" inc="    include $SUSPD/$4.con[f];   # hepta: corte por suspensión"
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
  local ssl="    ssl_certificate     $LIVE/$d/fullchain.pem;
    ssl_certificate_key $LIVE/$d/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
  if [ "$3" = https ]; then
    cat <<EOF
server {
    listen 443 ssl;
    server_name $d;
$inc
$ssl

$loc
}

# Una sola dirección: www y http mandan a https://$d (Google no ve dos sitios iguales)
server {
    listen 443 ssl;
    server_name www.$d;
$ssl
    return 301 https://$d\$request_uri;
}

server {
    listen 80;
    server_name $d www.$d;
    return 301 https://$d\$request_uri;
}
EOF
  else
    cat <<EOF
server {
    listen 80;
    server_name $d www.$d;
$inc

$loc
}
EOF
  fi
}

# El certificado de $1 existe y cubre $1 y www.$1
cubre() {
  local c="$LIVE/$1/fullchain.pem" san
  [ -s "$c" ] || return 1
  san="$(openssl x509 -in "$c" -noout -ext subjectAltName 2>/dev/null)" || return 1
  grep -qwF "DNS:$1" <<<"$san" && grep -qwF "DNS:www.$1" <<<"$san"
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
  escribir() { mkdir -p "$SUSPD"; { echo "$marca"; bloques "$d" "$h" "$1" "$t"; } > "$conf.nuevo"; chmod 644 "$conf.nuevo"; mv "$conf.nuevo" "$conf"; }

  # 1. Por HTTP (lo que haya andando sigue igual si ya tenía certificado)
  if cubre "$d"; then escribir https; else escribir http; fi
  [ -L "$enlace" ] || ln -s "$conf" "$enlace"
  valida || { deshacer; error "nginx -t falló con el vhost de $d; dejé todo como estaba"; }
  recargar

  # 2. Certificado por DNS de Cloudflare (no necesita que el dominio ya apunte acá)
  # Un certificado que ya estaba (por ejemplo uno viejo por HTTP, solo del dominio) sirve si cubre también el www;
  # si no, se amplía con --expand en el mismo nombre.
  local ssl=no registro; registro="$(mktemp)"
  if cubre "$d"; then
    ssl=si
  elif [ -r "$CF_CRED" ]; then
    if timeout 150 "$CERTBOT" certonly --dns-cloudflare --dns-cloudflare-credentials "$CF_CRED" \
         --dns-cloudflare-propagation-seconds 20 --cert-name "$d" --expand -d "$d" -d "www.$d" \
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
  # (también si ya era HTTPS: así un vhost viejo queda con el formato de ahora, www y http → https://$d)
  if [ "$ssl" = si ]; then
    local http; http="$(mktemp)"; cp -p "$conf" "$http"
    escribir https
    if ! valida; then cp -p "$http" "$conf"; valida && recargar || true; ssl=no; echo "nginx -t falló con HTTPS: quedó por HTTP"; else recargar; fi
    unlink "$http"
  fi
  [ -n "$previo" ] && unlink "$previo"

  # 4. El subdominio de HEPTA pasa a mandar al dominio propio (salvo que el tenant esté suspendido: ahí sigue cortado)
  if [ "$suspender_sub" = si ] && [ ! -e "$(dom_conf "$t")" ]; then migrar "$t" "$d"; fi
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
  listar) listar ;;
  enganchar)
    d="${2:-}"; d="${d,,}"; dominio_ok "$d" || error "dominio inválido"
    t="$(tenant_de "${3:-}")" || error "tenant inválido"
    enganchar "$d" "$t" "$([ "${4:-}" = --probar ] && echo si || echo no)" ;;
  rehacer-suspendidas)
    # Vuelve a escribir los fragmentos de las ya suspendidas con el formato actual (página de aviso)
    n=0; for f in "$SUSP"/*."$BASE".conf; do
      [ -e "$f" ] || continue
      t="$(basename "$f" ".$BASE.conf")"; t="$(tenant_de "$t")" || { echo "se saltea $f (nombre raro)"; continue; }
      [ "$(tipo_de "$f")" = suspendido ] || continue
      suspender "$t" >/dev/null && n=$((n + 1))
    done
    echo "rehechas: $n" ;;
  probar)
    valida && echo "nginx -t: OK" || error "nginx -t falla" ;;
  *) uso ;;
esac
