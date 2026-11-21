#!/usr/bin/env bash
# alta-cliente.sh — corre en la VM hepta-drive. Se instala como /usr/local/sbin/hepta-drive-alta.
# Da de alta un Nextcloud para un cliente de HEPTA Drive, igual a la instancia "hepta" (referencia: 2026-11-20).
#
#   hepta-drive-alta preparar                       una vez: instala la plantilla y toma el correo saliente de "hepta"
#   hepta-drive-alta validar  <slug> [opciones]     revisa nombre, puerto y capacidad. No cambia nada
#   hepta-drive-alta crear    <slug> [opciones]     alta completa. Se puede repetir: lo que ya está, lo saltea
#   hepta-drive-alta verificar <slug>               comprueba que la instancia responde
#   hepta-drive-alta estado   [slug]                qué hay hoy (JSON, una línea por cliente)
#   hepta-drive-alta aplicar-plantilla [slug]       lleva un cambio de la plantilla a las instancias existentes
#   hepta-drive-alta marca    <slug> [--logo ARCH]  aplica la marca (nombre, color y logo) a una instancia que ya existe
#   hepta-drive-alta secretos <slug>                entrega los secretos del alta (CSV para KeePass)
#   hepta-drive-alta secretos <slug> --guardado     los borra de la VM, cuando ya están en KeePass
#   hepta-drive-alta baja     <slug> --confirmar <slug>   apaga y archiva en /srv/nextcloud/_bajas (no borra datos)
#
# Opciones de validar y crear:
#   --usuarios ARCHIVO     una línea por usuario:  correo|Nombre y Apellido[|cuota en GB]
#   --cuota-gb N           cuota por usuario si la línea no trae una (por defecto 5)
#   --equipo-gb N          carpeta de equipo compartida con esa cuota (por defecto 0 = sin carpeta de equipo)
#   --fqdn NOMBRE          por defecto <slug>.drive.hepta.com.py
#   --logo ARCHIVO         logo del cliente (PNG o JPG, hasta 1 MB). Sin esto va el de Hepta Cloud
#
# Marca: toda instancia nace como "Hepta Cloud" (nombre, color, logo y correo de invitación), sin los archivos de
# ejemplo ni la presentación de Nextcloud. El logo por defecto está en /opt/hepta-drive/plantilla/marca/logo.png y
# los textos se pueden cambiar en /opt/hepta-drive/plantilla/marca/marca.conf (NOMBRE, LEMA, COLOR, URL).
#
# Usuarios: el identificador es su correo. No circula contraseña inicial: Nextcloud les manda una invitación para
# que pongan la suya. Si el cliente también tiene correo con HEPTA, primero se crean las casillas.
#
# Secretos: los genera este script y quedan en la VM (.env de la instancia y acceso al respaldo). Una copia para
# KeePass queda en /var/lib/hepta-drive/secretos/<slug>.csv (600) hasta que se confirma con "secretos <slug> --guardado".
# Nada de esto se muestra en pantalla ni va al log.
set -uo pipefail

BASE="${HD_BASE:-/opt/hepta-drive}"
DATOS="${HD_DATOS:-/srv/nextcloud}"
VAR="${HD_VAR:-/var/lib/hepta-drive}"
CONF_RESPALDO="${HD_CONF_RESPALDO:-/etc/hepta-drive-respaldo}"
CONF_BACKUP="${HD_CONF_BACKUP:-/etc/hepta-backup.conf}"
DOCKER="${HD_DOCKER:-docker}"
IP_VM="${HD_IP:-10.10.50.220}"
DOMINIO_BASE="${HD_DOMINIO:-drive.hepta.com.py}"
PUERTO_MIN=8082; PUERTO_MAX=8199          # 8081 es la instancia "hepta"; 8000 es OnlyOffice
RAM_MIN_MB="${HD_RAM_MIN_MB:-1200}"       # memoria disponible mínima para sumar una instancia (cada una usa ~350 MB)
ADMIN_TECNICO=hepta-admin
OFFICE_URL="https://office.hepta.com.py/"
AQUI="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }
aviso() { echo "[$(date '+%F %H:%M:%S')] $*"; }
morir() { echo "ERROR: $*" >&2; exit 1; }
slug_ok() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]] && [[ "$1" != *--* ]]; }
clave() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"${1:-32}"; }
# Lee una variable de un .env sin ejecutar el archivo
de_env() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1 | sed "s/^'\(.*\)'$/\1/; s/^\"\(.*\)\"$/\1/"; }
occ() { local c="$1"; shift; $DOCKER exec -u www-data "$c-app-1" php occ "$@"; }
# occ para valores secretos: ni la salida ni el valor llegan a la pantalla
occ_s() { occ "$@" >/dev/null 2>&1; }

