#!/usr/bin/env python3
"""
HEPTA CLOUD — Perimetral API
Corre en Nginx Perimetral (192.168.10.125:8888)
Suspensión y dominio propio de los tenants, y vhosts de HEPTA Drive. Todo lo que necesita root lo hacen
dos scripts con argumentos validados (hepta-tenant-nginx y drive_vhost_add.sh): www-data no puede correr otra cosa.
"""
import os
import re
import subprocess
import logging
from datetime import datetime
from fastapi import FastAPI, HTTPException, Security, Depends
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, field_validator

# ── Config ─────────────────────────────────────────────────────
API_KEY             = os.getenv("PERIMETRAL_API_KEY", "CHANGE_ME_SECRET")
SUSPENDED_DIR       = os.getenv("SUSPENDED_DIR", "/etc/nginx/hepta-suspended")
BASE_DOMAIN         = os.getenv("BASE_DOMAIN", "erp.hepta.com.py")
LOG_FILE            = os.getenv("LOG_FILE", "/var/log/hepta_perimetral.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_FILE), logging.StreamHandler()]
)
log = logging.getLogger("hepta.perimetral")

app = FastAPI(title="Hepta Perimetral API", version="2.0.0", docs_url=None, redoc_url=None)
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=True)

# ── Quién puede hablarle a esta API ───────────────────────────
# ALLOWED_IPS (en el .env): IPs separadas por coma. Vacío = sin filtro. La clave sigue
# haciendo falta; esto corta antes a cualquier otro equipo de la red, también en /health.
from fastapi import Request
from fastapi.responses import JSONResponse

ALLOWED_IPS = {ip.strip() for ip in os.getenv("ALLOWED_IPS", "").split(",") if ip.strip()}

@app.middleware("http")
async def solo_origenes_permitidos(request: Request, call_next):
    origen = request.client.host if request.client else ""
    if ALLOWED_IPS and origen not in ALLOWED_IPS:
        log.warning(f"Rechazado: origen {origen} no permitido ({request.method} {request.url.path})")
        return JSONResponse(status_code=403, content={"detail": "Origen no permitido"})
    return await call_next(request)

def verify_api_key(key: str = Security(api_key_header)):
    if key != API_KEY:
        log.warning("API key inválida")
        raise HTTPException(status_code=401, detail="API key inválida")
    return key

# ── Schemas ────────────────────────────────────────────────────
class TenantAction(BaseModel):
    tenant: str  # solo el prefijo, ej: "prueba"

    @field_validator("tenant")
    @classmethod
    def validate_tenant(cls, v):
        if not re.match(r'^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$', v):
            raise ValueError("Tenant inválido")
        return v.lower()

# ── Lo que necesita root lo hace un script ─────────────────────
# /usr/local/sbin/hepta-tenant-nginx (tools/tenant_nginx.sh del repo) valida sus argumentos, deja todo como estaba
# si nginx -t falla y es lo único de los tenants que www-data puede correr por sudo (/etc/sudoers.d/hepta-perimetral).
TENANT_NGINX = "/usr/local/sbin/hepta-tenant-nginx"
DOMINIO_RE   = re.compile(r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")
DB_RE        = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\." + re.escape(BASE_DOMAIN) + r")?$")
CORREO_RE    = re.compile(r"^[A-Za-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")

def correr_tenant(args, espera=40):
    try:
        r = subprocess.run(["sudo", "-n", TENANT_NGINX] + args, capture_output=True, text=True, timeout=espera)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="el script de nginx no respondió a tiempo")
    salida = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        log.error(f"[TENANT] {' '.join(args)}: {salida[-300:]}")
        raise HTTPException(status_code=500, detail=salida[-300:] or "no se pudo cambiar nginx")
    return salida

def listar_suspendidos():
    # Las suspendidas de verdad: el script no cuenta los subdominios apagados porque el cliente pasó a su dominio
    salida = correr_tenant(["listar"])
    return sorted({l.strip() for l in salida.splitlines() if l.strip()})

# ── Endpoints ──────────────────────────────────────────────────
@app.get("/health")
def health():
    # Sin datos: qué instancias están suspendidas lo dice /suspended, con la clave
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}

