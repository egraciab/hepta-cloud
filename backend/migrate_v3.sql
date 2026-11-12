-- ============================================================
--  HEPTA CLOUD — Migración v3
--  Agregar: services (pain points + soluciones editables)
-- ============================================================

CREATE TABLE services (
  id          SERIAL PRIMARY KEY,
  type        VARCHAR(20) NOT NULL CHECK (type IN ('pain','solution')),
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  icon_svg    TEXT,                    -- SVG path/content del ícono
  is_featured BOOLEAN DEFAULT FALSE,   -- destacado (solo type=solution)
  is_active   BOOLEAN DEFAULT TRUE,
  sort_order  INTEGER DEFAULT 0,
  badge_text  VARCHAR(50),             -- "Más solicitado", etc.
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER trg_services_updated_at
  BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Pain points
INSERT INTO services (type, title, description, sort_order, icon_svg) VALUES
('pain','Clientes solo en WhatsApp','Pedidos, cotizaciones y seguimientos mezclados entre mensajes. Sin historial real ni control de quién compró qué.',1,'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z'),
('pain','Ventas sin visibilidad','No sabés exactamente cuánto vendiste, qué margen tuvo cada venta, ni qué clientes son más rentables.',2,'M18 20V10M12 20V4M6 20v-6M2 20h20'),
('pain','Inventario desordenado','Productos en planillas, cuadernos o de memoria. Roturas de stock inesperadas y mermas sin detectar.',3,'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z'),
('pain','Facturación manual','Facturas en Word o Excel, sin numeración automática, sin control de cobros pendientes ni integración contable.',4,'M2 5h20v14H2zM2 10h20'),
('pain','Información dispersa','Datos en distintos sistemas, en correos o en la cabeza de cada empleado. Imposible tomar decisiones con eso.',5,'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 8v4M12 16h.01'),
('pain','Sin presencia digital','Tu empresa no tiene tienda online, catálogo digital ni forma de captar clientes fuera de las redes sociales.',6,'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');

-- Soluciones
INSERT INTO services (type, title, description, sort_order, icon_svg, is_featured, badge_text) VALUES
('solution','CRM de ventas','Seguí cada oportunidad. Pipeline visual, recordatorios automáticos, historial completo de cada cliente.',1,'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100 8 4 4 0 000-8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',true,'Más solicitado'),
('solution','Tienda online','E-commerce integrado con tu inventario y facturación. Tus clientes compran 24/7 sin que tengas que estar.',2,'M9 21a1 1 0 100-2 1 1 0 000 2zM20 21a1 1 0 100-2 1 1 0 000 2zM1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6',false,null),
('solution','Punto de venta','PoS para locales físicos, sincronizado en tiempo real con tu stock y caja. Funciona sin internet.',3,'M2 3h20v14H2zM8 21h8M12 17v4',false,null),
('solution','Facturación y contabilidad','Facturación electrónica, cuentas por cobrar/pagar, reportes listos para el contador.',4,'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',false,null);

-- Endpoint público de planes y servicios en site_config
INSERT INTO site_config (key, value) VALUES
  ('pain_title',    '¿Te suena familiar?'),
  ('pain_subtitle', 'Los problemas que frenan tu crecimiento'),
  ('sol_title',     'Todo lo que tu empresa necesita, integrado'),
  ('sol_subtitle',  'Un solo sistema cubre todas las áreas de tu negocio. Sin parches, sin integraciones complicadas.')
ON CONFLICT (key) DO NOTHING;
