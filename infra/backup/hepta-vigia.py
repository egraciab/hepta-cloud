#!/usr/bin/env python3
"""hepta-vigia.py — vigía de los servicios de HEPTA. Corre cada 5 minutos en hcsvrnd01.

Revisa que los sitios y el correo respondan y que los respaldos no tengan alertas. Avisa por correo cuando algo
se cae (después de dos revisiones seguidas con falla, para no avisar por un tropiezo de segundos), recuerda cada
6 horas mientras siga caído y avisa cuando vuelve.

Además manda una señal a healthchecks.io en cada pasada. Si la señal deja de llegar (corte de luz, de internet,
el nodo apagado) o llega como "falla", ese servicio avisa DESDE AFUERA: es lo que cubre el caso en que el correo
propio también está caído.

  hepta-vigia.py                revisión normal (la que corre el cron)
  hepta-vigia.py --estado       muestra cómo está cada cosa ahora, sin avisar a nadie
  hepta-vigia.py --configurar   pide la dirección de la señal de healthchecks.io y la guarda
  hepta-vigia.py --probar       manda un correo y una señal de prueba

Qué revisa: la lista de abajo (CHEQUEOS), o las líneas CHEQUEO= de /etc/hepta-vigia.conf si las hay.
El correo sale con los datos de /etc/hepta-backup-correo.conf (los mismos de los informes de respaldos).
"""
import html, json, os, re, smtplib, socket, ssl, sys, urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

CONF = os.environ.get('HEPTA_VIGIA_CONF', '/etc/hepta-vigia.conf')
CONF_CORREO = os.environ.get('HEPTA_CORREO_CONF', '/etc/hepta-backup-correo.conf')
ESTADO = os.environ.get('HEPTA_VIGIA_ESTADO', '/var/lib/hepta-vigia/estado.json')
NAS = os.environ.get('HEPTA_NAS', '/mnt/nas/hepta-backups')
MONTAJE = os.environ.get('HEPTA_NAS_MONTAJE', '/mnt/nas')
PY = timezone(timedelta(hours=-3))
FALLOS_PARA_AVISAR = 2          # revisiones seguidas con falla antes de avisar (2 × 5 min)
RECORDAR_CADA_H = 6
ESPERA = 10                      # segundos por chequeo

# tipo | nombre | destino          (http: tiene que responder 200 con certificado válido · tcp: el puerto tiene que abrir)
CHEQUEOS = [
    ('http', 'Hepta Cloud (sitio, Admin y portal)', 'https://cloud.hepta.com.py/api/health'),
    ('http', 'RetoPA', 'https://retopa.com.py/'),
    ('http', 'Tenants Odoo (clientes)', 'https://demo.erp.hepta.com.py/web/health'),
    ('http', 'ERP del grupo', 'https://group.hepta.com.py/web/health'),
    ('http', 'Centro de Mando', 'https://mando.hepta.com.py/login.php'),
    ('http', 'Correo: webmail', 'https://mail.hepta.com.py/'),
    ('tcp', 'Correo: envío (465)', 'mail.hepta.com.py:465'),
    ('tcp', 'Correo: envío (587)', 'mail.hepta.com.py:587'),
    ('tcp', 'Correo: lectura (993)', 'mail.hepta.com.py:993'),
]


def leer_conf(ruta):
    c, chequeos = {}, []
    try:
        with open(ruta, encoding='utf-8') as f:
            for linea in f:
                m = re.match(r'\s*([A-Z_]+)=(.*)$', linea.rstrip('\n'))
                if not m:
                    continue
                v = m.group(2).strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in '\'"':
                    v = v[1:-1].replace("'\\''", "'")
                if m.group(1) == 'CHEQUEO':
                    p = [x.strip() for x in v.split('|')]
                    if len(p) == 3 and p[0] in ('http', 'tcp'):
                        chequeos.append(tuple(p))
                else:
                    c[m.group(1)] = v
    except OSError:
        pass
    return c, chequeos


def probar_http(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'hepta-vigia/1'})
        with urllib.request.urlopen(req, timeout=ESPERA, context=ssl.create_default_context()) as r:
            return (True, '') if r.status == 200 else (False, f"respondió {r.status}")
    except urllib.error.HTTPError as ex:
        return False, f"respondió {ex.code}"
    except Exception as ex:
        motivo = getattr(ex, 'reason', ex)
        return False, re.sub(r'\s+', ' ', str(motivo))[:140] or type(ex).__name__


