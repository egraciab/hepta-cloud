-- ---------------------------------------------------------------------------
-- HEPTA Cloud — migración 002: credenciales de integración
--
-- Guarda las claves de API de los sistemas externos (Odoo ERP, Odoo tenants,
-- WispHub) para test y producción, con vencimiento y estado de la última
-- prueba. El secreto se guarda CIFRADO: lo cifra y descifra el backend con
-- AES-256-GCM (backend/config/secretos.js); la clave maestra vive en el .env
-- y nunca entra a la base.
--
-- Aditiva: no toca ninguna tabla existente.
--
-- Respaldo y ejecución:
--   pg_dump -h 127.0.0.1 -U <user> -d heptacloud -Fc -f /root/heptacloud_pre002.dump
--   sudo -u postgres psql -d heptacloud -v ON_ERROR_STOP=1 -f migracion_heptacloud_002_credenciales.sql
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS integration_credentials (
    id                serial PRIMARY KEY,

    servicio          varchar(30) NOT NULL
                      CHECK (servicio IN ('odoo_erp', 'odoo_tenant', 'wisphub', 'otro')),
    entorno           varchar(10) NOT NULL
                      CHECK (entorno IN ('test', 'prod')),
    etiqueta          varchar(100),

    -- Conexión
    base_url          text,
    db_name           varchar(100),
    usuario           varchar(150),

    -- El secreto. Cifrado en el backend: iv(12) || tag(16) || ciphertext.
    -- Un dump de la base no alcanza para usarlo.
    secreto           bytea NOT NULL,
    -- Para identificarlo en pantalla sin exponerlo.
    secreto_ultimos4  varchar(4),

    -- Vencimiento. Odoo permite claves con caducidad; la política acá es 90 días.
    expira_el         date,
    activo            boolean NOT NULL DEFAULT true,

    -- Rotación: la clave nueva apunta a la que reemplaza, y la vieja queda
    -- inactiva. Así el historial queda solo, sin tabla de auditoría aparte.
    reemplaza_a       integer REFERENCES integration_credentials(id),

    -- Resultado de la última prueba de conexión
    ultima_prueba_el  timestamptz,
    ultima_prueba_ok  boolean,
    ultimo_error      text,

    -- Para no mandar el mismo aviso de vencimiento todos los días
    aviso_enviado_el  date,

    notas             text,
    creado_por        integer REFERENCES users(id),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Una sola credencial activa por servicio y entorno: evita la duda de cuál
-- está usando el backend.
CREATE UNIQUE INDEX IF NOT EXISTS integration_credentials_activa_uniq
    ON integration_credentials (servicio, entorno)
    WHERE activo;

CREATE INDEX IF NOT EXISTS integration_credentials_expira_idx
    ON integration_credentials (expira_el) WHERE activo;

COMMENT ON TABLE  integration_credentials IS
    'Claves de API de sistemas externos, cifradas por el backend (AES-256-GCM).';
COMMENT ON COLUMN integration_credentials.secreto IS
    'iv(12) || tag(16) || ciphertext. Se descifra solo en el backend con HEPTA_SECRET_KEY.';
COMMENT ON COLUMN integration_credentials.expira_el IS
    'Vencimiento de la clave. Politica: 90 dias. Aviso desde 15 dias antes.';

-- set_updated_at() ya existe desde la migración 001.
DROP TRIGGER IF EXISTS integration_credentials_updated_at ON integration_credentials;
CREATE TRIGGER integration_credentials_updated_at BEFORE UPDATE ON integration_credentials
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;

-- ---------------------------------------------------------------------------
-- Si la migración se corre como `postgres`, el usuario de la app necesita
-- acceso a la tabla y su secuencia:
--
--   GRANT SELECT, INSERT, UPDATE, DELETE ON integration_credentials TO hepta;
--   GRANT USAGE, SELECT ON SEQUENCE integration_credentials_id_seq TO hepta;
--
-- (Las ALTER DEFAULT PRIVILEGES de la 001 ya cubren esto si se corrió después.)
-- ---------------------------------------------------------------------------
