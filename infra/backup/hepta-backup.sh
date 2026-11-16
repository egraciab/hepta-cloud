#!/usr/bin/env bash
# hepta-backup.sh — respaldo consistente de UNA VM: bases Postgres, carpetas de datos y configuración.
#
# Deja todo en $DESTINO (por defecto /var/backups/hepta), de donde lo retira el servidor de respaldos
# (hepta-backup-retirar.sh, corre en el nodo que tiene el NAS). La VM nunca escribe en el NAS.
#
# Regla que no se negocia (lección del 2026-11-04, cuando el ERP generó dumps de 0 bytes durante meses
# sin que nadie lo notara): un dump vacío o ilegible es un respaldo FALLIDO. El script termina con error
# y NO actualiza "ultimo-ok"; el control de vida mira ese archivo.
#
# Uso:   hepta-backup.sh            respaldo completo
#        hepta-backup.sh --solo-ver muestra qué respaldaría, sin escribir nada
# Config: /etc/hepta-backup.conf (una por VM, en infra/backup/conf/)
set -uo pipefail

CONF="${HEPTA_BACKUP_CONF:-/etc/hepta-backup.conf}"
[ -r "$CONF" ] || { echo "ERROR: falta $CONF" >&2; exit 2; }

# ── Valores por defecto (el conf los pisa) ──
NOMBRE="$(hostname)"
DESTINO=/var/backups/hepta
PG_MODO=ninguno            # host | docker | ninguno
PG_CONTENEDOR=""           # solo docker
PG_USUARIO=postgres        # usuario de Postgres con el que se hace el dump
PG_BASES=auto              # "auto" = todas menos plantillas, o lista separada por espacios
PG_EXCLUIR=""              # bases que no se respaldan (separadas por espacios)
DIRECTORIOS=()             # carpetas de datos (filestore, uploads): copia espejo con rsync
CONFIGS=()                 # archivos y carpetas chicas de configuración: un .tar.gz por corrida
                           # En las dos listas, "?/ruta" = opcional: si no existe se saltea sin dar error.
RETENER=8                  # corridas que quedan en la VM (el histórico largo vive en el servidor de respaldos)
# shellcheck disable=SC1090
. "$CONF"

SOLO_VER=0; [ "${1:-}" = "--solo-ver" ] && SOLO_VER=1
[ "$(id -u)" = 0 ] || { echo "ERROR: corré como root" >&2; exit 2; }

# Herramientas que hacen falta según lo configurado
for h in flock tar $([ "${#DIRECTORIOS[@]}" -gt 0 ] && echo rsync) $([ "$PG_MODO" = docker ] && echo docker); do
  command -v "$h" >/dev/null || { echo "ERROR: falta el programa '$h' (apt install $h)" >&2; exit 2; }
done

MARCA="$(date +%Y%m%d_%H%M)"
CORRIDA="$DESTINO/dumps/$MARCA"
ERRORES=()
BASES_OK=()
aviso() { echo "[$(date +%H:%M:%S)] $*"; }
falla() { ERRORES+=("$*"); echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }

# ── Postgres: cómo se llega según el modo ──
pg() {   # pg <programa> <args...>
  case "$PG_MODO" in
    host)   runuser -u postgres -- "$@" ;;
    docker) docker exec -i "$PG_CONTENEDOR" "$@" ;;
  esac
}
usuario_pg() { [ "$PG_MODO" = docker ] && echo "-U $PG_USUARIO"; }

listar_bases() {
  if [ "$PG_BASES" != auto ]; then echo "$PG_BASES" | tr ' ' '\n'; return; fi
  # shellcheck disable=SC2046
  pg psql $(usuario_pg) -d postgres -Atc "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1" 2>/dev/null
}

