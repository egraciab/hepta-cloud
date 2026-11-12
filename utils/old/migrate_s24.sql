-- HC-S24: Integración RetoPA SSO
INSERT INTO site_config (key, value) VALUES
  ('retopa_api_url',    'http://RETOPA_VM_IP:3000'),
  ('retopa_api_key',    ''),
  ('retopa_enabled',    'true'),
  ('retopa_auto_list',  'true')
ON CONFLICT (key) DO NOTHING;

-- Agregar retopa_business_id a instancias
ALTER TABLE instances ADD COLUMN IF NOT EXISTS retopa_business_id INTEGER;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS retopa_listing BOOLEAN DEFAULT TRUE;

-- Agregar retopa_user_id a users de HC
ALTER TABLE users ADD COLUMN IF NOT EXISTS retopa_user_id INTEGER;
