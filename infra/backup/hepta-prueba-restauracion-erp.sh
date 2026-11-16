#!/usr/bin/env bash
# hepta-prueba-restauracion-erp.sh — restauración de prueba del ERP, de punta a punta, desde la copia de Drive.
# Corre en hcsvrnd01. Demuestra que con lo que hay FUERA de la sala se recuperan los datos del ERP:
#
#   1. Baja de Drive (descifrando) el volcado de heptagroup y el paquete de adjuntos, y verifica sus sumas.
#   2. Levanta dentro de la VM del ERP un Postgres TEMPORAL, con la misma imagen que producción, sin red
#      (Odoo no lo ve: ningún cron, correo ni envío a la SET puede salir de la copia).
#   3. Restaura el volcado ahí y compara contra producción: clientes, facturas, apuntes, pagos, adjuntos.
#   4. Comprueba que los adjuntos que la base nombra estén en el paquete de archivos.
#   5. Vuelve a volcar la base restaurada (regla del 2026-11-04: si no se puede volver a respaldar, no sirve).
#   6. Borra todo lo temporal y deja el informe en el NAS: hepta-backups/pruebas-restauracion/.
#
# No toca la base de producción (solo le hace consultas de lectura) ni reinicia nada.
# Uso: hepta-prueba-restauracion-erp.sh            (tarda unos minutos)
set -uo pipefail

PROYECTO="${HEPTA_PROYECTO:-HEPTA}"
VM=HGSVRLNX111
BASE=heptagroup
CONT_PROD=odoo19-proyecto-db-1
USUARIO_PG=odoo
REMOTO="${HEPTA_DRIVE_REMOTO:-gdrive-crypt}"
NAS="${HEPTA_NAS:-/mnt/nas/hepta-backups}"
TRABAJO="/root/restauracion-prueba/$(date +%Y%m%d_%H%M)"
INFORME_DIR="$NAS/pruebas-restauracion"
RESULTADO=OK
linea() { echo "$*" | tee -a "$TRABAJO/informe.txt"; }
mal()   { RESULTADO=FALLA; linea "  ✗ FALLA: $*"; }
ojo()   { [ "$RESULTADO" = OK ] && RESULTADO=AVISO; linea "  ! AVISO: $*"; }
bien()  { linea "  ✓ $*"; }
en_vm() { lxc exec --project "$PROYECTO" "$VM" -- "$@"; }

command -v rclone >/dev/null && command -v zstd >/dev/null || { echo "Faltan rclone o zstd" >&2; exit 2; }
mkdir -p "$TRABAJO" "$INFORME_DIR" || exit 2
T0=$(date +%s)
linea "RESTAURACIÓN DE PRUEBA DEL ERP — $(date '+%F %H:%M') (hora del nodo) — origen: Google Drive ($REMOTO)"
linea ""

# ── 1. Bajar de Drive ──
linea "1. Copia fuera de sitio"
PAQUETE="$(rclone lsf "$REMOTO:hepta-backups/$VM/archivos/" 2>/dev/null | grep -E '^archivos-[0-9]{8}\.tar\.zst$' | sort | tail -1)"
[ -n "$PAQUETE" ] || { mal "no hay paquetes de adjuntos de $VM en Drive"; exit 1; }
DIA_PAQ="${PAQUETE#archivos-}"; DIA_PAQ="${DIA_PAQ%.tar.zst}"
# El paquete del día D se arma con la copia de la última corrida del día anterior: se usa esa corrida,
# así los adjuntos y la base son del mismo momento.
CORRIDA="$(rclone lsf "$REMOTO:hepta-backups/$VM/dumps/" 2>/dev/null | tr -d / | grep -E '^[0-9]{8}_[0-9]{4}$' | awk -v d="$DIA_PAQ" -F_ '$1 < d' | sort | tail -1)"
[ -n "$CORRIDA" ] || CORRIDA="$(rclone lsf "$REMOTO:hepta-backups/$VM/dumps/" | tr -d / | grep -E '^[0-9]{8}_[0-9]{4}$' | sort | tail -1)"
[ -n "$CORRIDA" ] || { mal "no hay corridas de $VM en Drive"; exit 1; }
linea "  corrida: $CORRIDA   paquete de adjuntos: $PAQUETE"
rclone copy "$REMOTO:hepta-backups/$VM/dumps/$CORRIDA" "$TRABAJO/dump" --include "$BASE.dump" --include "_sha256.txt" --include "_estado.json" 2>&1 | tail -2
rclone copy "$REMOTO:hepta-backups/$VM/archivos/$PAQUETE" "$TRABAJO/" 2>&1 | tail -2
DUMP="$TRABAJO/dump/$BASE.dump"
[ -s "$DUMP" ] || { mal "no se pudo bajar $BASE.dump de Drive"; exit 1; }
if ( cd "$TRABAJO/dump" && grep " $BASE.dump\$" _sha256.txt | sha256sum --quiet -c - ) 2>/dev/null; then
  bien "volcado bajado y descifrado: $(du -h "$DUMP" | cut -f1), la suma coincide con la que se tomó en la VM"
