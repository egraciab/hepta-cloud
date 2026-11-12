# Agrega a main.py el filtro de origen (ALLOWED_IPS). Uso: python3 filtro.py /ruta/main.py
import sys, re
p = sys.argv[1]; s = open(p).read()
if "ALLOWED_IPS" in s:
    print("ya estaba aplicado"); sys.exit(0)
ancla = 'api_key_header = APIKeyHeader(name="X-API-Key", auto_error=True)\n'
assert s.count(ancla) == 1, "no encuentro dónde insertar"
bloque = ancla + '''
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
'''
open(p, "w").write(s.replace(ancla, bloque)); print("filtro agregado")
