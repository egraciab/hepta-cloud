#!/usr/bin/env python3
"""hepta-backup-informe.py — informe por correo de los respaldos. Corre en hcsvrnd01 (el nodo con el NAS).

  hepta-backup-informe.py diario     resumen de las últimas 24 horas
  hepta-backup-informe.py semanal    resumen de los últimos 7 días y del export semanal de las VM completas
  ... --ver archivo.html             no envía: deja el informe en ese archivo para mirarlo
  ... --prueba                       envía el informe con "[PRUEBA]" en el asunto

Lee solo el NAS: lo que dejan hepta-backup-retirar.sh (historial de corridas y de pasadas) y export-vms.sh.
Colores: verde = todo bien · naranja = hay algo para mirar, pero hay respaldo · rojo = falta un respaldo.
Configuración del correo: /etc/hepta-backup-correo.conf (la escribe hepta-backup-correo-configurar.sh).
"""
import glob, html, json, os, re, shutil, smtplib, ssl, sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

MONTAJE = os.environ.get('HEPTA_NAS_MONTAJE', '/mnt/nas')
NAS = os.environ.get('HEPTA_NAS', MONTAJE + '/hepta-backups')
EXPORTS = os.environ.get('HEPTA_EXPORTS', MONTAJE + '/lxd-exports')
CONF = os.environ.get('HEPTA_CORREO_CONF', '/etc/hepta-backup-correo.conf')
VMS = os.environ.get('HEPTA_VMS', 'hepta-cloud retopa-core HGSVRLNX104 HGSVRLNX111 dkr-hgsvrlnx003 v-HGSVRLNX004').split()
NOMBRES = {'hepta-cloud': 'Hepta Cloud', 'retopa-core': 'RetoPA', 'HGSVRLNX104': 'Tenants Odoo', 'HGSVRLNX111': 'ERP del grupo',
           'dkr-hgsvrlnx003': 'Nginx perimetral', 'v-HGSVRLNX004': 'Correo (mailcow)'}
PY = timezone(timedelta(hours=-3))          # hora de Paraguay
CADA_H, MAX_H = 6, 7                         # los respaldos corren cada 6 h; más de 7 h sin uno bueno es error
OK, AVISO, ERROR = 0, 1, 2
COLOR = {OK: '#1E8E3E', AVISO: '#E37400', ERROR: '#D93025'}
FONDO = {OK: '#E6F4EA', AVISO: '#FEF3E0', ERROR: '#FCE8E6'}
ETIQUETA = {OK: 'OK', AVISO: 'AVISO', ERROR: 'ERROR'}
MESES = 'ene feb mar abr may jun jul ago sep oct nov dic'.split()


def fecha(d, hora=True):
    d = d.astimezone(PY)
    return f"{d.day}-{MESES[d.month - 1]}" + (f" {d:%H:%M}" if hora else '')


def tam(b):
    for u in ('B', 'KB', 'MB', 'GB', 'TB'):
        if b < 1024 or u == 'TB':
            return f"{b:.0f} {u}" if u in ('B', 'KB') or b >= 100 else f"{b:.1f} {u}".replace('.', ',')
        b /= 1024


def leer_jsonl(ruta):
    filas = []
    try:
        with open(ruta, encoding='utf-8', errors='replace') as f:
            for linea in f:
                try:
                    filas.append(json.loads(linea))
                except ValueError:
                    pass
    except OSError:
        pass
    return filas


def corridas_de(vm):
    """Todas las corridas conocidas de una VM (buenas y fallidas), sin repetir, de vieja a nueva."""
    vistas = {}
    filas = leer_jsonl(f"{NAS}/{vm}/historial.jsonl")
    for f in glob.glob(f"{NAS}/{vm}/dumps/*/_estado.json"):       # las copiadas antes de que existiera el historial
        filas += leer_jsonl(f)
    for c in filas:
        try:
            c['_fin'] = datetime.fromisoformat(c['fin'])
        except (KeyError, ValueError):
            continue
        vistas[(c.get('corrida'), bool(c.get('ok')))] = c
    return sorted(vistas.values(), key=lambda c: c['_fin'])


