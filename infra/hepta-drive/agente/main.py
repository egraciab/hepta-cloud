#!/usr/bin/env python3
"""
HEPTA Drive — agente de alta. Corre en la VM hepta-drive (10.10.50.220:8888, TLS), como root.

Es la puerta por la que el Admin de HEPTA Cloud pide el alta de un cliente de drive. No sabe hacer nada por su
cuenta: cada pedido termina en /usr/local/sbin/hepta-drive-alta, el mismo script que se usa por consola.

  GET  /health                         está vivo (no dice nada más)
  GET  /clientes                       estado de todas las instancias
  GET  /clientes/{slug}                estado de una
  POST /validar                        revisa un pedido sin cambiar nada
  POST /crear                          alta en segundo plano → 202 con un trabajo
  GET  /trabajos/{id}                  cómo va el trabajo (paso actual y últimas líneas)
  POST /clientes/{slug}/verificar      comprueba que la instancia responde
  GET  /clientes/{slug}/usuarios       usuarios de la instancia
  POST /clientes/{slug}/usuarios       suma usuarios en segundo plano → 202 con un trabajo
  POST /clientes/{slug}/usuarios/estado     habilita o deshabilita a un usuario
  POST /clientes/{slug}/usuarios/eliminar   borra a un usuario (pasando antes sus archivos a otro, si se pide) → 202
  POST /clientes/{slug}/dominio        dominio propio del cliente: fase "aceptar" o "principal"
  GET  /clientes/{slug}/secretos       paquete para KeePass (CSV). No se borra al leerlo
  POST /clientes/{slug}/secretos/guardado   lo borra de la VM, cuando ya está en KeePass

  POST /clientes/{slug}/suspension     suspende (modo mantenimiento) o reactiva
  POST /clientes/{slug}/baja           apaga y archiva la instancia, con una última copia antes → 202 con un trabajo.
                                       No borra datos: quedan archivados en la VM y en el servidor de respaldos.

Seguridad: clave en la cabecera X-API-Key, filtro por IP de origen (ALLOWED_IPS) y TLS con certificado propio,
porque por acá pasa el paquete de secretos. Los secretos no se escriben en el registro.
"""
import hmac
import json
import logging
import os
import re
import subprocess
import threading
import time
import uuid

from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.security import APIKeyHeader

VERSION = "1.4.0"
API_KEY = os.getenv("DRIVE_API_KEY", "")
ALLOWED_IPS = {ip.strip() for ip in os.getenv("ALLOWED_IPS", "").split(",") if ip.strip()}
ALTA = os.getenv("HD_ALTA", "/usr/local/sbin/hepta-drive-alta")
VAR = os.getenv("HD_VAR", "/var/lib/hepta-drive")
TRABAJOS_DIR = os.path.join(VAR, "agente", "trabajos")
LOG_FILE = os.getenv("LOG_FILE", "/var/log/hepta-drive-agente.log")
MAX_USUARIOS = 200

if len(API_KEY) < 32:
    raise SystemExit("DRIVE_API_KEY tiene que tener 32 caracteres o más (generala en KeePass)")
os.makedirs(TRABAJOS_DIR, mode=0o700, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.FileHandler(LOG_FILE), logging.StreamHandler()])
log = logging.getLogger("hepta.drive")

app = FastAPI(title="HEPTA Drive — agente de alta", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
cabecera = APIKeyHeader(name="X-API-Key", auto_error=True)

SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,30}[a-z0-9]$")
CORREO_RE = re.compile(r"^[a-z0-9._+-]{1,64}@[a-z0-9.-]{3,190}$")
NOMBRE_RE = re.compile(r"^[^\"'\\`$|<>\r\n]{1,80}$")


# ── Quién puede hablarle ──
@app.middleware("http")
async def solo_origenes_permitidos(request: Request, call_next):
    origen = request.client.host if request.client else ""
    if ALLOWED_IPS and origen not in ALLOWED_IPS:
        log.warning("Rechazado: origen %s no permitido (%s %s)", origen, request.method, request.url.path)
        return JSONResponse(status_code=403, content={"detail": "Origen no permitido"})
    return await call_next(request)


def con_clave(clave: str = Security(cabecera)):
    if not hmac.compare_digest(clave.encode(), API_KEY.encode()):
        log.warning("Clave inválida")
        raise HTTPException(status_code=401, detail="Clave inválida")
    return True


# ── Validación del pedido ──
def slug_valido(slug):
    if not isinstance(slug, str) or not SLUG_RE.match(slug) or "--" in slug:
        raise HTTPException(status_code=422, detail="slug inválido: minúsculas, números y guiones, de 3 a 32, empezando con letra")
    return slug


