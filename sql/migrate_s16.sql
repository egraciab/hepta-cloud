UPDATE email_templates SET
  body_html = REPLACE(
    body_html,
    '<div style="display:inline-block;background:#1254A4;border-radius:6px;padding:8px 14px;margin-bottom:16px">
      <span style="color:#ffffff;font-size:14px;font-weight:600;letter-spacing:.5px">HEPTA CLOUD</span>
    </div>',
    '{{logo_html}}'
  ),
  variables = '["nombre","instancia_url","plan","logo_html"]'
WHERE slug = 'welcome_client';