# ── Argumentos ──
ACCION="${1:-}"; SLUG="${2:-}"
[ $# -ge 1 ] && shift; [ $# -ge 1 ] && shift
USUARIOS=""; CUOTA_GB=5; EQUIPO_GB=0; FQDN=""; CONFIRMAR=""; GUARDADO=0; LOGO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --usuarios) USUARIOS="${2:-}"; shift 2 ;;
    --cuota-gb) CUOTA_GB="${2:-}"; shift 2 ;;
    --equipo-gb) EQUIPO_GB="${2:-}"; shift 2 ;;
    --fqdn) FQDN="${2:-}"; shift 2 ;;
    --confirmar) CONFIRMAR="${2:-}"; shift 2 ;;
    --guardado) GUARDADO=1; shift ;;
    --logo) LOGO="${2:-}"; shift 2 ;;
    *) morir "opción desconocida: $1" ;;
  esac
done
[[ "$CUOTA_GB" =~ ^[0-9]{1,4}$ ]] && [ "$CUOTA_GB" -ge 1 ] || morir "--cuota-gb tiene que ser un número de 1 en adelante"
[[ "$EQUIPO_GB" =~ ^[0-9]{1,5}$ ]] || morir "--equipo-gb tiene que ser un número"

necesita_slug() {
  slug_ok "$SLUG" || morir "nombre de cliente inválido: minúsculas, números y guiones, de 3 a 32, empezando con letra"
  case "$SLUG" in hepta|shared|plantilla|office|www|mail|admin|api) [ "$ACCION" = crear ] && morir "'$SLUG' es un nombre reservado" ;; esac
  [ -n "$FQDN" ] || FQDN="$SLUG.$DOMINIO_BASE"
  [[ "$FQDN" =~ ^[a-z0-9]([a-z0-9.-]{1,200})[a-z0-9]$ ]] || morir "--fqdn inválido"
  DIR="$BASE/clientes/$SLUG"; RAIZ="$DATOS/$SLUG"
}