def entero(valor, nombre, minimo, maximo, defecto):
    if valor is None:
        return defecto
    if isinstance(valor, bool) or not isinstance(valor, int) or not minimo <= valor <= maximo:
        raise HTTPException(status_code=422, detail=f"{nombre} tiene que ser un número entre {minimo} y {maximo}")
    return valor


def pedido_valido(cuerpo):
    """Devuelve (slug, argumentos para el script, texto del archivo de usuarios)."""
    if not isinstance(cuerpo, dict):
        raise HTTPException(status_code=422, detail="el pedido tiene que ser un objeto JSON")
    slug = slug_valido(cuerpo.get("slug"))
    cuota = entero(cuerpo.get("cuota_gb"), "cuota_gb", 1, 9999, 5)
    equipo = entero(cuerpo.get("equipo_gb"), "equipo_gb", 0, 99999, 0)
    return slug, ["--cuota-gb", str(cuota), "--equipo-gb", str(equipo)], usuarios_validos(cuerpo.get("usuarios"), cuota)


def usuarios_validos(usuarios, cuota):
    """Devuelve el texto del archivo de usuarios (correo|nombre|GB por línea)."""
    usuarios = usuarios or []
    if not isinstance(usuarios, list) or len(usuarios) > MAX_USUARIOS:
        raise HTTPException(status_code=422, detail=f"usuarios tiene que ser una lista de hasta {MAX_USUARIOS}")
    lineas = []
    for n, u in enumerate(usuarios, 1):
        if not isinstance(u, dict):
            raise HTTPException(status_code=422, detail=f"usuario {n}: formato inválido")
        correo = str(u.get("correo", "")).strip().lower()
        nombre = str(u.get("nombre", "")).strip()
        if not CORREO_RE.match(correo):
            raise HTTPException(status_code=422, detail=f"usuario {n}: correo inválido")
        if not NOMBRE_RE.match(nombre):
            raise HTTPException(status_code=422, detail=f"usuario {n}: falta el nombre o tiene caracteres no permitidos")
        gb = entero(u.get("cuota_gb"), f"usuario {n}: cuota_gb", 1, 9999, cuota)
        lineas.append(f"{correo}|{nombre}|{gb}")
    return "\n".join(lineas) + ("\n" if lineas else "")


async def cuerpo_json(request):
    try:
        return await request.json()
    except ValueError:
        raise HTTPException(status_code=422, detail="el cuerpo no es JSON válido")