def probar_tcp(destino):
    host, _, puerto = destino.rpartition(':')
    try:
        with socket.create_connection((host, int(puerto)), timeout=ESPERA):
            return True, ''
    except Exception as ex:
        return False, re.sub(r'\s+', ' ', str(ex))[:140] or type(ex).__name__


def probar_respaldos(ahora):
    """Los respaldos como un chequeo más: NAS montado, sin alertas y con una copia reciente."""
    if not os.path.ismount(MONTAJE):
        return False, f"{MONTAJE} no está montado"
    try:
        with open(f"{NAS}/ALERTA.txt", encoding='utf-8', errors='replace') as f:
            lineas = [l.strip() for l in f.read().splitlines()[1:] if l.strip()]
        return False, 'alerta de respaldos: ' + ' · '.join(lineas)[:300]
    except OSError:
        pass
    try:
        with open(f"{NAS}/ultimo-retiro-ok") as f:
            horas = (ahora - datetime.fromisoformat(f.read().strip())).total_seconds() / 3600
        if horas > 4:
            return False, f"la última copia al NAS sin problemas fue hace {horas:.0f} horas"
    except (OSError, ValueError):
        return False, 'no hay registro de copias al NAS'
    return True, ''


def revisar(chequeos, ahora):
    res = []
    for tipo, nombre, destino in chequeos:
        ok, motivo = probar_http(destino) if tipo == 'http' else probar_tcp(destino)
        if not ok:                                   # un segundo intento: evita avisar por un paquete perdido
            ok, motivo = probar_http(destino) if tipo == 'http' else probar_tcp(destino)
        res.append({'id': f"{tipo}:{destino}", 'nombre': nombre, 'destino': destino, 'ok': ok, 'motivo': motivo})
    ok, motivo = probar_respaldos(ahora)
    res.append({'id': 'respaldos', 'nombre': 'Respaldos (copia al NAS)', 'destino': NAS, 'ok': ok, 'motivo': motivo})
    return res


def fecha(d):
    return d.astimezone(PY).strftime('%d/%m %H:%M')


def enviar(asunto, cuerpo_html, texto):
    c, _ = leer_conf(CONF_CORREO)
    m = EmailMessage()
    m['Subject'] = asunto
    m['From'] = f"Vigía HEPTA <{c['SMTP_REMITENTE']}>"
    m['To'] = c['SMTP_DESTINATARIOS']
    m['Date'] = formatdate(localtime=True)
    m['Message-ID'] = make_msgid(domain=c['SMTP_REMITENTE'].split('@')[-1])
    m.set_content(texto)
    m.add_alternative(cuerpo_html, subtype='html')
    puerto = int(c.get('SMTP_PUERTO', '465'))
    ctx = ssl.create_default_context()
    seguridad = c.get('SMTP_SEGURIDAD', 'ssl' if puerto == 465 else 'starttls')
    if seguridad == 'ssl':
        s = smtplib.SMTP_SSL(c['SMTP_SERVIDOR'], puerto, timeout=30, context=ctx)
    else:
        s = smtplib.SMTP(c['SMTP_SERVIDOR'], puerto, timeout=30)
        if seguridad != 'ninguna':
            s.starttls(context=ctx)
    with s:
        if c.get('SMTP_USUARIO'):
            s.login(c['SMTP_USUARIO'], c.get('SMTP_CLAVE', ''))
        s.send_message(m, to_addrs=[d.strip() for d in c['SMTP_DESTINATARIOS'].split(',') if d.strip()])


def senal(url, falla=False, texto=''):
    """Señal a healthchecks.io: 'sigo vivo y todo bien' o 'sigo vivo pero hay algo caído'."""
    if not url:
        return None
    try:
        req = urllib.request.Request(url.rstrip('/') + ('/fail' if falla else ''), data=texto.encode('utf-8')[:9000] or None,
                                     headers={'User-Agent': 'hepta-vigia/1'})
        with urllib.request.urlopen(req, timeout=ESPERA) as r:
            return r.status == 200
    except Exception:
        return False


