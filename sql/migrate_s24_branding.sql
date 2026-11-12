-- HEPTA Cloud — S24: branding del webmail por dominio
-- El logo se sube desde el admin y se guarda en frontend/assets/uploads/
-- (volumen montado, sobrevive al rebuild). Acá solo queda el nombre del archivo.
-- Idempotente.

ALTER TABLE mail_domains ADD COLUMN IF NOT EXISTS webmail_logo_url TEXT;
ALTER TABLE mail_domains ADD COLUMN IF NOT EXISTS webmail_color    TEXT;

-- El CSS público se busca por webmail_host en cada request del navegador.
CREATE INDEX IF NOT EXISTS mail_domains_webmail_host_idx ON mail_domains (lower(webmail_host));
