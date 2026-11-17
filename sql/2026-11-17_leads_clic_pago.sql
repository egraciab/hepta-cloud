-- Pedidos del sitio: cuándo la persona tocó "Pagar con tPago" (el botón pasa por HEPTA Cloud, que avisa y redirige).
-- Respaldo antes de aplicar. No lleva credenciales. Se puede correr dos veces.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pago_clic_at TIMESTAMPTZ;
