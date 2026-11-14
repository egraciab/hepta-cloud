-- Contenido del sitio público: se ajusta a lo que hoy entrega cada plan (decidido con Steve el 2026-11-14).
-- Respaldo antes de aplicar. No lleva credenciales.
BEGIN;

-- ── Planes ──
UPDATE plans SET features = '["Sitio web con formulario de contacto","CRM: clientes y oportunidades","Presupuestos y ventas","Facturación y contabilidad para Paraguay","2 usuarios","Soporte por correo"]'::jsonb,
       updated_at = NOW() WHERE slug = 'starter';
UPDATE plans SET features = '["Todo lo de Despegue","Facturación electrónica SIFEN","Tienda online","Punto de venta","Inventario","Hasta 4 usuarios","Soporte prioritario"]'::jsonb,
       updated_at = NOW() WHERE slug = 'professional';
UPDATE plans SET features = '["Todo lo de Crecimiento","Usuarios según tu operación","Módulos y desarrollos a medida","Implementación acompañada","Soporte con tiempos de respuesta acordados"]'::jsonb,
       updated_at = NOW() WHERE slug = 'enterprise';

-- ── Soluciones ──
UPDATE services SET description = 'Seguí cada oportunidad. Pipeline visual, recordatorios automáticos e historial completo de cada cliente.',
       updated_at = NOW() WHERE type = 'solution' AND title = 'CRM de ventas';
UPDATE services SET description = 'E-commerce integrado con tu inventario y facturación. Tus clientes compran 24/7 sin que tengas que estar. Cobro en línea con Bancard (necesitás tu cuenta de comercio en Bancard).',
       updated_at = NOW() WHERE type = 'solution' AND title = 'Tienda online';

-- ── Textos generales y correo de bienvenida ──
INSERT INTO site_config (key, value, updated_at) VALUES
  ('plans_subtitle', 'Precios con IVA incluido. Todos los planes incluyen implementación, capacitación y soporte local.', NOW()),
  ('meta_title', 'Hepta Cloud — Sistema de gestión para PyMEs en Paraguay', NOW()),
  ('meta_description', 'Ventas, clientes, inventario y facturación electrónica SIFEN en un solo sistema, configurado para tu negocio y alojado en Paraguay. Planes desde ₲ 169.000 por mes.', NOW()),
  ('email_wc_paso1_titulo', 'Ingresá a tu sistema', NOW()),
  ('email_wc_paso1_desc', 'Usá el usuario y la contraseña que figuran en este correo. Te recomendamos cambiar la contraseña en el primer ingreso.', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

COMMIT;
