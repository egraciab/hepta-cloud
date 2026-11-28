#!/usr/bin/env python3
"""hepta-drive-salud.py — salud interna de la VM hepta-drive. Corre cada 15 minutos en la VM.

El vigía de hcsvrnd01 ve HEPTA Drive desde afuera (Nextcloud y OnlyOffice responden), pero no llega a lo que vive
dentro de la VM. Esto revisa lo de adentro:

  - ClamAV responde, y lo prueba como lo ve Nextcloud: desde un contenedor de cliente, por la red hd-shared, a
    clamav:3310. Si no responde, Nextcloud rechaza las subidas ("No connection to anti virus").
  - Las firmas tienen como mucho FIRMAS_MAX_DIAS días (4). freshclam revisa varias veces por día, pero ClamAV
    a veces pasa 2 o 3 días sin publicar una base nueva: menos de 4 avisaría en falso.
  - La RAM disponible no baja de RAM_MIN_GIB (si baja, es hora de darle más a la VM).
  - El volumen de datos (/srv/nextcloud) no pasa de DISCO_MAX_PCT por ciento.

Avisa con una señal a healthchecks.io: "todo bien" o "falla" con el detalle. Si la señal deja de llegar (VM apagada,
cron roto) también avisa healthchecks.io, desde afuera.

  hepta-drive-salud.py               revisión normal (la que corre el cron)
  hepta-drive-salud.py --estado      muestra cómo está cada cosa, sin mandar señal
  hepta-drive-salud.py --configurar  pide la dirección de la señal (sin mostrarla) y la guarda en el .conf (600)

Configuración en /etc/hepta-drive-salud.conf: SENAL=https://hc-ping.com/... y, si hace falta cambiarlos,
FIRMAS_MAX_DIAS, RAM_MIN_GIB, DISCO_MAX_PCT, DATOS. La dirección de la señal es una credencial: no va al repo ni al chat.
"""
import getpass, os, re, shutil, subprocess, sys, urllib.request
from datetime import datetime, timezone

CONF = os.environ.get('HEPTA_DRIVE_SALUD_CONF', '/etc/hepta-drive-salud.conf')
RED = 'hd-shared'
ESPERA = 20

# ── Configuración ──

def leer_conf():
    c = {}
    try:
        with open(CONF, encoding='utf-8') as f:
            for linea in f:
                m = re.match(r'\s*([A-Z_]+)=(.*)$', linea.rstrip('\n'))
                if m:
                    v = m.group(2).strip()
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in '\'"':
                        v = v[1:-1]
                    c[m.group(1)] = v
    except OSError:
        pass
    return c


def numero(c, clave, defecto):
    try:
        return float(c.get(clave, defecto))
    except ValueError:
        return float(defecto)

# ── Chequeos ──

PHP_VERSION = (
    '$s=@fsockopen("clamav",3310,$en,$es,10);'
    'if(!$s){fwrite(STDERR,"sin conexión: $es");exit(1);}'
    'stream_set_timeout($s,10);fwrite($s,"zVERSION\\0");echo stream_get_contents($s);'
)


def contenedor_cliente():
    """Un Nextcloud de cliente en marcha, conectado a la red compartida."""
    r = subprocess.run(['docker', 'ps', '--filter', f'network={RED}', '--filter', 'name=-app-1',
                        '--format', '{{.Names}}'], capture_output=True, text=True, timeout=ESPERA)
    nombres = sorted(n for n in r.stdout.split() if n)
    return nombres[0] if nombres else None


def probar_clamav(max_dias):
    """Devuelve dos resultados: ClamAV responde y firmas al día."""
    try:
        c = contenedor_cliente()
        if not c:
            return [(False, 'ClamAV', f'no hay ningún Nextcloud en marcha en la red {RED} para probar'),
                    (False, 'Firmas de ClamAV', 'sin dato')]
        r = subprocess.run(['docker', 'exec', '-u', 'www-data', c, 'php', '-r', PHP_VERSION],
                           capture_output=True, text=True, timeout=ESPERA)
    except (OSError, subprocess.TimeoutExpired) as ex:
        return [(False, 'ClamAV', f'no se pudo probar: {ex}'), (False, 'Firmas de ClamAV', 'sin dato')]
    salida = r.stdout.strip().strip('\0')
    # Ejemplo: "ClamAV 1.5.5/28194/Thu Nov 27 07:26:11 2026"
    m = re.match(r'ClamAV (\S+)/(\d+)/(.+)$', salida)
    if r.returncode != 0 or not m:
        motivo = (r.stderr.strip() or salida or f'código {r.returncode}')[:200]
        return [(False, 'ClamAV', f'no responde desde {c}: {motivo}'), (False, 'Firmas de ClamAV', 'sin dato')]
    res = [(True, 'ClamAV', f'responde desde {c} (versión {m.group(1)})')]
    try:
        fecha = datetime.strptime(m.group(3).strip(), '%a %b %d %H:%M:%S %Y').replace(tzinfo=timezone.utc)
        dias = (datetime.now(timezone.utc) - fecha).total_seconds() / 86400
        texto = f'base {m.group(2)}, del {fecha:%Y-%m-%d %H:%M} UTC (hace {dias:.1f} días)'
        res.append((dias <= max_dias, 'Firmas de ClamAV', texto))
    except ValueError:
        res.append((False, 'Firmas de ClamAV', f'fecha que no se entiende: {m.group(3)}'))
    return res


