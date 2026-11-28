-- Panel "Estado" del Admin nuevo: último reporte de cada monitor externo (hoy, el vigía de hcsvrnd01).
-- La clave del monitor no va acá: en site_config se guarda solo su SHA-256 (monitor_api_key), cargado a mano.
CREATE TABLE IF NOT EXISTS monitor_reportes (
  origen   text PRIMARY KEY,
  recibido timestamptz NOT NULL DEFAULT now(),
  datos    jsonb NOT NULL
);
