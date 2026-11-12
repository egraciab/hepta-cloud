INSERT INTO site_config (key, value) VALUES
  ('perimetral_api_url', 'http://192.168.10.125:8888'),
  ('perimetral_api_key', '')
ON CONFLICT (key) DO NOTHING;