def evaluar_vm(vm, ahora, dias):
    desde = ahora - timedelta(days=dias)
    todas = corridas_de(vm)
    en_ventana = [c for c in todas if c['_fin'] >= desde]
    buenas = [c for c in en_ventana if c.get('ok')]
    fallidas = [c for c in en_ventana if not c.get('ok')]
    todas_buenas = [c for c in todas if c.get('ok')]
    r = {'vm': vm, 'nombre': NOMBRES.get(vm, vm), 'buenas': len(buenas), 'fallidas': len(fallidas), 'estado': OK,
         'notas': [], 'errores': [], 'ultima': None, 'bytes': 0, 'volcados': 0, 'crecimiento': None}
    if not todas:
        r['estado'] = ERROR
        r['notas'].append('No hay ningún respaldo de esta VM en el NAS.')
        return r
    ultima_buena = todas_buenas[-1] if todas_buenas else None
    if ultima_buena:
        r['ultima'] = ultima_buena['_fin']
        r['bytes'] = sum(b.get('bytes', 0) for b in ultima_buena.get('bases', []))
        r['volcados'] = len(ultima_buena.get('bases', []))
    for c in fallidas:
        for e in c.get('errores', []) or ['falló sin detalle']:
            r['errores'].append(f"{fecha(c['_fin'])}: {e}")
    # ── Rojo: no hay respaldo vigente ──
    edad = (ahora - ultima_buena['_fin']).total_seconds() / 3600 if ultima_buena else None
    if not ultima_buena:
        r['estado'] = ERROR; r['notas'].append('Nunca tuvo un respaldo bueno.')
    elif edad > MAX_H:
        r['estado'] = ERROR; r['notas'].append(f"El último respaldo bueno es de hace {edad:.0f} horas.")
    elif not todas[-1].get('ok'):
        r['estado'] = ERROR; r['notas'].append('La corrida más reciente falló.')
    # ── Naranja: hay respaldo, pero algo no salió como se esperaba ──
    if r['estado'] == OK:
        if fallidas:
            r['estado'] = AVISO; r['notas'].append(f"{len(fallidas)} corrida(s) fallaron; la última salió bien.")
        esperadas = int(min(dias * 24, (ahora - todas[0]['_fin']).total_seconds() / 3600) // CADA_H)
        if len(buenas) < esperadas - (1 if dias == 1 else 2):
            r['estado'] = AVISO; r['notas'].append(f"Se esperaban unas {esperadas} corridas y hubo {len(buenas)}.")
        if len(todas_buenas) >= 2:      # un volcado que se achica de golpe suele ser un problema
            antes = {b['base']: b.get('bytes', 0) for b in todas_buenas[-2].get('bases', [])}
            for b in ultima_buena.get('bases', []):
                a = antes.get(b['base'], 0)
                if a > 1024 * 1024 and b.get('bytes', 0) < a * 0.7:
                    r['estado'] = AVISO
                    r['notas'].append(f"El volcado {b['base']} se achicó {100 - b['bytes'] * 100 // a}% respecto del anterior.")
    if dias > 1 and len(buenas) >= 2:
        ini = sum(b.get('bytes', 0) for b in buenas[0].get('bases', []))
        fin = sum(b.get('bytes', 0) for b in buenas[-1].get('bases', []))
        if ini:
            r['crecimiento'] = (fin - ini) * 100 / ini
    return r


def evaluar_retiro(ahora, dias):
    desde = ahora - timedelta(days=dias)
    pasadas = []
    for p in leer_jsonl(f"{NAS}/historial-retiro.jsonl"):
        try:
            p['_t'] = datetime.fromisoformat(p['t'])
        except (KeyError, ValueError):
            continue
        if p['_t'] >= desde:
            pasadas.append(p)
    r = {'pasadas': len(pasadas), 'con_alertas': sum(1 for p in pasadas if p.get('alertas')), 'estado': OK, 'notas': [], 'alertas': []}
    try:
        with open(f"{NAS}/ALERTA.txt", encoding='utf-8', errors='replace') as f:
            r['alertas'] = [l.strip() for l in f.read().splitlines()[1:] if l.strip()]
        r['estado'] = ERROR; r['notas'].append('Hay una alerta abierta ahora mismo.')
    except OSError:
        pass
    try:
        with open(f"{NAS}/ultimo-retiro-ok") as f:
            edad = (ahora - datetime.fromisoformat(f.read().strip())).total_seconds() / 3600
        r['ultimo'] = edad
        if edad > 4 and r['estado'] == OK:
            r['estado'] = ERROR; r['notas'].append(f"La última copia al NAS sin problemas fue hace {edad:.0f} horas (corre cada 3).")
    except (OSError, ValueError):
        r['estado'] = ERROR; r['notas'].append('No hay registro de ninguna copia al NAS sin problemas.')
    if r['estado'] == OK and r['con_alertas']:
        r['estado'] = AVISO; r['notas'].append(f"{r['con_alertas']} de {r['pasadas']} pasadas tuvieron alguna alerta, ya resuelta.")
    try:
        d = shutil.disk_usage(MONTAJE)
        r['libre'], r['total'] = d.free, d.total
        pct = d.free * 100 / d.total
        if pct < 5:
            r['estado'] = ERROR; r['notas'].append(f"Al NAS le queda {pct:.0f}% libre.")
        elif pct < 15 and r['estado'] == OK:
            r['estado'] = AVISO; r['notas'].append(f"Al NAS le queda {pct:.0f}% libre.")
    except OSError:
        pass
    return r


def evaluar_export(ahora):
    r = {'estado': OK, 'notas': [], 'lotes': [], 'vms': [], 'minutos': None, 'fecha': None, 'total': 0}
    completos = sorted(d for d in glob.glob(f"{EXPORTS}/[0-9]*_[0-9]*") if os.path.isfile(d + '/_LOTE_COMPLETO'))
    r['lotes'] = [os.path.basename(d) for d in completos]
    try:
        with open(f"{EXPORTS}/ultimo-lote-fallo", encoding='utf-8', errors='replace') as f:
            r['estado'] = ERROR; r['notas'].append('El último lote falló: ' + f.read().strip()[:200])
    except OSError:
        pass
    try:
        with open(f"{EXPORTS}/ultimo-lote-ok") as f:
            r['fecha'] = datetime.fromisoformat(f.read().strip())
        dias = (ahora - r['fecha']).days
        if dias >= 8:
            r['estado'] = ERROR; r['notas'].append(f"El último lote completo es de hace {dias} días (corre los domingos).")
    except (OSError, ValueError):
        if r['estado'] == OK:
            r['estado'] = AVISO; r['notas'].append('Todavía no hay ningún lote semanal completo.')
    if completos:
        ultimo = completos[-1]
        try:
            with open(f"{EXPORTS}/export-{os.path.basename(ultimo)}.log", encoding='utf-8', errors='replace') as f:
                log = f.read()
            vm = None
            for linea in log.splitlines():
                m = re.match(r'---- (\S+)', linea)
                if m:
                    vm = m.group(1)
                m = re.match(r'\s+OK (\S+) en (\d+) s', linea)
                if m and vm:
                    r['vms'].append((vm, m.group(1), int(m.group(2))))
                m = re.match(r'== resumen \((\d+) min', linea)
                if m:
                    r['minutos'] = int(m.group(1))
        except OSError:
            pass
        r['total'] = sum(os.path.getsize(f) for f in glob.glob(ultimo + '/*.tar.*') if not f.endswith('.sha256'))
    return r


# ── HTML (tablas y estilos en línea: es lo que los programas de correo muestran bien) ──
def e(s):
    return html.escape(str(s))


def pastilla(estado):
    return (f'<span style="display:inline-block;padding:2px 10px;border-radius:10px;background:{COLOR[estado]};color:#fff;'
            f'font-size:11px;font-weight:bold;letter-spacing:.5px">{ETIQUETA[estado]}</span>')


def fila(estado, titulo, detalle, notas=(), errores=()):
    extra = ''.join(f'<div style="color:{COLOR[estado]};font-size:12px;margin-top:3px">{e(n)}</div>' for n in notas)
    extra += ''.join(f'<div style="color:#5F6368;font-size:11px;margin-top:3px;font-family:Consolas,monospace">{e(x)[:260]}</div>' for x in errores[:4])
    return (f'<tr><td style="padding:10px 12px;border-bottom:1px solid #E8EAED;border-left:4px solid {COLOR[estado]};vertical-align:top">'
            f'<div style="font-weight:bold;color:#202124;font-size:14px">{e(titulo)}</div>'
            f'<div style="color:#5F6368;font-size:12px;margin-top:2px">{detalle}</div>{extra}</td>'
            f'<td style="padding:10px 12px;border-bottom:1px solid #E8EAED;text-align:right;vertical-align:top;white-space:nowrap">{pastilla(estado)}</td></tr>')


def seccion(titulo, filas):
    return (f'<tr><td colspan="2" style="padding:18px 12px 6px;font-size:11px;font-weight:bold;color:#5F6368;letter-spacing:1px;'
            f'text-transform:uppercase">{e(titulo)}</td></tr>' + ''.join(filas))


def armar(tipo, ahora):
    dias = 1 if tipo == 'diario' else 7
    vms = [evaluar_vm(v, ahora, dias) for v in VMS]
    ret = evaluar_retiro(ahora, dias)
    exp = evaluar_export(ahora)
    general = max([v['estado'] for v in vms] + [ret['estado'], exp['estado']])
    n = {s: sum(1 for v in vms if v['estado'] == s) for s in (OK, AVISO, ERROR)}
    titular = {OK: 'Todos los respaldos están bien', AVISO: 'Respaldos hechos, con avisos para mirar', ERROR: 'Hay respaldos con error'}[general]
    periodo = 'Últimas 24 horas' if dias == 1 else 'Últimos 7 días'

    f_vms = []
    for v in vms:
        if v['ultima']:
            det = f"{v['buenas']} corrida(s) buena(s)" + (f", {v['fallidas']} fallida(s)" if v['fallidas'] else '')
            det += f" &middot; última: {e(fecha(v['ultima']))}"
            det += f" &middot; {v['volcados']} volcado(s), {e(tam(v['bytes']))}" if v['volcados'] else ' &middot; solo archivos y configuración'
            if v['crecimiento'] is not None and abs(v['crecimiento']) >= 1:
                det += f" &middot; {'+' if v['crecimiento'] > 0 else ''}{v['crecimiento']:.0f}% en la semana"
        else:
            det = 'Sin respaldos'
        f_vms.append(fila(v['estado'], f"{v['nombre']}  ({v['vm']})", det, v['notas'], v['errores']))

    det = f"{ret['pasadas']} pasada(s) en el período" if ret['pasadas'] else 'Sin historial de pasadas todavía'
    if 'libre' in ret:
        det += f" &middot; NAS: {e(tam(ret['libre']))} libres de {e(tam(ret['total']))}"
    f_nas = [fila(ret['estado'], 'Copia al NAS (cada 3 horas)', det, ret['notas'], ret['alertas'])]

    if exp['fecha']:
        det = f"Último lote completo: {e(fecha(exp['fecha']))}"
        if exp['total']:
            det += f" &middot; {e(tam(exp['total']))}"
        if exp['minutos'] is not None:
            det += f" &middot; {exp['minutos']} min"
        det += f" &middot; {len(exp['lotes'])} lote(s) guardado(s)"
    else:
        det = 'Corre los domingos a las 02:00'
    f_exp = [fila(exp['estado'], 'Export semanal de las VM completas', det, exp['notas'])]
    if tipo == 'semanal' and exp['vms']:
        celdas = ''.join(f'<tr><td style="padding:3px 10px 3px 0;color:#202124">{e(NOMBRES.get(v, v))}</td>'
                         f'<td style="padding:3px 10px;color:#5F6368;text-align:right">{e(t)}</td>'
                         f'<td style="padding:3px 0 3px 10px;color:#5F6368;text-align:right">{s // 60} min {s % 60:02d} s</td></tr>' for v, t, s in exp['vms'])
        f_exp.append(f'<tr><td colspan="2" style="padding:6px 12px 10px 16px;border-bottom:1px solid #E8EAED"><table style="font-size:12px;border-collapse:collapse">{celdas}</table></td></tr>')

    orden = [seccion('Export semanal (VM completas)', f_exp), seccion(f'Respaldos de datos por VM · {periodo.lower()}', f_vms), seccion('Copia al NAS', f_nas)]
    if tipo == 'diario':
        orden = [orden[1], orden[2], orden[0]]
    resumen = f"{n[OK]} VM bien" + (f" &middot; {n[AVISO]} con aviso" if n[AVISO] else '') + (f" &middot; {n[ERROR]} con error" if n[ERROR] else '')
    cuerpo = f'''<!DOCTYPE html><html lang="es"><body style="margin:0;padding:16px;background:#F1F3F4;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#fff;border-radius:10px;border-collapse:separate;overflow:hidden;border:1px solid #DADCE0">
<tr><td colspan="2" style="background:{COLOR[general]};padding:20px 16px;color:#fff">
  <div style="font-size:12px;opacity:.9;letter-spacing:1px;text-transform:uppercase">Respaldos HEPTA &middot; informe {tipo}</div>
  <div style="font-size:21px;font-weight:bold;margin-top:4px">{e(titular)}</div>
  <div style="font-size:13px;margin-top:6px;opacity:.95">{periodo}, hasta el {e(fecha(ahora))} &middot; {resumen}</div>
</td></tr>
{''.join(orden)}
<tr><td colspan="2" style="padding:16px 12px;font-size:11px;color:#80868B;line-height:1.5">
  <span style="color:{COLOR[OK]};font-weight:bold">Verde</span>: todo bien &middot;
  <span style="color:{COLOR[AVISO]};font-weight:bold">Naranja</span>: hay respaldo, pero algo para mirar &middot;
  <span style="color:{COLOR[ERROR]};font-weight:bold">Rojo</span>: falta un respaldo vigente.<br>
  Enviado desde hcsvrnd01. Detalle en /mnt/nas/hepta-backups y en el runbook de respaldos.
</td></tr></table></body></html>'''
    lineas = [f"Respaldos HEPTA - informe {tipo} - {titular}", f"{periodo}, hasta el {fecha(ahora)}", '']
    for v in vms:
        lineas.append(f"[{ETIQUETA[v['estado']]}] {v['nombre']} ({v['vm']}): {v['buenas']} buenas, {v['fallidas']} fallidas. " + ' '.join(v['notas']))
    lineas.append(f"[{ETIQUETA[ret['estado']]}] Copia al NAS. " + ' '.join(ret['notas'] + ret['alertas']))
    lineas.append(f"[{ETIQUETA[exp['estado']]}] Export semanal. " + ' '.join(exp['notas']))
    icono = {OK: '✅', AVISO: '⚠️', ERROR: '❌'}[general]
    asunto = f"{icono} Respaldos HEPTA · {tipo} · {titular} ({fecha(ahora, False)})"
    return general, asunto, cuerpo, '\n'.join(lineas)


def leer_conf():
    c = {}
    with open(CONF, encoding='utf-8') as f:
        for linea in f:
            m = re.match(r'\s*([A-Z_]+)=(.*)$', linea.rstrip('\n'))
            if m:
                v = m.group(2).strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in '\'"':
                    v = v[1:-1].replace("'\\''", "'")
                c[m.group(1)] = v
    return c


def enviar(asunto, cuerpo, texto):
    c = leer_conf()
    m = EmailMessage()
    m['Subject'] = asunto
    m['From'] = f"{c.get('SMTP_NOMBRE', 'Respaldos HEPTA')} <{c['SMTP_REMITENTE']}>"
    m['To'] = c['SMTP_DESTINATARIOS']
    m['Date'] = formatdate(localtime=True)
    m['Message-ID'] = make_msgid(domain=c['SMTP_REMITENTE'].split('@')[-1])
    m.set_content(texto)
    m.add_alternative(cuerpo, subtype='html')
    puerto = int(c.get('SMTP_PUERTO', '465'))
    ctx = ssl.create_default_context()
    if c.get('SMTP_VERIFICAR_TLS', 'si').lower() in ('no', '0', 'false'):
        ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    seguridad = c.get('SMTP_SEGURIDAD', 'ssl' if puerto == 465 else 'starttls')
    if seguridad == 'ssl':
        s = smtplib.SMTP_SSL(c['SMTP_SERVIDOR'], puerto, timeout=30, context=ctx)
    else:
        s = smtplib.SMTP(c['SMTP_SERVIDOR'], puerto, timeout=30)
        if seguridad != 'ninguna':                                  # 'ninguna' es solo para pruebas locales
            s.starttls(context=ctx)
    with s:
        if c.get('SMTP_USUARIO'):
            s.login(c['SMTP_USUARIO'], c.get('SMTP_CLAVE', ''))
        s.send_message(m, to_addrs=[d.strip() for d in c['SMTP_DESTINATARIOS'].split(',') if d.strip()])


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ('diario', 'semanal'):
        print(__doc__); return 2
    ahora = datetime.now(timezone.utc)
    if os.environ.get('HEPTA_AHORA'):                              # solo para pruebas
        ahora = datetime.fromisoformat(os.environ['HEPTA_AHORA'])
    general, asunto, cuerpo, texto = armar(args[0], ahora)
    if '--ver' in args:
        with open(args[args.index('--ver') + 1], 'w', encoding='utf-8') as f:
            f.write(cuerpo)
        print(asunto); return 0
    if '--prueba' in args:
        asunto = '[PRUEBA] ' + asunto
    try:
        enviar(asunto, cuerpo, texto)
    except Exception as ex:                                         # el motivo queda en el log del cron
        print(f"{datetime.now():%F %T} ERROR: no se pudo enviar el informe {args[0]}: {type(ex).__name__}: {ex}", file=sys.stderr)
        return 1
    print(f"{datetime.now():%F %T} informe {args[0]} enviado: {asunto}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