def correr(args, timeout=120):
    """Corre hepta-drive-alta y devuelve (código, salida, error). Nunca pasa por un shell."""
    try:
        r = subprocess.run([ALTA] + args, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "el script no respondió a tiempo"
    except OSError as e:
        return 127, "", f"no pude correr {ALTA}: {e}"


def lineas_json(texto):
    salida = []
    for linea in texto.splitlines():
        try:
            salida.append(json.loads(linea))
        except ValueError:
            pass
    return salida


def archivo_usuarios(slug, texto):
    if not texto:
        return None
    ruta = os.path.join(VAR, "agente", f"{slug}.{uuid.uuid4().hex[:8]}.usuarios")
    fd = os.open(ruta, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(texto)
    return ruta


# ── Trabajos en segundo plano (uno a la vez) ──
trabajos = {}
candado = threading.Lock()
alta_en_curso = threading.Lock()


def guardar(t):
    ruta = os.path.join(TRABAJOS_DIR, t["id"] + ".json")
    with open(ruta + ".tmp", "w", encoding="utf-8") as f:
        json.dump(t, f, ensure_ascii=False)
    os.replace(ruta + ".tmp", ruta)


def cargar_trabajos():
    """Al arrancar: un trabajo que quedó 'en_curso' es de antes de un reinicio."""
    for nombre in os.listdir(TRABAJOS_DIR):
        if not nombre.endswith(".json"):
            continue
        try:
            with open(os.path.join(TRABAJOS_DIR, nombre), encoding="utf-8") as f:
                t = json.load(f)
        except (OSError, ValueError):
            continue
        if t.get("estado") == "en_curso":
            t.update(estado="interrumpido", fin=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                     error="el agente se reinició durante el alta; 'crear' se puede repetir: sigue desde donde quedó")
            guardar(t)
        trabajos[t["id"]] = t


cargar_trabajos()


def hacer_trabajo(t, args, usuarios):
    try:
        proc = subprocess.Popen([ALTA] + args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for linea in proc.stdout:
            linea = linea.rstrip()
            with candado:
                t["salida"] = (t["salida"] + [linea])[-40:]
                if "· " in linea:
                    t["paso"] = linea.split("· ", 1)[1]
        codigo = proc.wait()
        with candado:
            t["fin"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            if codigo == 0:
                t["estado"] = "listo"
                c, salida, _ = correr(["estado", t["slug"]])
                t["resultado"] = (lineas_json(salida) or [None])[0]
            else:
                t["estado"] = "error"
                t["error"] = next((x for x in reversed(t["salida"]) if "ERROR" in x), f"terminó con código {codigo}")
        log.info("%s de %s: %s", t["accion"], t["slug"], t["estado"])
    except Exception as e:  # noqa: BLE001 — cualquier cosa acá tiene que quedar en el trabajo, no perderse
        with candado:
            t.update(estado="error", error=f"falla interna del agente: {e}", fin=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
        log.exception("%s de %s: falla interna", t["accion"], t["slug"])
    finally:
        if usuarios and os.path.exists(usuarios):
            os.unlink(usuarios)
        with candado:
            guardar(t)
        alta_en_curso.release()


# ── Rutas ──
@app.get("/health")
def health():
    return {"ok": True, "version": VERSION}


@app.get("/clientes", dependencies=[Depends(con_clave)])
def clientes():
    codigo, salida, error = correr(["estado"])
    if codigo != 0:
        raise HTTPException(status_code=500, detail=error.strip()[-300:] or "no pude leer el estado")
    return {"clientes": lineas_json(salida)}


@app.get("/clientes/{slug}", dependencies=[Depends(con_clave)])
def cliente(slug: str):
    slug_valido(slug)
    codigo, salida, error = correr(["estado", slug])
    datos = lineas_json(salida)
    if codigo != 0:
        raise HTTPException(status_code=500, detail=error.strip()[-300:] or "no pude leer el estado")
    if not datos:
        raise HTTPException(status_code=404, detail="no existe ese cliente")
    return datos[0]


@app.post("/validar", dependencies=[Depends(con_clave)])
async def validar(request: Request):
    slug, args, texto = pedido_valido(await cuerpo_json(request))
    usuarios = archivo_usuarios(slug, texto)
    try:
        codigo, salida, error = correr(["validar", slug] + args + (["--usuarios", usuarios] if usuarios else []))
    finally:
        if usuarios and os.path.exists(usuarios):
            os.unlink(usuarios)
    datos = lineas_json(salida)
    if not datos:
        raise HTTPException(status_code=422 if codigo == 1 else 500, detail=error.strip()[-300:] or "la validación no respondió")
    return datos[0]


def lanzar(accion, slug, args, texto):
    """Arranca un trabajo en segundo plano. Uno a la vez en toda la VM."""
    if not alta_en_curso.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="ya hay un trabajo en curso; probá cuando termine")
    try:
        usuarios = archivo_usuarios(slug, texto)
        if usuarios:
            args = args + ["--usuarios", usuarios]
        t = {"id": uuid.uuid4().hex, "accion": accion, "slug": slug, "estado": "en_curso", "paso": "En cola",
             "inicio": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "fin": None, "salida": [], "error": None, "resultado": None}
        with candado:
            trabajos[t["id"]] = t
            guardar(t)
        threading.Thread(target=hacer_trabajo, args=(t, args, usuarios), daemon=True).start()
    except Exception:
        alta_en_curso.release()
        raise
    log.info("%s de %s pedida (trabajo %s)", accion, slug, t["id"])
    return {"trabajo": t["id"], "slug": slug, "estado": "en_curso"}


@app.post("/crear", dependencies=[Depends(con_clave)], status_code=202)
async def crear(request: Request):
    slug, args, texto = pedido_valido(await cuerpo_json(request))
    return lanzar("alta", slug, ["crear", slug] + args, texto)


UNIDADES = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4}


def bytes_de(cuota):
    """'5 GB' → bytes. Sin límite o ilegible → None."""
    m = re.match(r"^\s*([0-9]+(?:[.,][0-9]+)?)\s*([KMGT]?B)\s*$", str(cuota or ""), re.I)
    if not m:
        return None
    return int(float(m.group(1).replace(",", ".")) * UNIDADES[m.group(2).upper()])


def uid_valido(valor, nombre="usuario"):
    uid = str(valor or "").strip().lower()
    if not CORREO_RE.match(uid):
        raise HTTPException(status_code=422, detail=f"{nombre}: tiene que ser el correo del usuario")
    return uid


def salida_de_error(error, salida):
    lineas = [x for x in (error + "\n" + salida).splitlines() if "ERROR" in x]
    return (lineas[-1] if lineas else (error.strip() or "no se pudo completar"))[-300:].replace("ERROR: ", "")


@app.post("/clientes/{slug}/usuarios/estado", dependencies=[Depends(con_clave)])
async def estado_usuario(slug: str, request: Request):
    slug_valido(slug)
    cuerpo = await cuerpo_json(request)
    if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("activo"), bool):
        raise HTTPException(status_code=422, detail="falta 'activo' (true o false)")
    uid = uid_valido(cuerpo.get("usuario"))
    verbo = "usuario-habilitar" if cuerpo["activo"] else "usuario-deshabilitar"
    codigo, salida, error = correr([verbo, slug, "--usuario", uid], timeout=60)
    if codigo != 0:
        raise HTTPException(status_code=409, detail=salida_de_error(error, salida))
    log.info("%s en %s: %s", verbo, slug, uid)
    return {"ok": True, "usuario": uid, "activo": cuerpo["activo"]}


@app.post("/clientes/{slug}/usuarios/eliminar", dependencies=[Depends(con_clave)], status_code=202)
async def eliminar_usuario(slug: str, request: Request):
    slug_valido(slug)
    cuerpo = await cuerpo_json(request)
    if not isinstance(cuerpo, dict):
        raise HTTPException(status_code=422, detail="el pedido tiene que ser un objeto JSON")
    uid = uid_valido(cuerpo.get("usuario"))
    args = ["usuario-eliminar", slug, "--usuario", uid]
    if cuerpo.get("transferir_a"):
        destino = uid_valido(cuerpo.get("transferir_a"), "transferir_a")
        if destino == uid:
            raise HTTPException(status_code=422, detail="los archivos no se pueden pasar al mismo usuario que se borra")
        args += ["--transferir-a", destino]
    codigo, salida, _ = correr(["estado", slug])
    if codigo != 0 or not lineas_json(salida):
        raise HTTPException(status_code=404, detail="no existe ese cliente")
    return lanzar("baja de usuario", slug, args, "")


@app.post("/clientes/{slug}/suspension", dependencies=[Depends(con_clave)])
async def suspension(slug: str, request: Request):
    slug_valido(slug)
    cuerpo = await cuerpo_json(request)
    if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("suspendida"), bool):
        raise HTTPException(status_code=422, detail="falta 'suspendida' (true o false)")
    verbo = "suspender" if cuerpo["suspendida"] else "reactivar"
    codigo, salida, error = correr([verbo, slug], timeout=90)
    if codigo != 0:
        raise HTTPException(status_code=409, detail=salida_de_error(error, salida))
    log.info("%s %s", verbo, slug)
    return {"ok": True, "slug": slug, "suspendida": cuerpo["suspendida"]}


@app.post("/clientes/{slug}/baja", dependencies=[Depends(con_clave)], status_code=202)
async def baja(slug: str, request: Request):
    slug_valido(slug)
    cuerpo = await cuerpo_json(request)
    # Hay que repetir el nombre: una baja no puede salir de un pedido armado a medias
    if not isinstance(cuerpo, dict) or cuerpo.get("confirmar") != slug:
        raise HTTPException(status_code=422, detail="para dar de baja hay que repetir el nombre de la instancia en 'confirmar'")
    codigo, salida, _ = correr(["estado", slug])
    if codigo != 0 or not lineas_json(salida):
        raise HTTPException(status_code=404, detail="no existe ese cliente")
    args = ["baja", slug, "--confirmar", slug] + (["--sin-copia"] if cuerpo.get("sin_copia") is True else [])
    return lanzar("baja", slug, args, "")


DOMINIO_RE = re.compile(r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")


@app.post("/clientes/{slug}/dominio", dependencies=[Depends(con_clave)])
async def dominio_propio(slug: str, request: Request):
    """El vhost y el certificado van aparte, en el NGINX. Acá solo se prepara la instancia."""
    slug_valido(slug)
    cuerpo = await cuerpo_json(request)
    if not isinstance(cuerpo, dict) or cuerpo.get("fase") not in ("aceptar", "principal"):
        raise HTTPException(status_code=422, detail="falta 'fase': aceptar o principal")
    dominio = str(cuerpo.get("dominio") or "").strip().lower()
    if len(dominio) > 253 or not DOMINIO_RE.match(dominio) or dominio.endswith("hepta.com.py"):
        raise HTTPException(status_code=422, detail="dominio inválido")
    # 'principal' reinicia los contenedores de la instancia: puede tardar un par de minutos
    codigo, salida, error = correr([f"dominio-{cuerpo['fase']}", slug, "--dominio", dominio], timeout=240)
    if codigo != 0:
        raise HTTPException(status_code=409, detail=salida_de_error(error, salida))
    log.info("dominio-%s en %s: %s", cuerpo["fase"], slug, dominio)
    return {"ok": True, "slug": slug, "dominio": dominio, "fase": cuerpo["fase"]}


@app.get("/clientes/{slug}/usuarios", dependencies=[Depends(con_clave)])
def usuarios_de(slug: str):
    slug_valido(slug)
    codigo, salida, error = correr(["usuarios", slug], timeout=60)
    if codigo != 0:
        raise HTTPException(status_code=404 if "no existe" in error else 500, detail=error.strip()[-300:] or "no pude leer los usuarios")
    try:
        datos = json.loads(salida)
    except ValueError:
        raise HTTPException(status_code=500, detail="Nextcloud no devolvió la lista de usuarios")
    # Espacio usado: si no se puede leer, la lista sale igual, sin ese dato
    usado = {}
    c2, salida2, _ = correr(["uso", slug], timeout=30)
    if c2 == 0:
        for linea in salida2.splitlines():
            uid, _, n = linea.rpartition("|")
            if uid and n.isdigit():
                usado[uid] = int(n)
    lista = []
    for uid, u in (datos.items() if isinstance(datos, dict) else []):
        u = u if isinstance(u, dict) else {}
        grupos = u.get("groups") or []
        lista.append({"uid": uid, "nombre": u.get("display_name") or uid, "correo": u.get("email") or "",
                      "activo": u.get("enabled", True) is not False, "cuota": u.get("quota") or "",
                      "cuota_bytes": bytes_de(u.get("quota")), "usado_bytes": usado.get(uid),
                      "ultimo_ingreso": u.get("last_seen") or "", "admin": "admin" in grupos})
    return {"usuarios": lista}


@app.post("/clientes/{slug}/usuarios", dependencies=[Depends(con_clave)], status_code=202)
async def agregar_usuarios(slug: str, request: Request):
    slug_valido(slug)
    cuerpo = await cuerpo_json(request)
    if not isinstance(cuerpo, dict):
        raise HTTPException(status_code=422, detail="el pedido tiene que ser un objeto JSON")
    cuota = entero(cuerpo.get("cuota_gb"), "cuota_gb", 1, 9999, 5)
    texto = usuarios_validos(cuerpo.get("usuarios"), cuota)
    if not texto:
        raise HTTPException(status_code=422, detail="falta al menos un usuario")
    codigo, salida, _ = correr(["estado", slug])
    if codigo != 0 or not lineas_json(salida):
        raise HTTPException(status_code=404, detail="no existe ese cliente")
    return lanzar("usuarios", slug, ["agregar-usuarios", slug, "--cuota-gb", str(cuota)], texto)


@app.get("/trabajos/{tid}", dependencies=[Depends(con_clave)])
def trabajo(tid: str):
    with candado:
        t = trabajos.get(tid)
        if not t:
            raise HTTPException(status_code=404, detail="no existe ese trabajo")
        return dict(t)


@app.post("/clientes/{slug}/verificar", dependencies=[Depends(con_clave)])
def verificar(slug: str):
    slug_valido(slug)
    codigo, salida, error = correr(["verificar", slug], timeout=60)
    return {"ok": codigo == 0, "detalle": (salida if codigo == 0 else error).strip()[-300:]}


@app.get("/clientes/{slug}/secretos", dependencies=[Depends(con_clave)])
def secretos(slug: str):
    slug_valido(slug)
    codigo, salida, error = correr(["secretos", slug])
    if codigo != 0:
        raise HTTPException(status_code=404, detail="no hay secretos pendientes de ese cliente")
    log.info("Secretos de %s entregados", slug)
    return PlainTextResponse(salida, media_type="text/csv; charset=utf-8", headers={"Cache-Control": "no-store"})


@app.post("/clientes/{slug}/secretos/guardado", dependencies=[Depends(con_clave)])
def secretos_guardados(slug: str):
    slug_valido(slug)
    codigo, salida, error = correr(["secretos", slug, "--guardado"])
    if codigo != 0:
        raise HTTPException(status_code=404, detail="no hay secretos pendientes de ese cliente")
    log.info("Secretos de %s borrados de la VM", slug)
    return {"ok": True}
