#!/usr/bin/env python3
"""
HEPTA CLOUD — Perimetral API
Corre en Nginx Perimetral (192.168.10.125:8888)
Gestiona suspensión de instancias via fragmentos Nginx
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
CF_CREDENTIALS_FILE = os.getenv("CF_CREDENTIALS_FILE", "/etc/letsencrypt/cloudflare/credentials.ini")
CF_API_TOKEN        = os.getenv("CF_API_TOKEN", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_FILE), logging.StreamHandler()]
)
log = logging.getLogger("hepta.perimetral")

app = FastAPI(title="Hepta Perimetral API", version="1.0.0", docs_url=None, redoc_url=None)
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=True)

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

# ── Helpers ────────────────────────────────────────────────────
def get_conf_path(tenant: str) -> str:
    return os.path.join(SUSPENDED_DIR, f"{tenant}.{BASE_DOMAIN}.conf")

def nginx_reload() -> bool:
    result = subprocess.run(["sudo", "nginx", "-t"], capture_output=True, text=True)
    if result.returncode != 0:
        log.error(f"nginx -t falló: {result.stderr}")
        return False
    subprocess.run(["sudo", "systemctl", "reload", "nginx"], check=True)
    return True

def write_suspended_conf(tenant: str):
    domain = f"{tenant}.{BASE_DOMAIN}"
    conf = f"""# Suspendido por Hepta Cloud — {datetime.utcnow().isoformat()}
