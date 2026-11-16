#!/usr/bin/env bash
# hepta-backup-correo-configurar.sh — deja andando los informes de respaldos por correo en hcsvrnd01.
# Pregunta los datos del correo, los guarda en /etc/hepta-backup-correo.conf (solo root), manda un informe
# de prueba y, si llega a salir, programa el informe diario (22:00 de Paraguay) y el semanal (domingo 08:00).
# La contraseña se escribe sin que se vea en pantalla y no queda en el historial de la terminal.
# Se puede volver a correr cuando cambie algún dato.
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Corré como root" >&2; exit 2; }
AQUI="$(cd "$(dirname "$0")" && pwd)"
CONF="${HEPTA_CORREO_CONF:-/etc/hepta-backup-correo.conf}"
INFORME=/usr/local/sbin/hepta-backup-informe
CRON=/etc/cron.d/hepta-backup-informe

command -v python3 >/dev/null || { echo "Falta python3 (apt install python3)" >&2; exit 2; }
[ -f "$AQUI/hepta-backup-informe.py" ] || { echo "No encuentro hepta-backup-informe.py al lado de este script" >&2; exit 2; }

# Valores anteriores como sugerencia (menos la contraseña)
anterior() { [ -r "$CONF" ] && sed -n "s/^$1='\(.*\)'$/\1/p" "$CONF" | head -1; }
preguntar() {   # preguntar VARIABLE "texto" "valor sugerido"
  local r; read -r -p "$2${3:+ [$3]}: " r; printf -v "$1" '%s' "${r:-$3}"
}

echo "── Informes de respaldos por correo ──"
echo "Conviene un buzón propio para esto (por ejemplo respaldos@hepta.com.py), con su contraseña generada en KeePass."
echo
preguntar SERVIDOR  "Servidor SMTP"                         "$(anterior SMTP_SERVIDOR || true)"
SERVIDOR="${SERVIDOR:-mail.hepta.com.py}"
preguntar PUERTO    "Puerto (465 = SSL, 587 = STARTTLS)"    "$(a=$(anterior SMTP_PUERTO); echo "${a:-465}")"
case "$PUERTO" in 465) SEGURIDAD=ssl;; *) SEGURIDAD=starttls;; esac
preguntar USUARIO   "Usuario (el buzón que envía)"          "$(anterior SMTP_USUARIO || true)"
while :; do
  read -r -s -p "Contraseña de ese buzón (no se muestra): " CLAVE; echo
  [ -n "$CLAVE" ] && break; echo "  No puede quedar vacía."
done
preguntar REMITENTE "Dirección del remitente"               "$(a=$(anterior SMTP_REMITENTE); echo "${a:-$USUARIO}")"
preguntar NOMBRE    "Nombre que se ve como remitente"       "$(a=$(anterior SMTP_NOMBRE); echo "${a:-Respaldos HEPTA}")"
preguntar DESTINOS  "Destinatarios (separados por coma)"    "$(anterior SMTP_DESTINATARIOS || true)"
[ -n "$USUARIO" ] && [ -n "$REMITENTE" ] && [ -n "$DESTINOS" ] || { echo "Faltan datos; no se guardó nada." >&2; exit 1; }

comillas() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
umask 077
{
  echo "# Correo de los informes de respaldos. Lo escribe hepta-backup-correo-configurar.sh. Solo root (600)."
  echo "SMTP_SERVIDOR=$(comillas "$SERVIDOR")"
  echo "SMTP_PUERTO=$(comillas "$PUERTO")"
  echo "SMTP_SEGURIDAD=$(comillas "${HEPTA_CORREO_SEGURIDAD:-$SEGURIDAD}")"
  echo "SMTP_USUARIO=$(comillas "$USUARIO")"
  echo "SMTP_CLAVE=$(comillas "$CLAVE")"
  echo "SMTP_REMITENTE=$(comillas "$REMITENTE")"
  echo "SMTP_NOMBRE=$(comillas "$NOMBRE")"
  echo "SMTP_DESTINATARIOS=$(comillas "$DESTINOS")"
  echo "SMTP_VERIFICAR_TLS='si'"
} > "$CONF.nuevo"
unset CLAVE
chmod 600 "$CONF.nuevo"; mv "$CONF.nuevo" "$CONF"
install -m 755 "$AQUI/hepta-backup-informe.py" "$INFORME"
echo; echo "Datos guardados en $CONF. Envío un informe de prueba a $DESTINOS…"

if HEPTA_CORREO_CONF="$CONF" "$INFORME" diario --prueba; then
  if [ -z "${HEPTA_CORREO_SIN_CRON:-}" ]; then
    cat > "$CRON" <<EOF
# Informes de respaldos por correo. El nodo tiene el reloj en UTC: 01:00 UTC = 22:00 de Paraguay; 11:00 UTC = 08:00.
0 1 * * *  root $INFORME diario  >> /var/log/hepta-backup-informe.log 2>&1
0 11 * * 0 root $INFORME semanal >> /var/log/hepta-backup-informe.log 2>&1
EOF
    echo "Programado: informe diario a las 22:00 y semanal los domingos a las 08:00 (hora de Paraguay)."
  fi
  echo "Listo. Revisá que el correo de prueba haya llegado (mirá también la carpeta de spam)."
else
  echo
  echo "El envío de prueba FALLÓ (el motivo está arriba). Los datos quedaron guardados pero NO se programó nada." >&2
  echo "Corregí lo que haga falta y volvé a correr este script." >&2
  exit 1
fi
