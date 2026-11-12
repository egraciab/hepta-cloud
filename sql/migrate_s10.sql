-- HC-S10: config para API de provisioning
INSERT INTO site_config (key, value) VALUES
  ('provision_api_url',  'http://10.10.20.233:8888'),
  ('provision_api_key',  '')
ON CONFLICT (key) DO NOTHING;