def cuerpo(titulo, color, bloques, ahora):
    filas = ''
    for encabezado, c, items in bloques:
        if not items:
            continue
        filas += f'<tr><td style="padding:14px 14px 4px;font-size:11px;font-weight:bold;color:#5F6368;letter-spacing:1px;text-transform:uppercase">{html.escape(encabezado)}</td></tr>'
        for it in items:
            filas += (f'<tr><td style="padding:9px 12px;border-bottom:1px solid #E8EAED;border-left:4px solid {c}">'
                      f'<div style="font-weight:bold;color:#202124;font-size:14px">{html.escape(it["nombre"])}</div>'
                      f'<div style="color:#5F6368;font-size:12px;margin-top:2px">{html.escape(it["detalle"])}</div></td></tr>')
    return f'''<!DOCTYPE html><html lang="es"><body style="margin:0;padding:16px;background:#F1F3F4;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;border-collapse:separate;overflow:hidden;border:1px solid #DADCE0">
<tr><td style="background:{color};padding:18px 16px;color:#fff"><div style="font-size:12px;opacity:.9;letter-spacing:1px;text-transform:uppercase">Vigía HEPTA</div>
<div style="font-size:20px;font-weight:bold;margin-top:4px">{html.escape(titulo)}</div><div style="font-size:13px;margin-top:6px;opacity:.95">{fecha(ahora)} (hora de Paraguay)</div></td></tr>
{filas}
<tr><td style="padding:14px 12px;font-size:11px;color:#80868B">Revisión cada 5 minutos desde hcsvrnd01. Estado actual: <span style="font-family:Consolas,monospace">hepta-vigia --estado</span></td></tr></table></body></html>'''


