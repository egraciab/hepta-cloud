-- Nuevos campos editables
INSERT INTO site_config (key, value) VALUES
  ('email_wc_version',    'Hepta Cloud v19'),
  ('email_wc_portal_url', 'https://cloud.hepta.com.py/portal')
ON CONFLICT (key) DO NOTHING;

-- Actualizar template para usar {{email_version}} en lugar de hardcodeado "Odoo CE v19"
UPDATE email_templates SET
  body_html = REPLACE(body_html,
    '<div style="font-size:13px;font-weight:600;color:#1F2937">Odoo CE v19</div>',
    '<div style="font-size:13px;font-weight:600;color:#1F2937">{{email_version}}</div>'
  ),
  variables = '["nombre","instancia_url","plan","logo_html","email_titulo","email_subtitulo","email_cuerpo","email_paso1_titulo","email_paso1_desc","email_paso2_titulo","email_paso2_desc","email_paso3_titulo","email_paso3_desc","email_cierre","email_version","portal_url"]'
WHERE slug = 'welcome_client';