# tenant: {tenant}
if ($host = "{domain}") {{
    return 503 "Instancia suspendida. Contactá a soporte en cloud.hepta.com.py";
}}
"""
    os.makedirs(SUSPENDED_DIR, exist_ok=True)
    with open(get_conf_path(tenant), "w") as f:
        f.write(conf)
    log.info(f"[SUSPEND] Conf creada: {get_conf_path(tenant)}")

def remove_suspended_conf(tenant: str):
    path = get_conf_path(tenant)
    if os.path.exists(path):
        os.remove(path)
        log.info(f"[REACTIVATE] Conf eliminada: {path}")

# ── Endpoints ──────────────────────────────────────────────────
@app.get("/health")
def health():
    suspended = []
    if os.path.isdir(SUSPENDED_DIR):
        suspended = [f.replace(f".{BASE_DOMAIN}.conf", "")
                     for f in os.listdir(SUSPENDED_DIR) if f.endswith(".conf")]
    return {
        "status":    "ok",
        "suspended": suspended,
        "timestamp": datetime.utcnow().isoformat(),
    }

@app.get("/suspended", dependencies=[Depends(verify_api_key)])
def list_suspended():
    """Lista todas las instancias suspendidas"""
    suspended = []
    if os.path.isdir(SUSPENDED_DIR):
        suspended = [f.replace(f".{BASE_DOMAIN}.conf", "")
                     for f in os.listdir(SUSPENDED_DIR) if f.endswith(".conf")]
    return {"success": True, "data": suspended}

@app.post("/suspend", dependencies=[Depends(verify_api_key)])
def suspend(req: TenantAction):
    """Suspende un tenant — crea fragmento Nginx + reload"""
    log.info(f"[SUSPEND] tenant={req.tenant}")
    try:
        write_suspended_conf(req.tenant)
        if not nginx_reload():
            remove_suspended_conf(req.tenant)
            raise HTTPException(status_code=500, detail="nginx -t falló, conf revertida")
        return {
            "success": True,
            "tenant":  req.tenant,
            "message": f"Instancia {req.tenant}.{BASE_DOMAIN} suspendida.",
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"[SUSPEND] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/reactivate", dependencies=[Depends(verify_api_key)])
def reactivate(req: TenantAction):
    """Reactiva un tenant — elimina fragmento Nginx + reload"""
    log.info(f"[REACTIVATE] tenant={req.tenant}")
    try:
        remove_suspended_conf(req.tenant)
        if not nginx_reload():
            raise HTTPException(status_code=500, detail="nginx -t falló tras reactivar")
        return {
            "success": True,
            "tenant":  req.tenant,
            "message": f"Instancia {req.tenant}.{BASE_DOMAIN} reactivada.",
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"[REACTIVATE] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Agregar al main.py de la API Perimetral (/opt/hepta/perimetral_api/main.py)
# Pegar ANTES de la última línea (if __name__ == "__main__")

import shutil

class VhostRequest(BaseModel):
    domain: str        # dominio propio: barrios.com.py
    db: str            # DB interna: barrios.erp.hepta.com.py
    certbot_email: str = "admin@hepta.com.py"
    cf_token: str = ""
    disable_subdomain: bool = True  # suspender subdominio wildcard

    @field_validator("domain")
    @classmethod
    def validate_domain(cls, v):
        import re
        if not re.match(r'^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$', v):
            raise ValueError("Dominio inválido")
        return v.lower()

@app.post("/vhost", dependencies=[Depends(verify_api_key)])
def create_vhost(req: VhostRequest):
    """
    Crea vhost Nginx para dominio propio + SSL certbot.
    Opcionalmente suspende el subdominio wildcard anterior.
    """
    log.info(f"[VHOST] domain={req.domain} db={req.db}")

    nginx_sites   = "/etc/nginx/sites-available"
    nginx_enabled = "/etc/nginx/sites-enabled"
    conf_file     = f"{nginx_sites}/{req.domain}.conf"

    try:
        # 1. Crear vhost
        vhost_content = f"""server {{
    server_name {req.domain} www.{req.domain};

    location / {{
        proxy_pass http://odoo19_backend;
        proxy_set_header Host {req.db};
        proxy_set_header X-Forwarded-Host {req.db};
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 720s;
        proxy_connect_timeout 720s;
        proxy_send_timeout 720s;
        client_max_body_size 100m;
    }}

    location /websocket {{
        proxy_pass http://odoo19_evented;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host {req.db};
        proxy_set_header X-Forwarded-Host {req.db};
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 720s;
        proxy_send_timeout 720s;
    }}

    listen 80;
}}
"""
        # Escribir con sudo tee (www-data no tiene permisos directos)
        result = subprocess.run(
            ["sudo", "tee", conf_file],
            input=vhost_content, text=True, capture_output=True
        )
        if result.returncode != 0:
            raise Exception(f"Error escribiendo conf: {result.stderr}")

        # 2. Symlink en sites-enabled
        enabled_path = f"{nginx_enabled}/{req.domain}.conf"
        if not os.path.exists(enabled_path):
            subprocess.run(["sudo", "ln", "-sf", conf_file, enabled_path], check=True)

        # 3. Test nginx
        test = subprocess.run(["sudo", "nginx", "-t"], capture_output=True, text=True)
        if test.returncode != 0:
            os.remove(conf_file)
            if os.path.exists(enabled_path): os.remove(enabled_path)
            raise HTTPException(status_code=500, detail=f"nginx -t falló: {test.stderr}")

        # 4. Reload nginx
        subprocess.run(["sudo", "systemctl", "reload", "nginx"], check=True)
        log.info(f"[VHOST] Nginx recargado para {req.domain}")

        # 5. Certbot SSL
        cf_tok = req.cf_token or CF_API_TOKEN or ""
        cf_creds = CF_CREDENTIALS_FILE
        tmp_creds = None
        if cf_tok:
            tmp_creds = f"/tmp/cf_{req.domain.replace(chr(46),chr(95))}.ini"
            with open(tmp_creds, "w") as fcf:
                fcf.write(f"dns_cloudflare_api_token = {cf_tok}\n")
            os.chmod(tmp_creds, 0o600)
            cf_creds = tmp_creds
        certbot_result = subprocess.run([
            "sudo", "certbot", "certonly",
            "--dns-cloudflare",
            "--dns-cloudflare-credentials", cf_creds,
            "--dns-cloudflare-propagation-seconds", "20",
            "-d", req.domain, "-d", f"www.{req.domain}",
            "--non-interactive", "--agree-tos",
            "--email", req.certbot_email,
        ], capture_output=True, text=True, timeout=180)
        if tmp_creds and os.path.exists(tmp_creds): os.remove(tmp_creds)

        ssl_ok = certbot_result.returncode == 0
        if ssl_ok:
            cert = f"/etc/letsencrypt/live/{req.domain}/fullchain.pem"
            key  = f"/etc/letsencrypt/live/{req.domain}/privkey.pem"
            lines = [
                f"server {{",
                f"    listen 443 ssl;",
                f"    server_name {req.domain} www.{req.domain};",
                f"    ssl_certificate     {cert};",
                f"    ssl_certificate_key {key};",
                f"    include /etc/letsencrypt/options-ssl-nginx.conf;",
                f"    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;",
                f"    client_max_body_size 100m;",
                f"    proxy_read_timeout 720s;",
                f"    location / {{",
                f"        proxy_pass http://odoo19_backend;",
                f"        proxy_set_header Host {req.db};",
                f"        proxy_set_header X-Forwarded-Proto https;",
                f"        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
                f"        proxy_set_header X-Real-IP $remote_addr;",
                f"    }}",
                f"    location /websocket {{",
                f"        proxy_pass http://odoo19_evented;",
                f"        proxy_set_header Upgrade $http_upgrade;",
                f"        proxy_set_header Connection $connection_upgrade;",
                f"        proxy_set_header Host {req.db};",
                f"        proxy_set_header X-Forwarded-Proto https;",
                f"        proxy_read_timeout 720s;",
                f"    }}",
                f"}}",
                f"server {{",
                f"    listen 80;",
                f"    server_name {req.domain} www.{req.domain};",
                f"    return 301 https://$host$request_uri;",
                f"}}",
            ]
            ssl_conf = "\n".join(lines) + "\n"
            subprocess.run(["sudo", "tee", conf_file], input=ssl_conf, text=True, capture_output=True)
            subprocess.run(["sudo", "systemctl", "reload", "nginx"], check=True)
            log.info(f"[VHOST] SSL OK para {req.domain}")
        else:
            log.warning(f"[VHOST] Certbot fallo: {certbot_result.stderr[-300:]}")

        # 6. Suspender subdominio wildcard si se pidió
        if req.disable_subdomain:
            tenant = req.db.split('.')[0]
            write_suspended_conf(tenant)
            nginx_reload()
            log.info(f"[VHOST] Subdominio {tenant} suspendido")

        log.info(f"[VHOST] OK: {req.domain} → {req.db} ssl={ssl_ok}")
        return {
            "success":  True,
            "domain":   req.domain,
            "db":       req.db,
            "ssl":      ssl_ok,
            "ssl_msg":  certbot_result.stdout[-200:] if ssl_ok else certbot_result.stderr[-200:],
            "message":  f"Dominio {req.domain} activado.{' SSL OK.' if ssl_ok else ' SSL pendiente — verificá el DNS.'}",
        }

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"[VHOST] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/vhost/{domain}", dependencies=[Depends(verify_api_key)])
def delete_vhost(domain: str):
    """Elimina el vhost de un dominio propio"""
    nginx_sites   = "/etc/nginx/sites-available"
    nginx_enabled = "/etc/nginx/sites-enabled"
    conf_file     = f"{nginx_sites}/{domain}.conf"
    enabled_path  = f"{nginx_enabled}/{domain}.conf"

    try:
        subprocess.run(["sudo", "rm", "-f", enabled_path], capture_output=True)
        subprocess.run(["sudo", "rm", "-f", conf_file], capture_output=True)
        nginx_reload()
        log.info(f"[VHOST] Eliminado: {domain}")
        return {"success": True, "message": f"Vhost {domain} eliminado."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