@app.get("/suspended", dependencies=[Depends(verify_api_key)])
def list_suspended():
    """Lista todas las instancias suspendidas"""
    return {"success": True, "data": listar_suspendidos()}

@app.post("/suspend", dependencies=[Depends(verify_api_key)])
def suspend(req: TenantAction):
    """Suspende un tenant: fragmento de nginx que responde 503"""
    log.info(f"[SUSPEND] tenant={req.tenant}")
    correr_tenant(["suspender", req.tenant])
    return {"success": True, "tenant": req.tenant, "message": f"Instancia {req.tenant}.{BASE_DOMAIN} suspendida."}

@app.post("/reactivate", dependencies=[Depends(verify_api_key)])
def reactivate(req: TenantAction):
    """Reactiva un tenant"""
    log.info(f"[REACTIVATE] tenant={req.tenant}")
    correr_tenant(["reactivar", req.tenant])
    return {"success": True, "tenant": req.tenant, "message": f"Instancia {req.tenant}.{BASE_DOMAIN} reactivada."}

class VhostRequest(BaseModel):
    domain: str        # dominio propio: barrios.com.py
    db: str            # base del tenant: barrios o barrios.erp.hepta.com.py
    certbot_email: str = "admin@hepta.com.py"
    cf_token: str = ""              # ya no se usa: el certificado sale con la credencial de Cloudflare del servidor
    disable_subdomain: bool = True  # suspender el subdominio de HEPTA

    @field_validator("domain")
    @classmethod
    def validate_domain(cls, v):
        v = v.strip().lower()
        if len(v) > 253 or not DOMINIO_RE.match(v) or v.startswith("www.") or v.endswith("hepta.com.py"):
            raise ValueError("Dominio inválido")
        return v

    @field_validator("db")
    @classmethod
    def validate_db(cls, v):
        v = v.strip().lower()
        if not DB_RE.match(v):
            raise ValueError("db inválida")
        return v

    @field_validator("certbot_email")
    @classmethod
    def validate_email(cls, v):
        v = v.strip()
        if not CORREO_RE.match(v):
            raise ValueError("correo inválido")
        return v

@app.post("/vhost", dependencies=[Depends(verify_api_key)])
def create_vhost(req: VhostRequest):
    """Dominio propio de un tenant: vhost, certificado y (si se pide) suspensión del subdominio de HEPTA."""
    log.info(f"[VHOST] domain={req.domain} db={req.db}")
    args = ["vhost", req.domain, req.db, req.certbot_email] + ([] if req.disable_subdomain else ["--sin-suspender"])
    salida = correr_tenant(args, espera=200)
    ssl_ok = salida.splitlines()[-1].strip() == "ssl=si" if salida else False
    log.info(f"[VHOST] OK: {req.domain} → {req.db} ssl={ssl_ok}")
    return {
        "success": True,
        "domain":  req.domain,
        "db":      req.db,
        "ssl":     ssl_ok,
        "ssl_msg": salida[-200:],
        "message": f"Dominio {req.domain} activado.{' SSL OK.' if ssl_ok else ' SSL pendiente — verificá el DNS.'}",
    }

@app.delete("/vhost/{domain}", dependencies=[Depends(verify_api_key)])
def delete_vhost(domain: str):
    """Quita el vhost de un dominio propio (solo si lo creó el script)"""
    domain = domain.strip().lower()
    if len(domain) > 253 or not DOMINIO_RE.match(domain):
        raise HTTPException(status_code=422, detail="dominio inválido")
    salida = correr_tenant(["quitar-vhost", domain])
    log.info(f"[VHOST] Eliminado: {domain}")
    return {"success": True, "message": salida.splitlines()[-1] if salida else ""}


# ── HEPTA Drive: vhost de la instancia de un cliente ──────────
# <slug>.drive.hepta.com.py → 10.10.50.220:<puerto>. No se escribe nada desde acá: lo hace el script
# /usr/local/sbin/drive_vhost_add.sh (tools/drive_vhost_add.sh del repo), que valida el nombre, el puerto y el
# certificado, y deja todo como estaba si nginx -t falla. www-data lo corre por /etc/sudoers.d/hepta-drive-vhost.
DRIVE_VHOST = "/usr/local/sbin/drive_vhost_add.sh"
DRIVE_SLUG  = re.compile(r"^[a-z][a-z0-9-]{1,30}[a-z0-9]$")

