#!/usr/bin/env bash
# instalar-drive-vhost.sh — corre en dkr-hgsvrlnx003 (NGINX perimetral), como root.
# Actualiza la API perimetral con las rutas del vhost de HEPTA Drive y le da a www-data el permiso para
# correr el script del vhost (y solo ese). Guarda la versión anterior y vuelve atrás si la API no levanta.
#
#   ./instalar-drive-vhost.sh <main.py nuevo>
set -euo pipefail
NUEVO="${1:?falta la ruta del main.py nuevo}"
DEST=/opt/hepta/perimetral_api/main.py
SCRIPT=/usr/local/sbin/drive_vhost_add.sh
SUDOERS=/etc/sudoers.d/hepta-drive-vhost

[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
[ -s "$NUEVO" ] && grep -q '"/drive-vhost"' "$NUEVO" || { echo "ERROR: $NUEVO no es la API con las rutas del drive" >&2; exit 2; }
[ -x "$SCRIPT" ] && [ "$(stat -c %U "$SCRIPT")" = root ] || { echo "ERROR: falta $SCRIPT o no es de root" >&2; exit 2; }
[ "$(stat -c %a "$SCRIPT")" = 755 ] || chmod 755 "$SCRIPT"
/opt/hepta/perimetral_api/venv/bin/python -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$NUEVO"

# Permiso: ese script y nada más. El script valida sus propios argumentos.
TMP="$(mktemp)"
echo "www-data ALL=(root) NOPASSWD: $SCRIPT" > "$TMP"
visudo -cf "$TMP" >/dev/null || { echo "ERROR: la regla de sudo no pasó la validación" >&2; unlink "$TMP"; exit 1; }
install -m 440 -o root -g root "$TMP" "$SUDOERS"; unlink "$TMP"
sudo -u www-data sudo -n "$SCRIPT" permisoprueba 8199 --dry-run >/dev/null || { echo "ERROR: www-data no puede correr el script" >&2; exit 1; }
echo "Permiso listo: $SUDOERS"

PREVIO="$DEST.antes-drive-$(date +%Y%m%d_%H%M)"
cp -p "$DEST" "$PREVIO"
install -m 644 -o www-data -g www-data "$NUEVO" "$DEST"
systemctl restart hepta-perimetral
sleep 3
if systemctl is-active -q hepta-perimetral && ss -ltn | grep -q ':8888 '; then
  echo "API perimetral actualizada y corriendo. La anterior quedó en $PREVIO"
else
  echo "La API no levantó: vuelvo a la versión anterior." >&2
  cp -p "$PREVIO" "$DEST"; systemctl restart hepta-perimetral
  journalctl -u hepta-perimetral -n 15 --no-pager >&2; exit 1
fi
