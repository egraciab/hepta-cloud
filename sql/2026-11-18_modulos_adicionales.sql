-- ============================================================
--  Módulos adicionales (rubros) que se suman a un plan: Boutique, Belleza y SPA…
--  Cada uno instala un módulo de Odoo (hepta_rubro_*) a través de la API de alta.
--  Precio: lo carga Steve en Admin → Planes → Módulos adicionales (0 = a definir).
-- ============================================================
CREATE TABLE IF NOT EXISTS addons (
  id           SERIAL PRIMARY KEY,
  slug         VARCHAR(50)  UNIQUE NOT NULL,
  name         VARCHAR(100) NOT NULL,
  description  TEXT,
  odoo_module  VARCHAR(100) NOT NULL CHECK (odoo_module ~ '^hepta_rubro_[a-z_]+$'),
  min_plan     VARCHAR(50)  NOT NULL DEFAULT 'professional',
  price        NUMERIC(12,0) DEFAULT 0,          -- Gs. por mes, además del plan
  price_label  VARCHAR(50),
  is_active    BOOLEAN DEFAULT TRUE,
  sort_order   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instance_addons (
  id            SERIAL PRIMARY KEY,
  instance_id   INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  addon_id      INTEGER NOT NULL REFERENCES addons(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'installing' CHECK (status IN ('installing','installed','failed')),
  error         TEXT,
  installed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (instance_id, addon_id)
);

INSERT INTO addons (slug, name, description, odoo_module, min_plan, price, price_label, sort_order) VALUES
  ('boutique', 'Boutique',
   'Talles y colores, caja con vendedoras, fidelidad, cupón de cumpleaños y agenda de citas (asesoría, pruebas, arreglos).',
   'hepta_rubro_boutique', 'professional', 0, 'A definir', 10),
  ('belleza', 'Belleza y SPA',
   'Peluquería, barbería, estética, uñas y SPA: agenda por profesional, caja con propinas, paquetes prepagos y fidelidad.',
   'hepta_rubro_belleza', 'professional', 0, 'A definir', 20)
ON CONFLICT (slug) DO NOTHING;