def main():
    args = sys.argv[1:]
    ahora = datetime.now(timezone.utc)
    conf, propios = leer_conf(CONF)
    chequeos = propios or CHEQUEOS
    url_senal = conf.get('SENAL_URL', '')

    if '--configurar' in args:
        print('En healthchecks.io: crear un chequeo con período 5 minutos y gracia 10 minutos, y copiar su dirección (https://hc-ping.com/...).')
        url = input('Dirección de la señal (vacío para no usar el aviso externo): ').strip()
        if url and not re.match(r'^https://[A-Za-z0-9.-]+/[A-Za-z0-9/_-]{8,}$', url):
            print('No parece una dirección de señal válida; no se guardó nada.'); return 1
        lineas = []
        try:
            with open(CONF, encoding='utf-8') as f:
                lineas = [l for l in f.read().splitlines() if not l.startswith('SENAL_URL=')]
        except OSError:
            lineas = ['# Vigía de servicios HEPTA. Solo root (600).',
                      '# Para cambiar qué se revisa, agregar líneas  CHEQUEO=http|Nombre|https://...  o  CHEQUEO=tcp|Nombre|host:puerto',
                      '# (si hay alguna línea CHEQUEO, reemplazan a la lista que trae el programa).']
        if url:
            lineas.append(f"SENAL_URL='{url}'")
        old = os.umask(0o077)
        with open(CONF, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lineas) + '\n')
        os.umask(old); os.chmod(CONF, 0o600)
        print(f"Guardado en {CONF}." + (' Probando la señal…' if url else ''))
        if url:
            print('  señal recibida por healthchecks.io' if senal(url) else '  NO se pudo enviar la señal: revisá la dirección')
        return 0

    res = revisar(chequeos, ahora)
    caidos = [r for r in res if not r['ok']]

    if '--estado' in args:
        for r in res:
            print(f"  {'OK   ' if r['ok'] else 'CAÍDO'}  {r['nombre']:<38} {r['motivo']}")
        print(f"\n{len(res) - len(caidos)} de {len(res)} bien." + ('' if url_senal else '  (aviso externo sin configurar)'))
        return 0

    if '--probar' in args:
        lista = [{'nombre': r['nombre'], 'detalle': 'bien' if r['ok'] else 'CAÍDO: ' + r['motivo']} for r in res]
        try:
            enviar(f"[PRUEBA] Vigía HEPTA: {len(res) - len(caidos)} de {len(res)} bien", cuerpo('Prueba del vigía', '#1A73E8', [('Estado ahora', '#1A73E8', lista)], ahora),
                   '\n'.join(f"{x['nombre']}: {x['detalle']}" for x in lista))
            print('Correo de prueba enviado.')
        except Exception as ex:
            print(f"NO se pudo enviar el correo: {type(ex).__name__}: {ex}")
        if url_senal:
            print('Señal de prueba recibida por healthchecks.io.' if senal(url_senal) else 'NO se pudo enviar la señal.')
        else:
            print('Aviso externo sin configurar (hepta-vigia --configurar).')
        return 0

    # ── revisión normal: comparar con la pasada anterior ──
    try:
        with open(ESTADO, encoding='utf-8') as f:
            estado = json.load(f)
    except (OSError, ValueError):
        estado = {}
    nuevos, recuperados, recordar, siguen = [], [], [], []
    for r in res:
        e = estado.get(r['id'], {'fallos': 0, 'avisado': False})
        if r['ok']:
            if e.get('avisado'):
                desde = datetime.fromisoformat(e['desde'])
                recuperados.append({'nombre': r['nombre'], 'detalle': f"volvió; estuvo caído desde {fecha(desde)} ({int((ahora - desde).total_seconds() // 60)} min)"})
            estado[r['id']] = {'fallos': 0, 'avisado': False}
            continue
        e['fallos'] = e.get('fallos', 0) + 1
        e.setdefault('desde', ahora.isoformat())
        if e['fallos'] == 1:
            e['desde'] = ahora.isoformat()
        item = {'nombre': r['nombre'], 'detalle': f"{r['motivo']} · desde {fecha(datetime.fromisoformat(e['desde']))} · {r['destino']}"}
        if e['fallos'] >= FALLOS_PARA_AVISAR and not e.get('avisado'):
            e['avisado'] = True; e['ultimo_aviso'] = ahora.isoformat(); nuevos.append(item)
        elif e.get('avisado') and (ahora - datetime.fromisoformat(e.get('ultimo_aviso', e['desde']))).total_seconds() >= RECORDAR_CADA_H * 3600:
            e['ultimo_aviso'] = ahora.isoformat(); recordar.append(item)
        elif e.get('avisado'):
            siguen.append(item)
        estado[r['id']] = e
    for k in list(estado):                               # chequeos que ya no existen
        if k not in {r['id'] for r in res}:
            del estado[k]

    salida = 0
    if nuevos or recuperados or recordar:
        if nuevos:
            titulo, color, icono = 'Se cayó: ' + ', '.join(x['nombre'] for x in nuevos), '#D93025', '❌'
        elif recordar:
            titulo, color, icono = 'Sigue caído: ' + ', '.join(x['nombre'] for x in recordar), '#D93025', '❌'
        else:
            titulo, color, icono = 'Volvió: ' + ', '.join(x['nombre'] for x in recuperados), '#1E8E3E', '✅'
        bloques = [('Se cayó ahora', '#D93025', nuevos), ('Sigue caído', '#D93025', recordar + (siguen if nuevos or recuperados else [])), ('Volvió', '#1E8E3E', recuperados)]
        texto = '\n'.join(f"{b[0]}: {x['nombre']} - {x['detalle']}" for b in bloques for x in b[2])
        try:
            enviar(f"{icono} {titulo[:150]}", cuerpo(titulo[:200], color, bloques, ahora), texto)
            print(f"{datetime.now():%F %T} aviso enviado: {titulo}")
        except Exception as ex:
            salida = 1                                    # sin correo: queda el aviso externo
            print(f"{datetime.now():%F %T} ERROR: no se pudo enviar el aviso ({type(ex).__name__}: {ex}): {titulo}", file=sys.stderr)

    avisados = [r for r in res if not r['ok'] and estado[r['id']].get('avisado')]
    if url_senal:
        ok_senal = senal(url_senal, falla=bool(avisados), texto='\n'.join(f"CAIDO {r['nombre']}: {r['motivo']}" for r in avisados))
        if ok_senal is False:
            print(f"{datetime.now():%F %T} no se pudo enviar la señal a healthchecks.io", file=sys.stderr)

    os.makedirs(os.path.dirname(ESTADO), exist_ok=True)
    with open(ESTADO + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(estado, f)
    os.replace(ESTADO + '.tmp', ESTADO)
    return salida


if __name__ == '__main__':
    sys.exit(main())
