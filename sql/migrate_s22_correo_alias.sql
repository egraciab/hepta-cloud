-- HEPTA Cloud — S22: dominios de correo sin dueño
-- Un dominio sin dueño no aparece en ningún portal de cliente y solo lo
-- gestiona godmode. Sirve para importar o dar de alta antes de tener al cliente.
-- Idempotente: quitar un NOT NULL que ya no está no hace nada.

ALTER TABLE mail_domains ALTER COLUMN owner_email DROP NOT NULL;
