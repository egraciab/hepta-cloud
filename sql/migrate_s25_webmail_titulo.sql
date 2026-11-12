-- HEPTA Cloud — S25: título del webmail por dominio
-- Reemplaza "mailcow UI" en la pestaña del navegador y en el encabezado del
-- login por el nombre que le pongamos al cliente (p.ej. "Webmail Adelanta").
-- Idempotente.

ALTER TABLE mail_domains ADD COLUMN IF NOT EXISTS webmail_title TEXT;