# ── Usuarios del pedido: valida el archivo y lo deja en la lista U_* ──
U_CORREO=(); U_NOMBRE=(); U_CUOTA=()
leer_usuarios() {
  [ -n "$USUARIOS" ] || return 0
  [ -r "$USUARIOS" ] || morir "no puedo leer el archivo de usuarios: $USUARIOS"
  local n=0 correo nombre cuota
  while IFS='|' read -r correo nombre cuota || [ -n "$correo" ]; do
    correo="$(echo "$correo" | tr -d ' \r' | tr 'A-Z' 'a-z')"; nombre="$(echo "${nombre:-}" | tr -d '\r' | sed 's/^ *//; s/ *$//')"
    cuota="$(echo "${cuota:-}" | tr -d ' \r')"
    [ -z "$correo" ] && continue; case "$correo" in \#*) continue ;; esac
    n=$((n + 1))
    [[ "$correo" =~ ^[a-z0-9._+-]{1,64}@[a-z0-9.-]{3,190}$ ]] || morir "usuario $n: correo inválido ($correo)"
    [[ "$nombre" =~ ^[^\"\'\\\`\$\|\<\>]{1,80}$ ]] || morir "usuario $n ($correo): falta el nombre o tiene caracteres no permitidos"
    [ -n "$cuota" ] || cuota="$CUOTA_GB"
    [[ "$cuota" =~ ^[0-9]{1,4}$ ]] && [ "$cuota" -ge 1 ] || morir "usuario $n ($correo): cuota inválida"
    U_CORREO+=("$correo"); U_NOMBRE+=("$nombre"); U_CUOTA+=("$cuota")
  done < "$USUARIOS"
  [ "$(printf '%s\n' "${U_CORREO[@]}" | sort | uniq -d | wc -l)" = 0 ] || morir "hay correos repetidos en el archivo de usuarios"
}

puertos_usados() {
  local f; for f in "$BASE"/clientes/*/.env; do [ -f "$f" ] && de_env "$f" APP_PORT; done
  ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://'
}
puerto_libre() {
  local p usados; usados=" $(puertos_usados | tr '\n' ' ') "
  for p in $(seq "$PUERTO_MIN" "$PUERTO_MAX"); do case "$usados" in *" $p "*) ;; *) echo "$p"; return 0 ;; esac; done
  return 1
}

# ── Marca ──
logo_ok() {   # logo_ok <archivo> → imprime la extensión (png|jpg) si sirve
  [ -r "$1" ] || return 1
  [ "$(stat -c %s "$1")" -le 1048576 ] || return 1
  case "$(head -c 8 "$1" | od -An -tx1 | tr -d ' \n')" in
    89504e470d0a1a0a) echo png ;;
    ffd8ff*) echo jpg ;;
    *) return 1 ;;
  esac
}
# Aplica nombre, lema, color y logo. Si el cliente tiene logo propio ($DIR/logo.*), va ese; si no, el de Hepta Cloud.
# No corta el alta: si algo no se pudo aplicar, avisa y sigue.
marca() {
  local c="$1" NOMBRE="Hepta Cloud" LEMA="Tu nube privada" COLOR="#1254A4" URL="https://cloud.hepta.com.py" f ext fallas=0
  # shellcheck disable=SC1091
  [ -r "$BASE/plantilla/marca/marca.conf" ] && . "$BASE/plantilla/marca/marca.conf"
  occ "$c" theming:config name "$NOMBRE" >/dev/null 2>&1 || fallas=$((fallas + 1))
  occ "$c" theming:config slogan "$LEMA" >/dev/null 2>&1 || fallas=$((fallas + 1))
  occ "$c" theming:config url "$URL" >/dev/null 2>&1 || fallas=$((fallas + 1))
  occ "$c" theming:config primary_color "$COLOR" >/dev/null 2>&1 || occ "$c" theming:config color "$COLOR" >/dev/null 2>&1 || fallas=$((fallas + 1))
  f=""; for ext in png jpg; do [ -f "$BASE/clientes/$c/logo.$ext" ] && { f="$BASE/clientes/$c/logo.$ext"; break; }; done
  [ -n "$f" ] || for ext in png jpg; do [ -f "$BASE/plantilla/marca/logo.$ext" ] && { f="$BASE/plantilla/marca/logo.$ext"; break; }; done
  if [ -n "$f" ]; then
    ext="${f##*.}"
    if $DOCKER cp "$f" "$c-app-1:/tmp/marca-logo.$ext" >/dev/null 2>&1 && $DOCKER exec "$c-app-1" chmod 644 "/tmp/marca-logo.$ext"; then
      occ "$c" theming:config logo "/tmp/marca-logo.$ext" >/dev/null 2>&1 || fallas=$((fallas + 1))
      $DOCKER exec "$c-app-1" unlink "/tmp/marca-logo.$ext" 2>/dev/null
    else fallas=$((fallas + 1)); fi
  else
    aviso "  AVISO: no hay logo en $BASE/plantilla/marca/ (queda el de Nextcloud)"
  fi
  # Sin la presentación de Nextcloud al primer ingreso
  occ "$c" app:disable firstrunwizard >/dev/null 2>&1
  if [ "$fallas" -gt 0 ]; then aviso "  AVISO: $fallas ajuste/s de marca no se pudieron aplicar (ver: occ theming:config)"; return 1; fi
  aviso "  marca: $NOMBRE, logo $([ "${f#"$BASE/clientes/"}" != "$f" ] && echo 'del cliente' || echo 'de Hepta Cloud')"
}
guardar_logo() {   # copia el logo del pedido a la carpeta del cliente
  [ -n "$LOGO" ] || return 0
  local ext; ext="$(logo_ok "$LOGO")" || morir "--logo: tiene que ser un PNG o JPG de hasta 1 MB"
  for f in "$DIR"/logo.png "$DIR"/logo.jpg; do [ -e "$f" ] && unlink "$f"; done
  install -m 644 "$LOGO" "$DIR/logo.$ext"
}

# ── validar ──
validar() {
  local errores=() avisos=() total=0 i libre_gb vendido_gb ram
  [ -f "$BASE/plantilla/compose.yaml" ] || errores+=("falta la plantilla: corré antes 'hepta-drive-alta preparar'")
  [ -z "$LOGO" ] || logo_ok "$LOGO" >/dev/null || errores+=("el logo tiene que ser un PNG o JPG de hasta 1 MB")
  for v in SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD SMTP_FROM SMTP_DOMAIN OO_JWT_SECRET; do
    [ -n "$(de_env "$BASE/shared/.env" "$v")" ] || errores+=("falta $v en $BASE/shared/.env (corré 'hepta-drive-alta preparar')")
  done
  if [ -d "$DIR" ] || [ -d "$RAIZ" ]; then
    [ -f "$DIR/.env" ] && avisos+=("el cliente ya existe: 'crear' continúa desde donde quedó") \
                       || errores+=("existe $DIR o $RAIZ pero sin .env: revisar a mano antes de seguir")
  else
    puerto_libre >/dev/null || errores+=("no quedan puertos libres entre $PUERTO_MIN y $PUERTO_MAX")
  fi
  for i in "${!U_CORREO[@]}"; do total=$((total + U_CUOTA[i])); done
  total=$((total + EQUIPO_GB))
  libre_gb=$(df -BG --output=avail "$DATOS" 2>/dev/null | tail -1 | tr -dc 0-9)
  vendido_gb=$(cat "$VAR"/clientes/*.cuota 2>/dev/null | awk '{s+=$1} END {print s+0}')
  [ "${libre_gb:-0}" -ge $((total + vendido_gb)) ] || avisos+=("cuotas: este pedido suma $total GB y ya hay $vendido_gb GB vendidos; quedan ${libre_gb:-?} GB libres en el volumen")
  ram=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  [ "${ram:-0}" -ge "$RAM_MIN_MB" ] || errores+=("memoria: quedan $ram MB disponibles y hacen falta $RAM_MIN_MB para sumar una instancia")
  printf '{"slug":"%s","fqdn":"%s","usuarios":%s,"cuota_total_gb":%s,"ok":%s,"errores":[%s],"avisos":[%s]}\n' \
    "$SLUG" "$FQDN" "${#U_CORREO[@]}" "$total" "$([ "${#errores[@]}" -eq 0 ] && echo true || echo false)" \
    "$(printf '"%s",' "${errores[@]:-}" | sed 's/^"",$//; s/,$//')" "$(printf '"%s",' "${avisos[@]:-}" | sed 's/^"",$//; s/,$//')"
  [ "${#errores[@]}" -eq 0 ]
}

# ── preparar: plantilla y correo saliente (una vez) ──
preparar() {
  install -d -m 755 "$BASE/plantilla"; install -d -m 700 "$VAR" "$VAR/secretos" "$VAR/clientes"
  [ -f "$AQUI/cliente/compose.yaml" ] && install -m 644 "$AQUI/cliente/compose.yaml" "$BASE/plantilla/compose.yaml"
  [ -f "$BASE/plantilla/compose.yaml" ] || morir "no encuentro cliente/compose.yaml junto a este script ni en $BASE/plantilla"
  aviso "Plantilla en $BASE/plantilla/compose.yaml"
  # El correo saliente es el mismo para todas las instancias: se toma de "hepta" sin mostrarlo
  local env="$BASE/shared/.env" k v
  [ -f "$env" ] || morir "falta $env"
  declare -A MAPA=([SMTP_HOST]=mail_smtphost [SMTP_PORT]=mail_smtpport [SMTP_SECURE]=mail_smtpsecure [SMTP_USER]=mail_smtpname
                   [SMTP_PASSWORD]=mail_smtppassword [SMTP_FROM]=mail_from_address [SMTP_DOMAIN]=mail_domain)
  for k in "${!MAPA[@]}"; do
    [ -n "$(de_env "$env" "$k")" ] && continue
    v="$(occ hepta config:system:get "${MAPA[$k]}" 2>/dev/null)" || v=""
    [ -n "$v" ] || morir "no pude leer ${MAPA[$k]} de la instancia hepta"
    case "$v" in *"'"*) morir "$k tiene una comilla simple; cargalo a mano en $env" ;; esac
    ( umask 077; printf "%s='%s'\n" "$k" "$v" >> "$env" )
  done
  chmod 600 "$env"; unset v
  aviso "Correo saliente: listo en $env (valores no mostrados)"
  command -v ss >/dev/null || morir "falta el comando ss (paquete iproute2)"
  aviso "Preparación OK."
}

# ── crear ──
paso() { aviso "· $*"; echo "$*" > "$VAR/clientes/$SLUG.paso"; }
crear() {
  validar >/dev/null || { validar; exit 1; }
  install -d -m 700 "$VAR" "$VAR/secretos" "$VAR/clientes"
  exec 9>"$VAR/clientes/$SLUG.candado"; flock -n 9 || morir "ya hay un alta de $SLUG en curso"
  # Un alta a la vez en toda la VM (dos a la par podrían elegir el mismo puerto)
  exec 8>"$VAR/alta.candado"; flock -n 8 || morir "ya hay otra alta en curso en esta VM; probá cuando termine"
  local nuevo=0 puerto c="$SLUG" i

  paso "Carpetas y configuración"
  if [ ! -f "$DIR/.env" ]; then
    nuevo=1; puerto="$(puerto_libre)" || morir "sin puertos libres"
    install -d -m 755 "$BASE/clientes"; install -d -m 700 "$DIR"
    install -m 644 "$BASE/plantilla/compose.yaml" "$DIR/compose.yaml"
    local k_admin k_db k_redis; k_admin="$(clave 28)"; k_db="$(clave 32)"; k_redis="$(clave 32)"
    ( umask 077
      printf 'FQDN=%s\nAPP_PORT=%s\nNC_TAG=%s\nDATA_ROOT=%s\nADMIN_USER=%s\nADMIN_PASSWORD=%s\nDB_PASSWORD=%s\nREDIS_PASSWORD=%s\n' \
        "$FQDN" "$puerto" "$(de_env "$BASE/clientes/hepta/.env" NC_TAG || echo 34-apache)" "$RAIZ" "$ADMIN_TECNICO" "$k_admin" "$k_db" "$k_redis" > "$DIR/.env"
      # Copia para KeePass (formato CSV de KeePass: Grupo,Título,Usuario,Contraseña,URL,Notas)
      { echo '"Group","Title","Username","Password","URL","Notes"'
        printf '"Vault/Hepta Drive/%s","hepta-drive / %s / admin Nextcloud","%s","%s","https://%s","Administrador técnico de HEPTA. El cliente no lo usa."\n' "$c" "$c" "$ADMIN_TECNICO" "$k_admin" "$FQDN"
        printf '"Vault/Hepta Drive/%s","hepta-drive / %s / Postgres","nextcloud","%s","",""\n' "$c" "$c" "$k_db"
        printf '"Vault/Hepta Drive/%s","hepta-drive / %s / Redis","","%s","",""\n' "$c" "$c" "$k_redis"
      } > "$VAR/secretos/$c.csv" )
    unset k_admin k_db k_redis
  else
    puerto="$(de_env "$DIR/.env" APP_PORT)"; FQDN="$(de_env "$DIR/.env" FQDN)"
  fi
  install -d -m 755 "$RAIZ"; install -d -o 33 -g 33 -m 750 "$RAIZ/html" "$RAIZ/data"

  paso "Levantando los contenedores (puerto $puerto)"
  ( cd "$DIR" && $DOCKER compose up -d ) >>"$VAR/clientes/$c.log" 2>&1 || morir "docker compose up falló (ver $VAR/clientes/$c.log)"

  paso "Esperando que Nextcloud termine de instalarse"
  for i in $(seq 1 90); do
    grep -q 'installed: true' <<<"$(occ "$c" status 2>/dev/null)" && break
    [ "$i" = 90 ] && morir "Nextcloud no terminó de instalarse en 15 minutos (ver: docker logs $c-app-1)"
    sleep 10
  done

  paso "Ajustes generales"
  occ "$c" background:cron >/dev/null
  local s
  for s in "default_phone_region=PY" "default_language=es" "default_locale=es_PY" "default_timezone=America/Asuncion" \
           "logtimezone=America/Asuncion" "trashbin_retention_obligation=90, 120" "versions_retention_obligation=90, 120"; do
    occ "$c" config:system:set "${s%%=*}" --value "${s#*=}" >/dev/null || morir "no pude fijar ${s%%=*}"
  done
  occ "$c" config:system:set maintenance_window_start --type integer --value 5 >/dev/null
  occ "$c" config:system:set upgrade.disable-web --type boolean --value true >/dev/null
  occ "$c" config:system:set trusted_domains 10 --value "$c-app-1" >/dev/null      # OnlyOffice entra por la red interna
  # El router hace de origen para las visitas desde la LAN (hairpin): no contarlas como ataque
  occ "$c" config:app:set bruteForce whitelist_0 --value 192.168.10.250/32 >/dev/null 2>&1
  # Enlaces públicos: contraseña propuesta por defecto y vencimiento obligatorio a 30 días
  occ "$c" config:app:set core shareapi_enable_link_password_by_default --value yes >/dev/null
  occ "$c" config:app:set core shareapi_default_expire_date --value yes >/dev/null
  occ "$c" config:app:set core shareapi_expire_after_n_days --value 30 >/dev/null
  occ "$c" config:app:set core shareapi_enforce_expire_date --value yes >/dev/null
  occ "$c" twofactorauth:enforce --on >/dev/null || morir "no pude dejar el doble factor obligatorio"
  # Carpeta del usuario limpia: sin los archivos de ejemplo ni la carpeta de plantillas de Nextcloud
  occ "$c" config:system:set skeletondirectory --value "" >/dev/null || morir "no pude quitar los archivos de ejemplo"
  occ "$c" config:system:set templatedirectory --value "" >/dev/null

  paso "Marca"
  guardar_logo
  marca "$c" || true

  paso "Correo saliente"
  local se="$BASE/shared/.env"
  occ "$c" config:system:set mail_smtpmode --value smtp >/dev/null
  occ_s "$c" config:system:set mail_smtphost --value "$(de_env "$se" SMTP_HOST)"
  occ "$c" config:system:set mail_smtpport --type integer --value "$(de_env "$se" SMTP_PORT)" >/dev/null
  occ "$c" config:system:set mail_smtpsecure --value "$(de_env "$se" SMTP_SECURE)" >/dev/null
  occ "$c" config:system:set mail_smtpauth --type boolean --value true >/dev/null
  occ_s "$c" config:system:set mail_smtpname --value "$(de_env "$se" SMTP_USER)"
  occ_s "$c" config:system:set mail_from_address --value "$(de_env "$se" SMTP_FROM)"
  occ_s "$c" config:system:set mail_domain --value "$(de_env "$se" SMTP_DOMAIN)"
  occ_s "$c" config:system:set mail_smtppassword --value "$(de_env "$se" SMTP_PASSWORD)" || morir "no pude cargar el correo saliente"

  paso "Aplicaciones"
  local app
  for app in onlyoffice files_antivirus groupfolders mail; do
    grep -q "^  - $app:" <<<"$(occ "$c" app:list --enabled 2>/dev/null)" && continue
    occ "$c" app:install "$app" >>"$VAR/clientes/$c.log" 2>&1 || occ "$c" app:enable "$app" >>"$VAR/clientes/$c.log" 2>&1 \
      || morir "no pude instalar la aplicación $app (ver $VAR/clientes/$c.log)"
  done
  occ "$c" config:app:set onlyoffice DocumentServerUrl --value "$OFFICE_URL" >/dev/null
  occ "$c" config:app:set onlyoffice DocumentServerInternalUrl --value "http://onlyoffice/" >/dev/null
  occ "$c" config:app:set onlyoffice StorageUrl --value "http://$c-app-1/" >/dev/null
  occ_s "$c" config:app:set onlyoffice jwt_secret --value "$(de_env "$se" OO_JWT_SECRET)" || morir "no pude cargar la clave de OnlyOffice"
  for s in av_mode=daemon av_host=clamav av_port=3310 av_infected_action=delete; do
    occ "$c" config:app:set files_antivirus "${s%%=*}" --value "${s#*=}" >/dev/null
  done

  paso "Usuarios"
  local uid creados=0 invitar=""
  grep -q -- '--generate-password' <<<"$(occ "$c" user:add --help 2>/dev/null)" && invitar=si
  grep -q "^  - $c:" <<<"$(occ "$c" group:list 2>/dev/null)" || occ "$c" group:add "$c" >/dev/null
  for i in "${!U_CORREO[@]}"; do
    uid="${U_CORREO[i]}"
    if ! occ "$c" user:info "$uid" >/dev/null 2>&1; then
      if [ -n "$invitar" ]; then
        # Sin contraseña inicial: Nextcloud le manda la invitación a su correo
        occ "$c" user:add --generate-password --email "$uid" --display-name "${U_NOMBRE[i]}" --group "$c" "$uid" >>"$VAR/clientes/$c.log" 2>&1 \
          || morir "no pude crear el usuario $uid (ver $VAR/clientes/$c.log)"
      else
        local k_u; k_u="$(clave 20)"
        $DOCKER exec -u www-data -e OC_PASS="$k_u" "$c-app-1" php occ user:add --password-from-env --email "$uid" \
          --display-name "${U_NOMBRE[i]}" --group "$c" "$uid" >>"$VAR/clientes/$c.log" 2>&1 || morir "no pude crear el usuario $uid"
        ( umask 077; printf '"Vault/Hepta Drive/%s","hepta-drive / %s / usuario %s","%s","%s","https://%s","Contraseña inicial: el usuario debe cambiarla."\n' "$c" "$c" "$uid" "$uid" "$k_u" "$FQDN" >> "$VAR/secretos/$c.csv" )
        unset k_u
      fi
      creados=$((creados + 1))
    fi
    occ "$c" user:setting "$uid" files quota "${U_CUOTA[i]} GB" >/dev/null
  done
  aviso "  $creados usuario/s nuevo/s de ${#U_CORREO[@]}$([ -n "$invitar" ] && echo ', invitados por correo' || echo ', con contraseña inicial en el paquete de secretos')"

  if [ "$EQUIPO_GB" -gt 0 ]; then
    paso "Carpeta de equipo ($EQUIPO_GB GB)"
    local fid
    fid="$(occ "$c" groupfolders:list --output=json 2>/dev/null | grep -o '"id":[0-9]*,"mount_point":"Equipo"' | grep -o '[0-9]*' | head -1)"
    [ -n "$fid" ] || fid="$(occ "$c" groupfolders:create Equipo 2>/dev/null | grep -o '[0-9]*' | tail -1)"
    [ -n "$fid" ] || morir "no pude crear la carpeta de equipo"
    occ "$c" groupfolders:group "$fid" "$c" write share delete >/dev/null
    occ "$c" groupfolders:quota "$fid" "$((EQUIPO_GB * 1024 * 1024 * 1024))" >/dev/null
  fi

  paso "Respaldo"
  # Volcado de base y roles en el respaldo de cada 6 horas
  if [ -f "$CONF_BACKUP" ] && ! grep -q "\"$c-nextcloud.dump|" "$CONF_BACKUP"; then
    sed -i "/^VOLCADOS_EXTRA=(/a\\  \"$c-nextcloud.dump|docker exec $c-db-1 pg_dump -U nextcloud -Fc nextcloud\"\\n  \"$c-globales.sql|docker exec $c-db-1 pg_dumpall -U nextcloud --globals-only\"" "$CONF_BACKUP"
    bash -n "$CONF_BACKUP" || morir "$CONF_BACKUP quedó con un error de sintaxis: revisar ya"
  fi
  # Acceso al repositorio de copias del cliente. El usuario en el servidor de respaldos lo crea hcsvrnd01
  # (hepta-drive-enrolar); hasta entonces el respaldo nocturno avisa que este cliente no pudo copiarse.
  if [ ! -f "$CONF_RESPALDO/$c.env" ]; then
    local k1 k2; k1="$(clave 32)"; k2="$(clave 40)"
    install -d -m 700 "$CONF_RESPALDO" "$VAR/respaldo-pendiente"
    ( umask 077
      printf "REST_CLAVE='%s'\nRESTIC_PASSWORD='%s'\n" "$k1" "$k2" > "$CONF_RESPALDO/$c.env"
      printf '"Vault/Hepta Drive/%s","HEPTA Drive respaldo – %s – acceso","%s","%s","","Usuario del servidor de respaldos (10.10.10.20)."\n' "$c" "$c" "$c" "$k1" >> "$VAR/secretos/$c.csv"
      printf '"Vault/Hepta Drive/%s","HEPTA Drive respaldo – %s – repositorio","","%s","","CRÍTICA: sin esta contraseña las copias de este cliente no se pueden leer."\n' "$c" "$c" "$k2" >> "$VAR/secretos/$c.csv" )
    unset k1 k2
    date -Is > "$VAR/respaldo-pendiente/$c"
  fi

  local total=0; for i in "${!U_CORREO[@]}"; do total=$((total + U_CUOTA[i])); done
  echo "$((total + EQUIPO_GB))" > "$VAR/clientes/$c.cuota"
  paso "Verificando"
  verificar || morir "la instancia quedó creada pero no responde bien"
  echo "listo" > "$VAR/clientes/$c.paso"
  aviso "ALTA OK: $c en el puerto $puerto → https://$FQDN (falta el vhost en el NGINX y el DNS si no hay comodín)"
  [ "$nuevo" = 1 ] && aviso "Secretos pendientes de guardar en KeePass: hepta-drive-alta secretos $c"
  return 0
}

verificar() {
  local puerto fq salida
  [ -f "$DIR/.env" ] || { echo "no existe el cliente $SLUG" >&2; return 1; }
  puerto="$(de_env "$DIR/.env" APP_PORT)"; fq="$(de_env "$DIR/.env" FQDN)"
  salida="$(curl -s -m 10 -H "Host: $fq" -H "X-Forwarded-Proto: https" "http://$IP_VM:$puerto/status.php")" || { echo "no responde en $IP_VM:$puerto" >&2; return 1; }
  grep -q '"installed":true' <<<"$salida" && grep -q '"maintenance":false' <<<"$salida" || { echo "status.php: $salida" >&2; return 1; }
  grep -qi 'is enforced' <<<"$(occ "$SLUG" twofactorauth:enforce 2>/dev/null)" || { echo "el doble factor no quedó obligatorio" >&2; return 1; }
  # Las tareas de fondo corren en el contenedor cron: tienen que llegar a OnlyOffice y al antivirus
  [ "$($DOCKER exec "$SLUG-cron-1" curl -s -m 8 http://onlyoffice/healthcheck 2>/dev/null)" = true ] \
    || { echo "el contenedor de tareas de fondo no llega a OnlyOffice" >&2; return 1; }
  $DOCKER exec "$SLUG-cron-1" bash -c 'exec 3<>/dev/tcp/clamav/3310' 2>/dev/null \
    || { echo "el contenedor de tareas de fondo no llega al antivirus" >&2; return 1; }
  # La verificación propia de OnlyOffice (también limpia un error viejo guardado)
  grep -qi 'error' <<<"$(occ "$SLUG" onlyoffice:documentserver --check 2>&1)" \
    && { echo "OnlyOffice: $(occ "$SLUG" onlyoffice:documentserver --check 2>&1 | head -2 | tr '\n' ' ')" >&2; return 1; }
  return 0
}

# ── aplicar-plantilla: lleva un cambio de la plantilla a las instancias que ya existen ──
aplicar_plantilla() {
  local d c
  [ -f "$BASE/plantilla/compose.yaml" ] || morir "falta la plantilla"
  for d in "$BASE"/clientes/*/; do
    [ -f "$d/.env" ] || continue
    c="$(basename "$d")"; [ -n "$SLUG" ] && [ "$c" != "$SLUG" ] && continue
    if cmp -s "$BASE/plantilla/compose.yaml" "$d/compose.yaml"; then aviso "$c: ya está al día"; continue; fi
    cp -p "$d/compose.yaml" "$d/compose.yaml.antes-$(date +%Y%m%d_%H%M)"
    install -m 644 "$BASE/plantilla/compose.yaml" "$d/compose.yaml"
    # Solo se recrean los contenedores cuya definición cambió
    ( cd "$d" && $DOCKER compose up -d ) 2>&1 | grep -E "Recreat|Started|Running|rror" | sed "s/^/   /"
    aviso "$c: plantilla aplicada (la anterior quedó guardada al lado)"
  done
}

estado() {
  local d c puerto fq arriba usuarios paso resp
  for d in "$BASE"/clientes/*/; do
    [ -f "$d/.env" ] || continue
    c="$(basename "$d")"; [ -n "$SLUG" ] && [ "$c" != "$SLUG" ] && continue
    puerto="$(de_env "$d/.env" APP_PORT)"; fq="$(de_env "$d/.env" FQDN)"
    arriba=$($DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -c "^$c-\(app\|db\|redis\|cron\)-1$")
    usuarios=$(occ "$c" user:list 2>/dev/null | grep -c '^  - ')
    paso="$(cat "$VAR/clientes/$c.paso" 2>/dev/null || echo '')"
    resp=enrolado; [ -f "$VAR/respaldo-pendiente/$c" ] && resp=pendiente; [ -f "$CONF_RESPALDO/$c.env" ] || resp=sin_configurar
    printf '{"slug":"%s","fqdn":"%s","puerto":%s,"contenedores":%s,"usuarios":%s,"paso":"%s","respaldo":"%s","ultima_copia":"%s","secretos_pendientes":%s,"datos":"%s"}\n' \
      "$c" "$fq" "${puerto:-0}" "$arriba" "$usuarios" "$paso" "$resp" "$(cat /var/lib/hepta-drive-respaldo/"$c".ultimo-ok 2>/dev/null)" \
      "$([ -f "$VAR/secretos/$c.csv" ] && echo true || echo false)" "$(du -sh --exclude=db "$DATOS/$c" 2>/dev/null | cut -f1)"
  done
}

secretos() {
  local f="$VAR/secretos/$SLUG.csv"
  [ -f "$f" ] || morir "no hay secretos pendientes de $SLUG (ya se entregaron, o el cliente no existe)"
  if [ "$GUARDADO" = 1 ]; then
    : > "$f" && unlink "$f" && aviso "Secretos de $SLUG borrados de la VM."
    return
  fi
  # El archivo ya nace con su fila de encabezado, para el importador CSV genérico de KeePass. No se borra acá: recién con --guardado,
  # cuando ya están en KeePass (la contraseña del repositorio de copias no se puede volver a generar).
  cat "$f"
}

baja() {
  [ "$CONFIRMAR" = "$SLUG" ] || morir "para dar de baja hay que repetir el nombre: --confirmar $SLUG"
  [ "$SLUG" != hepta ] || morir "la instancia hepta no se da de baja con este script"
  [ -f "$DIR/.env" ] || morir "no existe el cliente $SLUG"
  local dest="$DATOS/_bajas/$SLUG-$(date +%Y%m%d_%H%M)"
  aviso "Apagando $SLUG…"
  ( cd "$DIR" && $DOCKER compose down ) >>"$VAR/clientes/$SLUG.log" 2>&1 || morir "docker compose down falló"
  install -d -m 700 "$DATOS/_bajas" "$dest"
  mv "$RAIZ" "$dest/datos" && mv "$DIR" "$dest/config" || morir "no pude archivar; revisar $dest"
  [ -f "$CONF_BACKUP" ] && sed -i "/\"$SLUG-nextcloud.dump|/d; /\"$SLUG-globales.sql|/d" "$CONF_BACKUP"
  [ -f "$CONF_RESPALDO/$SLUG.env" ] && mv "$CONF_RESPALDO/$SLUG.env" "$dest/respaldo.env"
  for f in "$VAR/clientes/$SLUG".{paso,cuota,candado} "$VAR/respaldo-pendiente/$SLUG"; do [ -e "$f" ] && unlink "$f"; done
  aviso "BAJA OK. Archivado en $dest. Los datos NO se borraron: se borran a mano a los 30 días, junto con su repositorio de copias."
}

case "$ACCION" in
  preparar) preparar ;;
  validar)  necesita_slug; leer_usuarios; validar ;;
  crear)    necesita_slug; leer_usuarios; crear ;;
  verificar) necesita_slug; verificar && echo "OK: $SLUG responde y tiene el doble factor obligatorio" ;;
  marca)    necesita_slug; [ -f "$DIR/.env" ] || morir "no existe el cliente $SLUG"; guardar_logo; marca "$SLUG" ;;
  aplicar-plantilla) [ -z "$SLUG" ] || slug_ok "$SLUG" || morir "nombre inválido"; aplicar_plantilla ;;
  estado)   [ -z "$SLUG" ] || slug_ok "$SLUG" || morir "nombre inválido"; estado ;;
  secretos) necesita_slug; secretos ;;
  baja)     necesita_slug; baja ;;
  *) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
