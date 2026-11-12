INSERT INTO site_config (key, value) VALUES
  ('btn_primary_url',    '/#planes'),
  ('retopa_logo_url',    '')
ON CONFLICT (key) DO NOTHING;
