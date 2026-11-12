-- Agregar URL base del sitio para emails
INSERT INTO site_config (key, value) VALUES
  ('site_url', 'https://cloud.hepta.com.py')
ON CONFLICT (key) DO NOTHING;

-- Separar contenido editable del welcome_client en variables
-- El HTML queda como esqueleto con {{variables}}, el admin edita solo los textos
UPDATE email_templates SET
  variables = '["nombre","instancia_url","plan","logo_html","email_titulo","email_subtitulo","email_cuerpo","email_paso1_titulo","email_paso1_desc","email_paso2_titulo","email_paso2_desc","email_paso3_titulo","email_paso3_desc","email_cierre","portal_url"]'
WHERE slug = 'welcome_client';

-- Textos editables por defecto para welcome_client
INSERT INTO site_config (key, value) VALUES
  ('email_wc_titulo',       '¡Tu sistema está listo!'),
  ('email_wc_subtitulo',    'Ya podés acceder a tu Odoo CE v19'),
  ('email_wc_cuerpo',       'tu instancia de Odoo CE v19 fue provisionada y está activa.'),
  ('email_wc_paso1_titulo', 'Ingresá con las credenciales de administrador'),
  ('email_wc_paso1_desc',   'Usuario: admin · Contraseña: admin (cambiala al primer ingreso)'),
  ('email_wc_paso2_titulo', 'Configurá tu empresa'),
  ('email_wc_paso2_desc',   'Nombre, RUC, logo y datos de facturación'),
  ('email_wc_paso3_titulo', 'Explorá tu portal de cliente'),
  ('email_wc_paso3_desc',   'Gestioná tu suscripción, facturas y soporte'),
  ('email_wc_cierre',       '¿Necesitás ayuda? Respondé este email o escribinos por WhatsApp. Nuestro equipo está disponible de lunes a viernes, 9:00 a 17:00.')
ON CONFLICT (key) DO NOTHING;

-- Actualizar body_html para usar variables de texto editables
UPDATE email_templates SET
  body_html = '<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="margin:0;padding:0;background:#F3F4F6;font-family:system-ui,-apple-system,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #E5E7EB">
  <tr><td style="background:#0D1F5C;padding:32px 40px;text-align:center">
    <div style="margin-bottom:16px">{{logo_html}}</div>
    <h1 style="color:#ffffff;font-size:22px;font-weight:600;margin:0 0 8px">{{email_titulo}}</h1>
    <p style="color:rgba(255,255,255,0.7);font-size:14px;margin:0">{{email_subtitulo}}</p>
  </td></tr>
  <tr><td style="padding:32px 40px">
    <p style="color:#6B7280;font-size:15px;line-height:1.6;margin:0 0 24px">Hola <strong style="color:#1F2937">{{nombre}}</strong>, {{email_cuerpo}}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;margin-bottom:24px">
      <tr><td style="padding:20px">
        <p style="font-size:11px;font-weight:700;color:#1D4ED8;text-transform:uppercase;letter-spacing:.5px;margin:0 0 14px">Tu sistema</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="50%" style="padding-bottom:12px;vertical-align:top">
              <div style="font-size:11px;color:#9CA3AF;margin-bottom:3px">URL de acceso</div>
              <div style="font-size:13px;font-weight:600;color:#1D4ED8;word-break:break-all">{{instancia_url}}</div>
            </td>
            <td width="50%" style="padding-bottom:12px;vertical-align:top;padding-left:16px">
              <div style="font-size:11px;color:#9CA3AF;margin-bottom:3px">Plan</div>
              <div style="font-size:13px;font-weight:600;color:#1F2937">{{plan}}</div>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:16px;vertical-align:top">
              <div style="font-size:11px;color:#9CA3AF;margin-bottom:3px">Versión</div>
              <div style="font-size:13px;font-weight:600;color:#1F2937">Odoo CE v19</div>
            </td>
            <td style="padding-bottom:16px;vertical-align:top;padding-left:16px">
              <div style="font-size:11px;color:#9CA3AF;margin-bottom:3px">Estado</div>
              <div style="font-size:12px;font-weight:600;color:#059669">● Activo</div>
            </td>
          </tr>
        </table>
        <a href="{{instancia_url}}" style="display:inline-block;background:#1254A4;color:#ffffff;padding:10px 24px;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none">Acceder a mi sistema →</a>
      </td></tr>
    </table>
    <p style="font-size:13px;font-weight:600;color:#1F2937;margin:0 0 12px">Primeros pasos recomendados:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="padding-bottom:10px">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="width:26px;height:26px;background:#EFF6FF;border-radius:50%;text-align:center;vertical-align:middle;font-size:11px;font-weight:700;color:#1D4ED8">1</td>
          <td style="padding-left:10px"><strong style="font-size:13px;color:#1F2937">{{email_paso1_titulo}}</strong><br/><span style="font-size:12px;color:#6B7280">{{email_paso1_desc}}</span></td>
        </tr></table>
      </td></tr>
      <tr><td style="padding-bottom:10px">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="width:26px;height:26px;background:#EFF6FF;border-radius:50%;text-align:center;vertical-align:middle;font-size:11px;font-weight:700;color:#1D4ED8">2</td>
          <td style="padding-left:10px"><strong style="font-size:13px;color:#1F2937">{{email_paso2_titulo}}</strong><br/><span style="font-size:12px;color:#6B7280">{{email_paso2_desc}}</span></td>
        </tr></table>
      </td></tr>
      <tr><td>
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="width:26px;height:26px;background:#EFF6FF;border-radius:50%;text-align:center;vertical-align:middle;font-size:11px;font-weight:700;color:#1D4ED8">3</td>
          <td style="padding-left:10px"><strong style="font-size:13px;color:#1F2937">{{email_paso3_titulo}}</strong><br/><span style="font-size:12px;color:#6B7280">{{email_paso3_desc}}</span></td>
        </tr></table>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:24px">
      <tr><td style="padding:16px 20px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td><strong style="font-size:13px;color:#1F2937">Portal de clientes</strong><br/><span style="font-size:12px;color:#6B7280">Facturas, tickets y estado de tu suscripción</span></td>
          <td align="right"><a href="{{portal_url}}" style="font-size:12px;color:#1254A4;text-decoration:none">{{portal_url}} →</a></td>
        </tr></table>
      </td></tr>
    </table>
    <p style="font-size:13px;color:#6B7280;line-height:1.6;margin:0">{{email_cierre}}</p>
  </td></tr>
  <tr><td style="border-top:1px solid #E5E7EB;padding:20px 40px;text-align:center">
    <p style="font-size:11px;color:#9CA3AF;margin:0">HEPTA CLOUD · Asunción, Paraguay · <a href="{{portal_url}}" style="color:#9CA3AF">cloud.hepta.com.py</a></p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>'
WHERE slug = 'welcome_client';
