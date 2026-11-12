-- HC-S19: dominio propio
ALTER TABLE instances ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255);
ALTER TABLE instances ADD COLUMN IF NOT EXISTS custom_domain_status VARCHAR(50) DEFAULT 'none';
-- none | pending_dns | pending_activation | active

INSERT INTO site_config (key, value) VALUES
  ('perimetral_certbot_email', 'admin@hepta.com.py'),
  ('cloudflare_api_token', '')
ON CONFLICT (key) DO NOTHING;
