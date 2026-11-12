-- ---------------------------------------------------------------------------
-- HEPTA Cloud — migración 001: capa de facturación y enlace con el Odoo ERP
--
-- Implementa el "Contrato de datos HEPTA Cloud ↔ Odoo" del runbook:
--   login (users) / entidad fiscal (billing_customers) / servicio (subscriptions)
--
-- Es idempotente (IF NOT EXISTS) y corre dentro de una transacción.
-- Requiere pgcrypto (ya instalada) para gen_random_uuid().
--
-- ATENCIÓN: contiene DOS renombres de columna que rompen código existente.
-- Ver la sección "3. RENOMBRES" al final y el listado de archivos a tocar.
--
-- Respaldo antes de correr:
--   pg_dump -h 127.0.0.1 -U <user> -d heptacloud -Fc -f /root/heptacloud_pre001.dump
--
-- Ejecución:
--   psql -h 127.0.0.1 -U <user> -d heptacloud -v ON_ERROR_STOP=1 -f migracion_heptacloud_001_billing.sql
-- ---------------------------------------------------------------------------

BEGIN;

-- ===========================================================================
-- 1. ENTIDAD FISCAL
-- ===========================================================================
-- Una fila por documento. NO por login y NO por negocio: un mismo usuario
-- puede administrar dos personas jurídicas, y cada una factura por separado.

CREATE TABLE IF NOT EXISTS billing_customers (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identidad fiscal
    tipo_persona      varchar(10)  NOT NULL DEFAULT 'juridica'
                      CHECK (tipo_persona IN ('fisica', 'juridica')),
    tipo_doc          varchar(10)  NOT NULL DEFAULT 'ruc'
                      CHECK (tipo_doc IN ('ruc', 'ci')),
    numero_doc        varchar(30)  NOT NULL,   -- como lo cargó el cliente
    dv                varchar(2),              -- dígito verificador, aparte
    -- Normalizado para comparar: solo dígitos. Es la clave real de identidad.
    doc_norm          varchar(30)  GENERATED ALWAYS AS
                      (regexp_replace(COALESCE(numero_doc, ''), '\D', '', 'g')) STORED,

    -- Nombres: legal y comercial SIEMPRE separados
    razon_social      varchar(255) NOT NULL,   -- va impreso en la factura
    nombre_comercial  varchar(255),            -- el que se muestra en el portal

    -- Contacto (HEPTA Cloud es dueño de estos campos)
    email             varchar(255),
    telefono          varchar(50),
    direccion         varchar(255),
    ciudad            varchar(100),
    departamento      varchar(100),

    -- Enlace con el Odoo ERP (Enterprise, heptagroup). NO con el tenant maestro.
    erp_partner_id    integer,
    erp_synced_at     timestamptz,
    erp_sync_state    varchar(20)  NOT NULL DEFAULT 'pendiente'
                      CHECK (erp_sync_state IN ('pendiente', 'ok', 'revision', 'error')),
    erp_last_error    text,

    origen            varchar(20),             -- 'hepta_cloud' | 'retopa' | 'migracion'
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now()
);

-- Un documento, una entidad fiscal. Es la regla que evita facturar dos veces
-- al mismo contribuyente con dos fichas distintas.
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_doc_uniq
    ON billing_customers (tipo_doc, doc_norm)
    WHERE doc_norm <> '';

CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_erp_partner_uniq
    ON billing_customers (erp_partner_id)
    WHERE erp_partner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_customers_sync_idx
    ON billing_customers (erp_sync_state);

COMMENT ON TABLE  billing_customers IS
    'Entidad fiscal: a quién se le factura. Una por documento.';
COMMENT ON COLUMN billing_customers.id IS
    'UUID que viaja a Odoo como hepta_client_id.';
COMMENT ON COLUMN billing_customers.erp_partner_id IS
    'res.partner del ERP Enterprise (heptagroup). No confundir con tenant_partner_id.';


