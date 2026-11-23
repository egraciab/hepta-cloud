#!/usr/bin/env bash
# instalar-permisos.sh — corre en dkr-hgsvrlnx003 (NGINX perimetral), como root.
#
# Deja a la API perimetral (usuario www-data) sin sudo amplio: lo que necesita root para los tenants lo hace
# /usr/local/sbin/hepta-tenant-nginx (tools/tenant_nginx.sh), con argumentos validados, y el drive ya tiene el suyo.
#
#   ./instalar-permisos.sh <main.py> <tenant_nginx.sh>      paso 1: instala el script, su permiso y la API 2.0.0
#   ./instalar-permisos.sh --ver                            muestra qué puede correr www-data por sudo
#   ./instalar-permisos.sh --retirar <archivo de sudoers>   paso 2: retira la regla amplia vieja (queda copia en /root)
#
# El paso 1 no quita nada: la API nueva ya no usa los permisos viejos, pero se retiran recién en el paso 2, después
# de probar suspender y reactivar desde el Admin. Si la API nueva no levanta, vuelve sola a la anterior.
set -euo pipefail
DEST=/opt/hepta/perimetral_api/main.py
PY=/opt/hepta/perimetral_api/venv/bin/python
SCRIPT=/usr/local/sbin/hepta-tenant-nginx
SUDOERS=/etc/sudoers.d/hepta-perimetral
SUSP=/etc/nginx/hepta-suspended

[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }

ver() {
  echo "── Lo que www-data puede correr como root:"
  sudo -l -U www-data | sed -n '/may run/,$p'
  echo "── Archivos de sudoers que lo mencionan:"
  grep -ls 'www-data' /etc/sudoers /etc/sudoers.d/* || true
}

case "${1:-}" in
  --ver) ver; exit 0 ;;
  --retirar)
    F="${2:?falta el archivo de sudoers a retirar}"
    case "$F" in /etc/sudoers.d/*) ;; *) echo "ERROR: solo archivos de /etc/sudoers.d/" >&2; exit 2 ;; esac
    [ -f "$F" ] || { echo "ERROR: no existe $F" >&2; exit 2; }
    case "$F" in "$SUDOERS"|/etc/sudoers.d/hepta-drive-vhost) echo "ERROR: ese es uno de los permisos nuevos, no se retira" >&2; exit 2 ;; esac
    mkdir -p /root/sudoers-retirados
    mv "$F" "/root/sudoers-retirados/$(basename "$F").$(date +%Y%m%d_%H%M)"
    visudo -c >/dev/null || { echo "ERROR: sudoers quedó inválido; vuelvo a poner $F" >&2; mv "/root/sudoers-retirados/$(basename "$F")".* "$F"; exit 1; }
    sudo -u www-data sudo -n "$SCRIPT" probar >/dev/null || { echo "ERROR: www-data ya no puede correr $SCRIPT (revisar $SUDOERS)" >&2; exit 1; }
    echo "Retirado $F (copia en /root/sudoers-retirados/)."
    ver; exit 0 ;;
esac

NUEVO="${1:?falta la ruta del main.py nuevo}"; TN="${2:?falta la ruta de tenant_nginx.sh}"
[ -s "$NUEVO" ] && grep -q 'hepta-tenant-nginx' "$NUEVO" || { echo "ERROR: $NUEVO no es la API 2.0.0" >&2; exit 2; }
[ -s "$TN" ] && head -3 "$TN" | grep -q 'tenant_nginx.sh' || { echo "ERROR: $TN no es tenant_nginx.sh" >&2; exit 2; }
bash -n "$TN"
"$PY" -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$NUEVO"

# 0. El script usa /etc/nginx/hepta-suspended y erp.hepta.com.py. Si la API corre con otros valores, no sigo.
ENVS="$(systemctl show hepta-perimetral -p Environment --value 2>/dev/null)"
for f in $(systemctl show hepta-perimetral -p EnvironmentFiles --value 2>/dev/null | grep -o '/[^ ]*'); do
  [ -r "$f" ] && ENVS="$ENVS $(grep -E '^(SUSPENDED_DIR|BASE_DOMAIN)=' "$f" | tr '\n' ' ')"
done
for par in "SUSPENDED_DIR=$SUSP" "BASE_DOMAIN=erp.hepta.com.py"; do
  clave="${par%%=*}"; val="$(echo "$ENVS" | grep -o "$clave=[^ ]*" | tail -1 | cut -d= -f2- | tr -d '"')"
  if [ -n "$val" ] && [ "$val" != "${par#*=}" ]; then
    echo "ERROR: la API corre con $clave=$val y el script espera ${par#*=}. No sigo: avisale a Clau." >&2; exit 1
  fi
done

# 1. El script, de root
install -m 755 -o root -g root "$TN" "$SCRIPT"
"$SCRIPT" probar

# 2. Permiso: ese script y nada más (el del drive sigue en su propio archivo)
TMP="$(mktemp)"
echo "www-data ALL=(root) NOPASSWD: $SCRIPT" > "$TMP"
visudo -cf "$TMP" >/dev/null || { echo "ERROR: la regla de sudo no pasó la validación" >&2; unlink "$TMP"; exit 1; }
install -m 440 -o root -g root "$TMP" "$SUDOERS"; unlink "$TMP"
sudo -u www-data sudo -n "$SCRIPT" probar >/dev/null || { echo "ERROR: www-data no puede correr el script" >&2; exit 1; }
echo "Permiso listo: $SUDOERS"

# 3. La API nueva, con vuelta atrás si no levanta
PREVIO="$DEST.antes-permisos-$(date +%Y%m%d_%H%M)"
cp -p "$DEST" "$PREVIO"
install -m 644 -o www-data -g www-data "$NUEVO" "$DEST"
systemctl restart hepta-perimetral
sleep 3
if systemctl is-active -q hepta-perimetral && ss -ltn | grep -q ':8888 '; then
  echo "API perimetral 2.0.0 corriendo. La anterior quedó en $PREVIO"
else
  echo "La API no levantó: vuelvo a la versión anterior." >&2
  cp -p "$PREVIO" "$DEST"; systemctl restart hepta-perimetral
  journalctl -u hepta-perimetral -n 15 --no-pager >&2; exit 1
fi
# 4. Los fragmentos de suspensión pasan a ser de root (los escribía la API; ahora solo el script). Va al final:
#    si la API nueva no levantaba, la vieja tenía que poder seguir escribiéndolos.
if [ -d "$SUSP" ]; then
  chown -R root:root "$SUSP"; chmod 755 "$SUSP"; find "$SUSP" -type f -exec chmod 644 {} +
  echo "Suspendidas hoy: $(find "$SUSP" -name '*.conf' | wc -l) (sin cambios)"
else
  echo "AVISO: no existe $SUSP; el script lo crea en la primera suspensión"
fi

ver
