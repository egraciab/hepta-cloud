-- HC-S28: Links de pago Tpago por plan
INSERT INTO site_config (key, value) VALUES
  ('tpago_link_starter',      'https://www.tpago.com.py/links?alias=PTHFI32091&commerce_branch_name=HEPTA GROUP'),
  ('tpago_link_professional', 'https://www.tpago.com.py/links?alias=POAQS63489&commerce_branch_name=HEPTA GROUP'),
  ('tpago_link_enterprise',   ''),
  ('tpago_enabled',           'true')
ON CONFLICT (key) DO NOTHING;

-- Tabla para registrar solicitudes de pago pendientes
CREATE TABLE IF NOT EXISTS payment_requests (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id),
  plan          VARCHAR(50) NOT NULL,
  amount        INTEGER NOT NULL,
  currency      VARCHAR(10) DEFAULT 'PYG',
  status        VARCHAR(30) DEFAULT 'pending',
  -- pending | paid | provisioned | cancelled
  tpago_link    TEXT,
  notes         TEXT,
  confirmed_by  INTEGER REFERENCES users(id),
  confirmed_at  TIMESTAMPTZ,
  instance_id   INTEGER REFERENCES instances(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

GRANT ALL ON TABLE payment_requests TO hepta;
GRANT ALL ON SEQUENCE payment_requests_id_seq TO hepta;
