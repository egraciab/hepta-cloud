-- ============================================================
--  HEPTA CLOUD — Migración v2
--  Agregar: plans, email_templates, upload logo, SMTP config
-- ============================================================

-- ------------------------------------------------------------
--  PLANES
-- ------------------------------------------------------------
CREATE TABLE plans (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  slug          VARCHAR(100) UNIQUE NOT NULL,
  price         NUMERIC(12,0) DEFAULT 0,       -- en Gs.
  price_label   VARCHAR(50),                    -- "₲ 450.000/mes"
  description   TEXT,
  features      JSONB DEFAULT '[]',             -- ["CRM", "E-commerce", ...]
  is_featured   BOOLEAN DEFAULT FALSE,
  is_active     BOOLEAN DEFAULT TRUE,
  sort_order    INTEGER DEFAULT 0,
  badge_text    VARCHAR(50),                    -- "Más popular", "Nuevo", etc.
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER trg_plans_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO plans (name, slug, price, price_label, description, features, is_featured, sort_order, badge_text) VALUES
  ('Starter', 'starter', 450000, '₲ 450.000/mes',
   'Ideal para empezar a ordenar tu negocio.',
   '["CRM de ventas", "Hasta 3 usuarios", "Facturación básica", "Soporte por email"]',
   false, 1, null),
  ('Professional', 'professional', 950000, '₲ 950.000/mes',
   'Para empresas en crecimiento que necesitan más.',
   '["Todo lo de Starter", "Tienda online", "Punto de venta", "Hasta 10 usuarios", "Inventario avanzado", "Soporte prioritario"]',
   true, 2, 'Más popular'),
  ('Enterprise', 'enterprise', 0, 'A consultar',
   'Solución completa para operaciones complejas.',
   '["Todo lo de Professional", "Usuarios ilimitados", "Módulos a medida", "Implementación dedicada", "SLA garantizado", "Soporte 24/7"]',
   false, 3, null);

-- ------------------------------------------------------------
--  EMAIL TEMPLATES
-- ------------------------------------------------------------
CREATE TABLE email_templates (
  id          SERIAL PRIMARY KEY,
  slug        VARCHAR(100) UNIQUE NOT NULL,
  name        VARCHAR(255) NOT NULL,
  subject     VARCHAR(500) NOT NULL,
  body_html   TEXT NOT NULL,
  variables   JSONB DEFAULT '[]',   -- ["{{nombre}}", "{{empresa}}"]
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER trg_email_templates_updated_at
  BEFORE UPDATE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO email_templates (slug, name, subject, body_html, variables) VALUES
  ('lead_received', 'Notificación de nuevo lead', 'Nueva consulta de {{nombre}}',
   '<h2>Nueva consulta recibida</h2><p><strong>Nombre:</strong> {{nombre}}</p><p><strong>Empresa:</strong> {{empresa}}</p><p><strong>Email:</strong> {{email}}</p><p><strong>Teléfono:</strong> {{telefono}}</p><p><strong>Mensaje:</strong><br>{{mensaje}}</p>',
   '["{{nombre}}", "{{empresa}}", "{{email}}", "{{telefono}}", "{{mensaje}}"]'),
  ('welcome_client', 'Bienvenida al portal', 'Bienvenido a Hepta Cloud, {{nombre}}',
   '<h2>¡Bienvenido, {{nombre}}!</h2><p>Tu acceso al portal de Hepta Cloud está listo.</p><p><strong>URL de tu sistema:</strong> <a href="{{instancia_url}}">{{instancia_url}}</a></p><p><strong>Tu acceso al portal:</strong> <a href="https://cloud.hepta.com.py/portal">cloud.hepta.com.py/portal</a></p><p>Si tenés alguna consulta, respondé este email o escribinos por WhatsApp.</p>',
   '["{{nombre}}", "{{instancia_url}}"]');

-- ------------------------------------------------------------
--  SMTP + configuraciones adicionales en site_config
-- ------------------------------------------------------------
INSERT INTO site_config (key, value) VALUES
  ('smtp_host',         ''),
  ('smtp_port',         '465'),
  ('smtp_user',         ''),
  ('smtp_pass',         ''),
  ('smtp_from_name',    'Hepta Cloud'),
  ('smtp_from_email',   ''),
  ('smtp_secure',       'true'),
  ('logo_url',          ''),
  ('logo_uploaded',     'false'),
  ('plans_title',       'Planes simples, sin sorpresas'),
  ('plans_subtitle',    'Todos los planes incluyen implementación, capacitación y soporte local.')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
--  UPLOADS (registro de archivos subidos)
-- ------------------------------------------------------------
CREATE TABLE uploads (
  id            SERIAL PRIMARY KEY,
  filename      VARCHAR(500) NOT NULL,
  original_name VARCHAR(500),
  mime_type     VARCHAR(100),
  size_bytes    INTEGER,
  url           VARCHAR(500),
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
