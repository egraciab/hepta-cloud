-- HC-S7: hero panel image configurable
INSERT INTO site_config (key, value) VALUES
  ('hero_panel_image', ''),
  ('hero_panel_show',  'animation')
ON CONFLICT (key) DO NOTHING;
