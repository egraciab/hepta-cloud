-- Pedidos desde el sitio: plan elegido, datos para contratar y envío al ERP del grupo como oportunidad.
-- Respaldo antes de aplicar. No lleva credenciales. Se puede correr dos veces.
BEGIN;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS plan_slug          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS intent             VARCHAR(20) NOT NULL DEFAULT 'consulta',   -- consulta | contratar
  ADD COLUMN IF NOT EXISTS ruc                VARCHAR(30),
  ADD COLUMN IF NOT EXISTS acepta_terminos_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS erp_partner_id     INTEGER,
  ADD COLUMN IF NOT EXISTS erp_sync_state     VARCHAR(20),                               -- ok | error | NULL (sin enviar)
  ADD COLUMN IF NOT EXISTS erp_last_error     TEXT;

-- Envío de pedidos al ERP (Odoo del grupo). Arranca apagado: se enciende desde Admin → Configuración general.
-- El prefijo odoo_ es interno: /api/site-config no entrega estas claves.
INSERT INTO site_config (key, value, updated_at) VALUES
  ('odoo_erp_crm_enabled',    'false', NOW()),
  ('odoo_erp_crm_company_id', '',      NOW()),
  ('odoo_erp_crm_team_id',    '',      NOW()),
  ('odoo_erp_crm_user_id',    '',      NOW())
ON CONFLICT (key) DO NOTHING;

COMMIT;