class DriveVhost(BaseModel):
    slug: str
    port: int

    @field_validator("slug")
    @classmethod
    def validar_slug(cls, v):
        if not DRIVE_SLUG.match(v) or "--" in v:
            raise ValueError("slug inválido")
        return v

    @field_validator("port")
    @classmethod
    def validar_puerto(cls, v):
        if not 8081 <= v <= 8199:
            raise ValueError("el puerto tiene que estar entre 8081 y 8199")
        return v

def correr_drive_vhost(args, espera=40):
    try:
        r = subprocess.run(["sudo", "-n", DRIVE_VHOST] + args, capture_output=True, text=True, timeout=espera)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="el script del vhost no respondió a tiempo")
    salida = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        log.error(f"[DRIVE] {' '.join(args)}: {salida[-300:]}")
        raise HTTPException(status_code=409, detail=salida[-300:] or "no se pudo cambiar el vhost")
    return salida

@app.post("/drive-vhost", dependencies=[Depends(verify_api_key)])
def crear_drive_vhost(req: DriveVhost):
    """Publica la instancia de HEPTA Drive de un cliente. Repetirlo con los mismos datos no rompe nada."""
    salida = correr_drive_vhost([req.slug, str(req.port)])
    log.info(f"[DRIVE] vhost de {req.slug} → puerto {req.port}")
    return {"success": True, "slug": req.slug, "port": req.port, "message": salida.splitlines()[0] if salida else ""}

DRIVE_DOMINIO = re.compile(r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")

class DriveDominio(BaseModel):
    slug: str
    dominio: str

    @field_validator("slug")
    @classmethod
    def validar_slug(cls, v):
        if not DRIVE_SLUG.match(v) or "--" in v:
            raise ValueError("slug inválido")
        return v

    @field_validator("dominio")
    @classmethod
    def validar_dominio(cls, v):
        v = v.strip().lower()
        if len(v) > 253 or not DRIVE_DOMINIO.match(v) or v.endswith("hepta.com.py"):
            raise ValueError("dominio inválido")
        return v

@app.post("/drive-dominio", dependencies=[Depends(verify_api_key)])
def crear_drive_dominio(req: DriveDominio):
    """Suma el dominio propio del cliente a su drive: certificado por HTTP y vhost. El nombre de HEPTA sigue andando."""
    salida = correr_drive_vhost([req.slug, "--dominio", req.dominio], espera=170)
    log.info(f"[DRIVE] dominio propio de {req.slug}: {req.dominio}")
    return {"success": True, "slug": req.slug, "dominio": req.dominio, "message": salida.splitlines()[-1] if salida else ""}

@app.delete("/drive-dominio/{slug}/{dominio}", dependencies=[Depends(verify_api_key)])
def quitar_drive_dominio(slug: str, dominio: str):
    dominio = dominio.strip().lower()
    if not DRIVE_SLUG.match(slug) or "--" in slug or len(dominio) > 253 or not DRIVE_DOMINIO.match(dominio):
        raise HTTPException(status_code=422, detail="slug o dominio inválido")
    salida = correr_drive_vhost([slug, "--quitar-dominio", dominio])
    log.info(f"[DRIVE] dominio propio de {slug} quitado: {dominio}")
    return {"success": True, "slug": slug, "dominio": dominio, "message": salida.splitlines()[-1] if salida else ""}

@app.delete("/drive-vhost/{slug}", dependencies=[Depends(verify_api_key)])
def quitar_drive_vhost(slug: str):
    """Quita el vhost (el archivo queda renombrado en sites-available)."""
    if not DRIVE_SLUG.match(slug) or "--" in slug:
        raise HTTPException(status_code=422, detail="slug inválido")
    salida = correr_drive_vhost([slug, "--quitar"])
    log.info(f"[DRIVE] vhost de {slug} quitado")
    return {"success": True, "slug": slug, "message": salida.splitlines()[-1] if salida else ""}