def probar_ram(min_gib):
    try:
        with open('/proc/meminfo') as f:
            kb = int(re.search(r'^MemAvailable:\s+(\d+)', f.read(), re.M).group(1))
    except (OSError, AttributeError, ValueError) as ex:
        return False, 'RAM disponible', f'no se pudo leer: {ex}'
    gib = kb / 1024 / 1024
    return gib >= min_gib, 'RAM disponible', f'{gib:.1f} GiB (mínimo {min_gib:g})'


def probar_disco(ruta, max_pct):
    try:
        u = shutil.disk_usage(ruta)
    except OSError as ex:
        return False, f'Disco {ruta}', f'no se pudo leer: {ex}'
    if not os.path.ismount(ruta):
        return False, f'Disco {ruta}', 'no está montado'
    pct = u.used * 100 / u.total
    return pct <= max_pct, f'Disco {ruta}', f'{pct:.0f}% usado, quedan {u.free / 1024**3:.0f} GiB (máximo {max_pct:g}%)'


def revisar(c):
    res = probar_clamav(numero(c, 'FIRMAS_MAX_DIAS', 4))
    res.append(probar_ram(numero(c, 'RAM_MIN_GIB', 4)))
    res.append(probar_disco(c.get('DATOS', '/srv/nextcloud'), numero(c, 'DISCO_MAX_PCT', 85)))
    return res

# ── Señal ──

def senal(url, falla, texto):
    try:
        req = urllib.request.Request(url + ('/fail' if falla else ''), data=texto.encode('utf-8')[:10000],
                                     headers={'User-Agent': 'hepta-drive-salud/1'})
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status == 200
    except Exception:
        return False


def configurar():
    url = getpass.getpass('Dirección de la señal de healthchecks.io (no se muestra): ').strip()
    if not re.match(r'^https://\S+$', url):
        print('No parece una dirección https://. No se guardó nada.')
        return 1
    lineas = []
    try:
        with open(CONF, encoding='utf-8') as f:
            lineas = [l for l in f.read().splitlines() if not l.startswith('SENAL=')]
    except OSError:
        pass
    viejo = os.umask(0o077)
    try:
        with open(CONF, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lineas + [f"SENAL='{url}'"]) + '\n')
    finally:
        os.umask(viejo)
    os.chmod(CONF, 0o600)
    print(f'Guardada en {CONF} (600).')
    print('Señal de prueba recibida.' if senal(url, False, 'prueba de hepta-drive-salud') else 'NO se pudo enviar la señal: revisá la dirección.')
    return 0


def main():
    if '--configurar' in sys.argv:
        return configurar()
    c = leer_conf()
    res = revisar(c)
    fallas = [r for r in res if not r[0]]
    texto = '\n'.join(f"{'OK   ' if ok else 'FALLA'}  {nombre}: {detalle}" for ok, nombre, detalle in res)
    if '--estado' in sys.argv:
        print(texto)
        return 1 if fallas else 0
    ahora = f'{datetime.now():%F %T}'
    if fallas:
        print(f'{ahora} ' + ' · '.join(f'{n}: {d}' for _, n, d in fallas), file=sys.stderr)
    url = c.get('SENAL')
    if not url:
        print(f'{ahora} sin SENAL en {CONF}: correr hepta-drive-salud --configurar', file=sys.stderr)
        return 2
    if not senal(url, bool(fallas), texto):
        print(f'{ahora} no se pudo enviar la señal a healthchecks.io', file=sys.stderr)
    return 1 if fallas else 0


if __name__ == '__main__':
    sys.exit(main())
