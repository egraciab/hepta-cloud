-- HC-S11: Importar instancias existentes en Odoo CE
-- Asignadas al usuario admin (id=1) — reasignar después

INSERT INTO instances (user_id, label, instance_url, db_name, plan, odoo_version, status, activated_at) VALUES
(1, 'Ase Legal',     'https://aselegal.erp.hepta.com.py',    'aselegal.erp.hepta.com.py',    'professional', '19.0', 'active', NOW()),
(1, 'Central Com',   'https://centralcom.erp.hepta.com.py',  'centralcom.erp.hepta.com.py',  'professional', '19.0', 'active', NOW()),
(1, 'Net',           'https://net.erp.hepta.com.py',          'net.erp.hepta.com.py',         'starter',      '19.0', 'active', NOW()),
(1, 'Prueba',        'https://prueba.erp.hepta.com.py',       'prueba.erp.hepta.com.py',      'starter',      '19.0', 'active', NOW()),
(1, 'Store',         'https://store.erp.hepta.com.py',        'store.erp.hepta.com.py',       'professional', '19.0', 'active', NOW()),
(1, 'Valente',       'https://valente.erp.hepta.com.py',      'valente.erp.hepta.com.py',     'professional', '19.0', 'active', NOW())
ON CONFLICT DO NOTHING;
-- micliente ya existe desde el provisioning de prueba