else mal "la suma del volcado bajado no coincide con la original"; fi
if zstd -q -t "$TRABAJO/$PAQUETE" 2>/dev/null; then bien "paquete de adjuntos íntegro: $(du -h "$TRABAJO/$PAQUETE" | cut -f1)"
else mal "el paquete de adjuntos está dañado"; fi
TAM_DUMP=$(stat -c %s "$DUMP")

# ── 2 y 3. Postgres temporal dentro de la VM, restaurar y contar ──
linea ""; linea "2. Restauración en un Postgres temporal (misma imagen que producción, sin red)"
en_vm mkdir -p /root/restauracion-prueba
lxc file push --project "$PROYECTO" "$DUMP" "$VM/root/restauracion-prueba/$BASE.dump" || { mal "no se pudo llevar el volcado a la VM"; exit 1; }

en_vm bash -s -- "$BASE" "$CONT_PROD" "$USUARIO_PG" > "$TRABAJO/vm.txt" 2> "$TRABAJO/vm.err" <<'EN_VM'
set -uo pipefail
BASE="$1"; PROD="$2"; U="$3"; T=restauracion-prueba-pg; D=/root/restauracion-prueba
limpiar() { docker rm -f -v "$T" >/dev/null 2>&1; rm -rf "$D"; }
trap limpiar EXIT
docker rm -f -v "$T" >/dev/null 2>&1
IMAGEN="$(docker inspect -f '{{.Config.Image}}' "$PROD")"
echo "IMAGEN=$IMAGEN"
CLAVE="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --name "$T" --network none -e POSTGRES_USER="$U" -e POSTGRES_PASSWORD="$CLAVE" -e POSTGRES_DB=postgres "$IMAGEN" >/dev/null || { echo "ERROR=no arrancó el Postgres temporal"; exit 1; }
for i in $(seq 1 60); do docker exec "$T" pg_isready -U "$U" -q 2>/dev/null && break; sleep 1; done
sleep 2
docker exec "$T" pg_isready -U "$U" -q || { echo "ERROR=el Postgres temporal no quedó listo"; exit 1; }
docker exec "$T" createdb -U "$U" "$BASE" || { echo "ERROR=no se pudo crear la base"; exit 1; }
t0=$(date +%s)
docker exec -i "$T" pg_restore -U "$U" -d "$BASE" --no-owner --no-privileges < "$D/$BASE.dump" 2> "$D/restore.err"
echo "RESTORE_SALIDA=$?"
echo "RESTORE_SEG=$(( $(date +%s) - t0 ))"
echo "RESTORE_ERRORES=$(grep -c 'pg_restore: error' "$D/restore.err")"
grep 'pg_restore: error' "$D/restore.err" | head -3 | sed 's/^/RESTORE_ERR=/'
q() { docker exec "$1" psql -U "$U" -d "$BASE" -Atc "$2" 2>/dev/null | head -1; }
for t in res_partner account_move account_move_line account_payment sale_order ir_attachment res_users; do
  echo "TABLA=$t|$(q "$PROD" "select count(*) from $t")|$(q "$T" "select count(*) from $t")"
done
echo "ULT_FACTURA=$(q "$T" "select coalesce(max(write_date)::text,'') from account_move")"
echo "MODULOS=$(q "$T" "select count(*) from ir_module_module where state='installed'")"
echo "VECTOR=$(q "$T" "select extversion from pg_extension where extname='vector'")"
# regla del 2026-11-04: la base restaurada se tiene que poder volver a respaldar
echo "REDUMP_BYTES=$(docker exec "$T" pg_dump -U "$U" -Fc "$BASE" 2> "$D/redump.err" | wc -c)"
echo "REDUMP_ERR=$(head -c 200 "$D/redump.err" | tr '\n' ' ')"
echo "---ADJUNTOS---"
docker exec "$T" psql -U "$U" -d "$BASE" -Atc "select store_fname from ir_attachment where store_fname is not null" 2>/dev/null
EN_VM
SALIDA_VM=$?
v() { sed -n "s/^$1=//p" "$TRABAJO/vm.txt" | head -1; }
[ "$SALIDA_VM" -eq 0 ] || mal "el paso dentro de la VM terminó con error: $(v ERROR) $(head -c 200 "$TRABAJO/vm.err")"
linea "  imagen: $(v IMAGEN)"
if [ "$(v RESTORE_SALIDA)" = 0 ] && [ "$(v RESTORE_ERRORES)" = 0 ]; then bien "pg_restore sin errores, en $(v RESTORE_SEG) s"
elif [ -n "$(v RESTORE_SALIDA)" ]; then mal "pg_restore terminó con $(v RESTORE_ERRORES) error(es): $(v RESTORE_ERR)"; fi
[ -n "$(v VECTOR)" ] && bien "extensión pgvector presente (versión $(v VECTOR))" || ojo "la base restaurada no tiene la extensión vector"

