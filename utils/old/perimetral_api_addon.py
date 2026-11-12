# Agregar al main.py de la API Perimetral (/opt/hepta/perimetral_api/main.py)
# Pegar ANTES de la última línea (if __name__ == "__main__")

import shutil

class VhostRequest(BaseModel):
    domain: str        # dominio propio: barrios.com.py
    db: str            # DB interna: barrios.erp.hepta.com.py
    certbot_email: str = "admin@hepta.com.py"
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
        with open(conf_file, 'w') as f:
            f.write(vhost_content)

        # 2. Symlink en sites-enabled
        enabled_path = f"{nginx_enabled}/{req.domain}.conf"
        if not os.path.exists(enabled_path):
            os.symlink(conf_file, enabled_path)

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
        certbot_result = subprocess.run([
            "sudo", "certbot", "--nginx",
            "-d", req.domain, "-d", f"www.{req.domain}",
            "--non-interactive", "--agree-tos",
            "--email", req.certbot_email,
            "--redirect",
        ], capture_output=True, text=True, timeout=120)

        ssl_ok = certbot_result.returncode == 0
        if not ssl_ok:
            log.warning(f"[VHOST] Certbot falló (puede ser DNS): {certbot_result.stderr[-300:]}")

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
        if os.path.exists(enabled_path): os.remove(enabled_path)
        if os.path.exists(conf_file):    os.remove(conf_file)
        nginx_reload()
        log.info(f"[VHOST] Eliminado: {domain}")
        return {"success": True, "message": f"Vhost {domain} eliminado."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
