-- 2026-11-27 — HEPTA Mail: el paquete base son 3 casillas de 5 GB (15 GB del dominio); 10 GB por casilla para
-- estudios o a pedido. Solo cambia los valores por defecto de la tabla (el código ya manda los valores al crear):
-- los dominios existentes quedan como están.
ALTER TABLE mail_domains ALTER COLUMN quota_mb SET DEFAULT 15360;
ALTER TABLE mail_domains ALTER COLUMN def_quota_mb SET DEFAULT 5120;