linea ""; linea "3. Lo restaurado contra producción (producción siguió trabajando desde el volcado: puede tener algo más)"
linea "$(printf '  %-20s %12s %12s' tabla producción restaurado)"
while IFS='|' read -r t p r; do
  t="${t#TABLA=}"; linea "$(printf '  %-20s %12s %12s' "$t" "${p:-?}" "${r:-?}")"
  if [ -z "$r" ] || [ "$r" = 0 ]; then mal "la tabla $t quedó vacía o no se pudo leer"
  elif [ -n "$p" ] && [ "$r" -gt "$p" ]; then ojo "$t tiene más filas en la copia que en producción"
  elif [ -n "$p" ] && [ $(( p - r )) -gt $(( p / 20 + 50 )) ]; then ojo "$t tiene bastante menos filas que producción ($r de $p)"; fi
done < <(grep '^TABLA=' "$TRABAJO/vm.txt")
linea "  última factura modificada en la copia: $(v ULT_FACTURA)   módulos instalados: $(v MODULOS)"

# ── 4. Adjuntos ──
linea ""; linea "4. Adjuntos: lo que la base nombra contra lo que hay en el paquete"
sed -n '/^---ADJUNTOS---$/,$p' "$TRABAJO/vm.txt" | tail -n +2 | grep -v '^$' | LC_ALL=C sort -u > "$TRABAJO/en_base.txt"
zstd -dc "$TRABAJO/$PAQUETE" | tar -tf - 2>/dev/null | grep "filestore/$BASE/" | grep -v '/$' | sed "s#.*filestore/$BASE/##" | LC_ALL=C sort -u > "$TRABAJO/en_paquete.txt"
N_BASE=$(wc -l < "$TRABAJO/en_base.txt"); N_PAQ=$(wc -l < "$TRABAJO/en_paquete.txt")
FALTAN=$(LC_ALL=C comm -23 "$TRABAJO/en_base.txt" "$TRABAJO/en_paquete.txt" | wc -l)
linea "  la base nombra $N_BASE archivos; el paquete trae $N_PAQ"
if [ "$N_BASE" -eq 0 ] || [ "$N_PAQ" -eq 0 ]; then mal "no se pudo comparar los adjuntos"
elif [ "$FALTAN" -eq 0 ]; then bien "están todos"
elif [ $(( FALTAN * 100 )) -le "$N_BASE" ]; then ojo "faltan $FALTAN de $N_BASE (menos del 1 %): suelen ser adjuntos creados entre la copia de archivos y el volcado"
else mal "faltan $FALTAN de $N_BASE adjuntos en el paquete"; fi

# ── 5. Volver a respaldar ──
linea ""; linea "5. La base restaurada se puede volver a respaldar"
RB="$(v REDUMP_BYTES)"
if [ -n "$RB" ] && [ "$RB" -gt $(( TAM_DUMP * 7 / 10 )) ]; then bien "pg_dump de la copia: $(( RB / 1024 / 1024 )) MB (el original pesa $(( TAM_DUMP / 1024 / 1024 )) MB)"
else mal "pg_dump de la copia falló o salió chico (${RB:-0} bytes): $(v REDUMP_ERR)"; fi

# ── 6. Cierre ──
linea ""; linea "RESULTADO: $RESULTADO — duración total: $(( ($(date +%s) - T0) / 60 )) min $(( ($(date +%s) - T0) % 60 )) s"
linea "Lo temporal (contenedor y archivos en la VM) ya se borró. Producción no se tocó."
cp "$TRABAJO/informe.txt" "$INFORME_DIR/$(date +%F)-$VM-$RESULTADO.txt" && echo "Informe guardado en $INFORME_DIR/$(date +%F)-$VM-$RESULTADO.txt"
rm -rf "$TRABAJO/dump" "$TRABAJO/$PAQUETE" "$TRABAJO/en_base.txt" "$TRABAJO/en_paquete.txt" "$TRABAJO/vm.txt"
[ "$RESULTADO" = FALLA ] && exit 1 || exit 0
