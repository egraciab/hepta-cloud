#!/usr/bin/env bash
# hepta-drive-enrolar.sh — corre en hcsvrnd01, cada 10 minutos. Se instala como /usr/local/sbin/hepta-drive-enrolar.
#
# Da de alta en el servidor de respaldos a los clientes nuevos de HEPTA Drive. El alta de un cliente
# (hepta-drive-alta, en la VM) genera sus dos contraseñas de respaldo y deja una marca en
# /var/lib/hepta-drive/respaldo-pendiente/<cliente>. La VM no puede crear su propio usuario en el servidor de
# respaldos (a propósito: tampoco puede borrar sus copias), así que lo hace este nodo, que llega a los dos:
#
#   1. Crea el usuario y el repositorio en el servidor (hepta-respaldo-repos alta). Las dos contraseñas pasan de
#      la VM al servidor por una tubería: no se muestran, no quedan en este nodo ni en ningún registro.
#   2. Comprueba desde la VM que el acceso funciona.
#   3. Hace la primera copia y la verifica en el servidor (así la réplica de la mañana ya la lleva).
#   4. Recién entonces quita la marca. Si algo falla, la marca queda y se reintenta en la próxima corrida.
#
# Mientras un cliente siga pendiente, la réplica diaria (hepta-drive-replicar) lo suma a la alerta general.
#
# Uso: hepta-drive-enrolar            procesa los pendientes (no dice nada si no hay ninguno)
#      hepta-drive-enrolar --solo-ver muestra los pendientes y no toca nada
set -uo pipefail

PROYECTO="${HEPTA_PROYECTO:-HEPTA}"
SERVIDOR="${HD_SERVIDOR:-hepta-respaldo}"
VM="${HD_VM:-hepta-drive}"
RAIZ="${HD_RAIZ:-/srv/restic}"
PENDIENTES="${HD_PENDIENTES:-/var/lib/hepta-drive/respaldo-pendiente}"
CONF_VM="${HD_CONF_VM:-/etc/hepta-drive-respaldo}"
CLIENTES_VM="${HD_CLIENTES_VM:-/opt/hepta-drive/clientes}"
SOLO_VER=0; [ "${1:-}" = "--solo-ver" ] && SOLO_VER=1

aviso() { echo "[$(date '+%F %H:%M:%S')] $*"; }
en() { local inst="$1"; shift; lxc exec --project "$PROYECTO" "$inst" -- "$@"; }
nombre_ok() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]]; }

[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
exec 9>"/tmp/hepta-drive-enrolar.candado"; flock -n 9 || exit 0

LISTA="$(en "$VM" sh -c "ls -1 '$PENDIENTES' 2>/dev/null" 2>/dev/null)" || { aviso "ERROR: la VM $VM no responde"; exit 1; }
[ -n "$LISTA" ] || exit 0

FALLARON=0
falla() { FALLARON=$((FALLARON + 1)); aviso "   ERROR: $*"; }

for c in $LISTA; do
  aviso "── $c"
  nombre_ok "$c" || { falla "nombre inválido en la carpeta de pendientes; se ignora"; continue; }
  en "$VM" test -d "$CLIENTES_VM/$c" || { falla "la VM no tiene el cliente $c (¿una baja a medias?). Quitar la marca a mano si corresponde."; continue; }
  en "$VM" test -s "$CONF_VM/$c.env" || { falla "la VM no tiene $CONF_VM/$c.env"; continue; }
  if [ "$SOLO_VER" = 1 ]; then
    if en "$SERVIDOR" test -e "$RAIZ/$c"; then aviso "   pendiente; el repositorio ya existe en el servidor"; else aviso "   pendiente; falta crear el repositorio"; fi
    continue
  fi

  # 1. Usuario y repositorio. Si ya existe (una corrida anterior se cortó), se sigue con la comprobación.
  if ! en "$SERVIDOR" test -e "$RAIZ/$c"; then
    # shellcheck disable=SC2016
    if ! en "$VM" sh -c 'REST_CLAVE=""; RESTIC_PASSWORD=""; . "$1"; printf "%s\n%s\n" "$REST_CLAVE" "$RESTIC_PASSWORD"' _ "$CONF_VM/$c.env" \
         | en "$SERVIDOR" hepta-respaldo-repos alta "$c" >/dev/null 2>&1; then
      falla "no se pudo crear el repositorio en el servidor (probar a mano: lxc exec $SERVIDOR --project $PROYECTO -- hepta-respaldo-repos estado)"; continue
    fi
    aviso "   repositorio creado en el servidor"
  fi

  # 2. El acceso desde la VM (el servidor tarda un instante en leer el usuario nuevo)
  ok=0
  for _ in 1 2 3 4 5; do
    if en "$VM" hepta-drive-respaldo --copias "$c" >/dev/null 2>&1; then ok=1; break; fi
    sleep 3
  done
  [ "$ok" = 1 ] || { falla "la VM no puede entrar al repositorio de $c. Si el repositorio quedó de un intento anterior con otras contraseñas, hay que borrarlo a mano en el servidor y volver a correr."; continue; }

  # 3. Primera copia y verificación
  if ! en "$VM" hepta-drive-respaldo "$c" 2>&1 | sed 's/^/   /'; then falla "la primera copia falló"; continue; fi
  if ! en "$SERVIDOR" hepta-respaldo-repos mantener "$c" 2>&1 | sed 's/^/   /'; then falla "la verificación de la primera copia falló"; continue; fi

  # 4. Listo
  en "$VM" unlink "$PENDIENTES/$c" || { falla "no pude quitar la marca de pendiente"; continue; }
  aviso "   OK: $c ya tiene respaldo (primera copia hecha y verificada)"
done

[ "$FALLARON" -eq 0 ] || { aviso "Terminó CON $FALLARON falla/s; se reintenta en la próxima corrida."; exit 1; }
exit 0