-- ===========================================================================
-- 2. QUIÉN ADMINISTRA A QUIÉN
-- ===========================================================================
-- N a N a propósito: un dueño con dos empresas, y una empresa con dos personas
-- (el dueño y su contadora). Sin esto, eso termina en contraseñas compartidas.

CREATE TABLE IF NOT EXISTS account_billing_customers (
    user_id             integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    billing_customer_id uuid    NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
    rol                 varchar(20) NOT NULL DEFAULT 'titular'
                        CHECK (rol IN ('titular', 'admin', 'lectura')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, billing_customer_id)
);

CREATE INDEX IF NOT EXISTS account_billing_customers_bc_idx
    ON account_billing_customers (billing_customer_id);


-- ===========================================================================
-- 3. SUSCRIPCIONES
-- ===========================================================================
-- Hoy lo contratado vive repartido en `instances` (tenant) y `mail_domains`
-- (correo), sin nada en común y sin precio. Esta tabla es lo que los hace
-- facturables y lo que permite que entre un tercer producto sin inventar otra
-- tabla. Su `id` es el que viaja a Odoo como hepta_service_id.

CREATE TABLE IF NOT EXISTS subscriptions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    billing_customer_id uuid NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,

    producto            varchar(30) NOT NULL,   -- 'tenant_odoo' | 'correo' | 'correo_casillas' | 'retopa_plan'
    plan_slug           varchar(100),           -- 'starter' | 'professional' | ...
    -- Cantidad facturable: 1 para un plan, N para paquetes (casillas de correo,
    -- usuarios adicionales). El correo se vende por dominio con casillas
    -- incluidas, y los paquetes extra son una suscripción aparte con cantidad.
    cantidad            integer NOT NULL DEFAULT 1 CHECK (cantidad > 0),
    periodo             varchar(10) NOT NULL DEFAULT 'mensual'
                        CHECK (periodo IN ('mensual', 'anual')),
    -- Precio pactado, en guaraníes, IVA 10% INCLUIDO (decisión 2026-09-23).
    -- Anual = 10 mensualidades. Se guarda el número, no se recalcula: si mañana
    -- cambia la lista de precios, las suscripciones vigentes no se mueven solas.
    precio_gs           integer NOT NULL DEFAULT 0,

    estado              varchar(20) NOT NULL DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente', 'activa', 'suspendida', 'cancelada')),
    fecha_inicio        date,
    fecha_fin           date,
    proximo_cobro       date,

    -- Enlace con el ERP
    erp_order_id        integer,   -- sale.order
    erp_line_id         integer,   -- sale.order.line (lleva hepta_service_id = este id)

    notas               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_bc_idx      ON subscriptions (billing_customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_estado_idx  ON subscriptions (estado);
CREATE INDEX IF NOT EXISTS subscriptions_cobro_idx   ON subscriptions (proximo_cobro);

COMMENT ON COLUMN subscriptions.precio_gs IS
    'Guaraníes, IVA 10% incluido. Anual = 10 mensualidades (2 meses gratis).';

-- Lo aprovisionado cuelga de la suscripción
ALTER TABLE instances    ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES subscriptions(id);
ALTER TABLE mail_domains ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES subscriptions(id);

CREATE INDEX IF NOT EXISTS instances_subscription_idx    ON instances (subscription_id);
CREATE INDEX IF NOT EXISTS mail_domains_subscription_idx ON mail_domains (subscription_id);

-- El cobro también: payment_requests deja de referirse solo a un plan suelto.
ALTER TABLE payment_requests
    ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES subscriptions(id);
ALTER TABLE payment_requests
    ADD COLUMN IF NOT EXISTS erp_invoice_id integer;   -- account.move del ERP

CREATE INDEX IF NOT EXISTS payment_requests_subscription_idx
    ON payment_requests (subscription_id);


-- ===========================================================================
-- 4. COLA DE SINCRONIZACIÓN (la "cola de jobs" es esta tabla)
-- ===========================================================================
-- No hay Redis ni worker, y con este volumen no hacen falta. El checkout inserta
-- la fila e intenta enviarla en el acto con timeout corto; si el ERP no responde,
-- queda 'pendiente' y un cron la reintenta. Auditable con un SELECT.

CREATE TABLE IF NOT EXISTS odoo_sync_outbox (
    id           bigserial PRIMARY KEY,
    evento       varchar(50) NOT NULL,   -- 'cliente.alta' | 'suscripcion.alta' | 'pago.confirmado'
    ref_tipo     varchar(30),            -- 'billing_customer' | 'subscription' | 'payment_request'
    ref_id       text,
    payload      jsonb NOT NULL,
    estado       varchar(20) NOT NULL DEFAULT 'pendiente'
                 CHECK (estado IN ('pendiente', 'enviado', 'error', 'descartado')),
    intentos     integer NOT NULL DEFAULT 0,
    ultimo_error text,
    respuesta    jsonb,                  -- lo que devolvió hepta_find_or_create
    created_at   timestamptz NOT NULL DEFAULT now(),
    sent_at      timestamptz
);

CREATE INDEX IF NOT EXISTS odoo_sync_outbox_pendientes_idx
    ON odoo_sync_outbox (estado, created_at)
    WHERE estado IN ('pendiente', 'error');


-- ===========================================================================
-- 5. RENOMBRES — ACÁ SE ROMPE CÓDIGO
-- ===========================================================================
-- `odoo_partner_id` hoy guarda el partner del TENANT MAESTRO (Odoo 19 CE,
-- hepta_prod en 10.10.20.233), no el del ERP. Dejarlo con ese nombre mientras
-- aparece el partner del ERP es garantía de que alguien lea el campo equivocado.
--
-- Archivos que hay que ajustar DESPUÉS de correr esto:
--   backend/routes/admin.routes.js   (líneas ~224, 231, 237, 249, 258, 260)
--   backend/routes/auth.routes.js    (líneas ~42, 92)
--   backend/routes/portal.routes.js  (líneas ~11, 75, 88, 101)
--   backend/config/odoo.js           (líneas ~59, 70, 79)
-- Reemplazar `odoo_partner_id` por `tenant_partner_id` en SQL y en el JWT.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'users' AND column_name = 'odoo_partner_id')
    THEN
        ALTER TABLE users RENAME COLUMN odoo_partner_id TO tenant_partner_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'odoo_cache' AND column_name = 'odoo_partner_id')
    THEN
        ALTER TABLE odoo_cache RENAME COLUMN odoo_partner_id TO tenant_partner_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'instances' AND column_name = 'odoo_partner_id')
    THEN
        ALTER TABLE instances RENAME COLUMN odoo_partner_id TO tenant_partner_id;
    END IF;
END $$;

COMMENT ON COLUMN users.tenant_partner_id IS
    'res.partner del TENANT MAESTRO (Odoo CE, hepta_prod). El del ERP vive en billing_customers.erp_partner_id.';


-- ===========================================================================
-- 6. MANTENIMIENTO DE updated_at
-- ===========================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_customers_updated_at ON billing_customers;
CREATE TRIGGER billing_customers_updated_at BEFORE UPDATE ON billing_customers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS subscriptions_updated_at ON subscriptions;
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;

-- ---------------------------------------------------------------------------
-- Verificación posterior
-- ---------------------------------------------------------------------------
-- \d billing_customers
-- \d subscriptions
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'users' AND column_name LIKE '%partner%';
--
-- Deliberadamente NO se cargan datos: las 6 cuentas cliente existentes no tienen
-- documento fiscal en ningún lado, así que sus billing_customers se crean recién
-- cuando alguien les pida el RUC. Migrar sin documento sería fabricar fichas
-- fiscales vacías, que es justo lo que el contrato evita.
-- ---------------------------------------------------------------------------
