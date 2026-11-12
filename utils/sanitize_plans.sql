-- =====================================================================
--  SANEO DE PRECIOS — tabla `plans` (DB heptacloud, correr en HC VM)
--  La tabla `plans` es ahora la ÚNICA fuente de verdad de los precios.
--  El seed original (migrate_v2.sql) traía 450k/950k — valores viejos.
--  Este script deja price y price_label sincronizados con el briefing.
--
--  ⚠️ VERIFICÁ PRIMERO qué hay en producción antes de correr el UPDATE:
--      SELECT slug, name, price, price_label, is_active FROM plans ORDER BY sort_order;
--  Si el admin ya cargó los precios correctos desde el panel, no hace falta.
-- =====================================================================

BEGIN;

UPDATE plans SET price = 169000, price_label = '₲ 169.000/mes'
  WHERE slug = 'starter';

UPDATE plans SET price = 319000, price_label = '₲ 319.000/mes'
  WHERE slug = 'professional';

UPDATE plans SET price = 0, price_label = 'A consultar'
  WHERE slug = 'enterprise';

-- Control: revisá el resultado antes de confirmar
SELECT slug, name, price, price_label, is_active FROM plans ORDER BY sort_order;

COMMIT;
