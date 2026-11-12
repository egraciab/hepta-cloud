# Agregar estos endpoints al main.py de la API de Odoo CE
# Pegar antes de la última línea del archivo

from pydantic import BaseModel

class DbAction(BaseModel):
    db: str

@app.post("/suspend", dependencies=[Depends(verify_api_key)])
def suspend(req: DbAction):
    """Suspende una instancia revocando acceso a la DB"""
    import subprocess
    db = req.db
    log.info(f"[SUSPEND] Suspendiendo: {db}")
    try:
        result = subprocess.run(
            ["sudo", "-u", "postgres", "psql", "-c",
             f"REVOKE CONNECT ON DATABASE \"{db}\" FROM odoo;"],
            capture_output=True, text=True, timeout=10
        )
        # Terminar conexiones activas
        subprocess.run(
            ["sudo", "-u", "postgres", "psql", "-c",
             f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{db}' AND pid <> pg_backend_pid();"],
            capture_output=True, text=True, timeout=10
        )
        log.info(f"[SUSPEND] OK: {db}")
        return {"success": True, "message": f"Instancia {db} suspendida."}
    except Exception as e:
        log.error(f"[SUSPEND] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/reactivate", dependencies=[Depends(verify_api_key)])
def reactivate(req: DbAction):
    """Reactiva una instancia restaurando acceso a la DB"""
    import subprocess
    db = req.db
    log.info(f"[REACTIVATE] Reactivando: {db}")
    try:
        result = subprocess.run(
            ["sudo", "-u", "postgres", "psql", "-c",
             f"GRANT CONNECT ON DATABASE \"{db}\" TO odoo;"],
            capture_output=True, text=True, timeout=10
        )
        log.info(f"[REACTIVATE] OK: {db}")
        return {"success": True, "message": f"Instancia {db} reactivada."}
    except Exception as e:
        log.error(f"[REACTIVATE] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
