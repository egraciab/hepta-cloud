-- HEPTA Cloud — S19: servicio de Correo (mailcow)
-- Idempotente: se puede correr varias veces sin romper nada.

CREATE TABLE IF NOT EXISTS mail_domains (
    id              SERIAL PRIMARY KEY,
    domain          TEXT        NOT NULL UNIQUE,
    owner_email     TEXT        NOT NULL,
    quota_mb        INTEGER     NOT NULL DEFAULT 10240,
    def_quota_mb    INTEGER     NOT NULL DEFAULT 1024,
    max_mailboxes   INTEGER     NOT NULL DEFAULT 50,
    dkim_selector   TEXT        NOT NULL DEFAULT 'dkim',
    status          TEXT        NOT NULL DEFAULT 'active',
    plan_code       TEXT,
    dns_verified_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mail_domains_status_chk CHECK (status IN ('active', 'suspended', 'pending'))
);

-- El email es la clave compartida entre RetoPA y HEPTA Cloud.
CREATE INDEX IF NOT EXISTS mail_domains_owner_idx  ON mail_domains (lower(owner_email));
CREATE INDEX IF NOT EXISTS mail_domains_status_idx ON mail_domains (status);

CREATE TABLE IF NOT EXISTS mail_provision_log (
    id         BIGSERIAL PRIMARY KEY,
    domain     TEXT        NOT NULL,
    action     TEXT        NOT NULL,
    success    BOOLEAN     NOT NULL DEFAULT TRUE,
    detail     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_provision_log_domain_idx ON mail_provision_log (domain, created_at DESC);
