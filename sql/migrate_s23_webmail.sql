-- HEPTA Cloud — S23: webmail con marca propia por dominio
-- Guarda el host que el cliente ve en su portal (p. ej. mail.adelanta.com.py).
-- Vacío = se usa el webmail genérico de HEPTA.
-- Idempotente.

ALTER TABLE mail_domains ADD COLUMN IF NOT EXISTS webmail_host TEXT;
