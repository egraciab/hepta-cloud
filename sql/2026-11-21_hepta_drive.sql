-- ============================================================
--  HEPTA Drive en el Admin: qué servicios tiene cada cliente y los trabajos de alta.
--
--  client_services   un servicio de un cliente (hoy: drive). La instancia real vive en la VM hepta-drive;
--                    acá queda a quién pertenece, quién la pidió y con qué parámetros.
--  provisioning_jobs cada alta pedida al agente de la VM y cómo terminó.
--
--  Los secretos del alta NO se guardan acá: viven en la VM hasta que se bajan a KeePass.
--  Se aplica una vez; se puede repetir sin efecto.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS client_services (
  id                   SERIAL PRIMARY KEY,
  service              VARCHAR(20)  NOT NULL CHECK (service IN ('drive','mail','tenant')),
  slug                 VARCHAR(40)  NOT NULL,
  billing_customer_id  UUID REFERENCES billing_customers(id) ON DELETE SET NULL,
  fqdn                 VARCHAR(255),
  port                 INTEGER,
  status               VARCHAR(20)  NOT NULL DEFAULT 'creating'
                       CHECK (status IN ('creating','active','failed','suspended','cancelled')),
  params               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- el pedido: usuarios, cuotas, carpeta de equipo
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service, slug)
);
CREATE INDEX IF NOT EXISTS client_services_cliente ON client_services (billing_customer_id);

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id                 SERIAL PRIMARY KEY,
  client_service_id  INTEGER NOT NULL REFERENCES client_services(id) ON DELETE CASCADE,
  action             VARCHAR(20) NOT NULL DEFAULT 'create',
  remote_job_id      VARCHAR(64),
  status             VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  step               VARCHAR(200),
  error              TEXT,
  actor_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS provisioning_jobs_abiertos ON provisioning_jobs (status) WHERE status = 'running';

-- Conexión con el agente de la VM hepta-drive. Los valores los carga backend/scripts/drive_configurar.js
-- (la clave y el certificado pasan de la VM a la base sin mostrarse). Acá solo se crean las claves, vacías.
INSERT INTO site_config (key, value, updated_at) VALUES
  ('drive_api_url',  '', NOW()),
  ('drive_api_key',  '', NOW()),
  ('drive_api_cert', '', NOW())
ON CONFLICT (key) DO NOTHING;

COMMIT;