if [ "$SOLO_VER" = 1 ]; then
  echo "VM: $NOMBRE   destino: $DESTINO   retener: $RETENER corridas"
  echo "Postgres ($PG_MODO${PG_CONTENEDOR:+, contenedor $PG_CONTENEDOR}):"
  if [ "$PG_MODO" != ninguno ]; then
    for b in $(listar_bases); do
      case " $PG_EXCLUIR " in *" $b "*) echo "  - $b (excluida)";; *) echo "  - $b";; esac
    done
  else echo "  (sin Postgres)"; fi
  falta() { case "$1" in \?*) echo "  - ${1#\?}  (opcional, no existe: se saltea)";; *) echo "  - $1  ¡NO EXISTE!";; esac; }
  echo "Carpetas de datos:"; for d in "${DIRECTORIOS[@]:-}"; do [ -n "$d" ] && { [ -d "${d#\?}" ] && echo "  - ${d#\?} ($(du -sh "${d#\?}" 2>/dev/null | cut -f1))" || falta "$d"; }; done
  echo "Configuración:";     for c in "${CONFIGS[@]:-}";     do [ -n "$c" ] && { [ -e "${c#\?}" ] && echo "  - ${c#\?}" || falta "$c"; }; done
  exit 0
fi

# ── Una sola corrida a la vez ──
mkdir -p "$DESTINO" && chmod 700 "$DESTINO"
exec 9>"$DESTINO/.candado"
flock -n 9 || { echo "Ya hay un respaldo corriendo; salgo." >&2; exit 0; }

INICIO="$(date -Is)"
mkdir -p "$CORRIDA"
aviso "Respaldo de $NOMBRE → $CORRIDA"

# ── 1. Bases Postgres ──
if [ "$PG_MODO" != ninguno ]; then
  BASES="$(listar_bases)" || BASES=""
  [ -n "$BASES" ] || falla "no se pudo listar las bases de Postgres ($PG_MODO)"
  # shellcheck disable=SC2046
  if pg pg_dumpall $(usuario_pg) --globals-only > "$CORRIDA/_globales.sql" 2>"$CORRIDA/_globales.err" && [ -s "$CORRIDA/_globales.sql" ]; then
    rm -f "$CORRIDA/_globales.err"
  else falla "roles y permisos globales: $(head -c 300 "$CORRIDA/_globales.err" 2>/dev/null)"; fi
  for b in $BASES; do
    case " $PG_EXCLUIR " in *" $b "*) continue;; esac
    f="$CORRIDA/$b.dump"
    # shellcheck disable=SC2046
    if ! pg pg_dump $(usuario_pg) -Fc "$b" > "$f" 2>"$f.err"; then
      falla "pg_dump de $b falló: $(head -c 300 "$f.err")"; continue
    fi
    if [ ! -s "$f" ]; then falla "el dump de $b salió VACÍO"; continue; fi
    # Legible de punta a punta: pg_restore tiene que poder leer el índice
    if ! pg pg_restore -l < "$f" > /dev/null 2>"$f.err"; then
      falla "el dump de $b no se puede leer: $(head -c 300 "$f.err")"; continue
    fi
    rm -f "$f.err"
    BASES_OK+=("$b:$(stat -c %s "$f")")
    aviso "  base $b: $(du -h "$f" | cut -f1)"
  done
fi

# ── 2. Carpetas de datos (espejo; el servidor de respaldos guarda el histórico) ──
for d in "${DIRECTORIOS[@]:-}"; do
  [ -n "$d" ] || continue
  case "$d" in \?*) d="${d#\?}"; [ -d "$d" ] || continue;; esac
  if [ ! -d "$d" ]; then falla "la carpeta $d no existe"; continue; fi
  dest="$DESTINO/archivos/$(echo "$d" | sed 's#^/##; s#/#__#g')"
  mkdir -p "$dest"
  if rsync -a --delete "$d/" "$dest/" 2>"$CORRIDA/_rsync.err"; then
    aviso "  carpeta $d: $(du -sh "$dest" | cut -f1)"
  else falla "copia de $d: $(head -c 300 "$CORRIDA/_rsync.err")"; fi
done
rm -f "$CORRIDA/_rsync.err"

# ── 3. Configuración ──
LISTA=(); for c in "${CONFIGS[@]:-}"; do
  [ -n "$c" ] || continue
  case "$c" in \?*) c="${c#\?}"; [ -e "$c" ] || continue;; esac
  if [ -e "$c" ]; then LISTA+=("$c"); else falla "configuración: $c no existe"; fi
done
if [ "${#LISTA[@]}" -gt 0 ]; then
  if tar -czf "$CORRIDA/_config.tar.gz" --ignore-failed-read -P "${LISTA[@]}" 2>"$CORRIDA/_config.err" && [ -s "$CORRIDA/_config.tar.gz" ]; then
    rm -f "$CORRIDA/_config.err"; aviso "  configuración: $(du -h "$CORRIDA/_config.tar.gz" | cut -f1)"
  else falla "configuración: $(head -c 300 "$CORRIDA/_config.err")"; fi
fi
chmod -R go-rwx "$DESTINO"

# ── 4. Estado (lo lee el control de vida) ──
FIN="$(date -Is)"
{
  printf '{"vm":"%s","corrida":"%s","inicio":"%s","fin":"%s","ok":%s,"bases":[' "$NOMBRE" "$MARCA" "$INICIO" "$FIN" "$([ "${#ERRORES[@]}" -eq 0 ] && echo true || echo false)"
  sep=""; for x in "${BASES_OK[@]:-}"; do [ -n "$x" ] && { printf '%s{"base":"%s","bytes":%s}' "$sep" "${x%%:*}" "${x##*:}"; sep=","; }; done
  printf '],"errores":['
  sep=""; for e in "${ERRORES[@]:-}"; do [ -n "$e" ] && { printf '%s"%s"' "$sep" "$(echo "$e" | tr -d '\n"\\' | cut -c1-300)"; sep=","; }; done
  printf ']}\n'
} > "$DESTINO/estado.json"
cp "$DESTINO/estado.json" "$CORRIDA/_estado.json"

if [ "${#ERRORES[@]}" -gt 0 ]; then
  mv "$CORRIDA" "$CORRIDA.FALLIDA"
  aviso "RESPALDO FALLIDO (${#ERRORES[@]} error/es). No se actualiza ultimo-ok."
  exit 1
fi

date -Is > "$DESTINO/ultimo-ok"
# ── 5. Limpieza: quedan las últimas $RETENER corridas buenas y las fallidas de la última semana ──
ls -1d "$DESTINO"/dumps/[0-9]*_[0-9][0-9][0-9][0-9] 2>/dev/null | sort -r | tail -n +$((RETENER + 1)) | xargs -r rm -rf
find "$DESTINO/dumps" -maxdepth 1 -name '*.FALLIDA' -mtime +7 -exec rm -rf {} + 2>/dev/null
aviso "Respaldo OK: ${#BASES_OK[@]} base/s."
