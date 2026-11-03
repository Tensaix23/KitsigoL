-- ============================================================
-- Base de datos del WMS · Centro logístico (SQLite 3)
-- Se ejecuta automáticamente al iniciar el servidor (idempotente).
-- Convenciones: `pos` conserva el orden de las listas de la aplicación.
-- Los booleanos se guardan como 0/1. Las fechas como texto ISO.
-- ============================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- Control ----------
CREATE TABLE IF NOT EXISTS meta    (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS counter (name TEXT PRIMARY KEY, value INTEGER NOT NULL);   -- correlativos (pedidos, folios, SSCC…)
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT);

-- ---------- Datos maestros ----------
CREATE TABLE IF NOT EXISTS product (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  weight_kg REAL, volume_l REAL, monthly_rotation REAL,
  cost REAL, price REAL,
  serialized INTEGER NOT NULL DEFAULT 0,
  perishable INTEGER NOT NULL DEFAULT 0,
  pos INTEGER
);
CREATE TABLE IF NOT EXISTS supplier (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  rut TEXT, contact TEXT, phone TEXT, email TEXT, pos INTEGER
);
CREATE TABLE IF NOT EXISTS customer (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, rut TEXT,
  address TEXT, comuna TEXT, x_km REAL, y_km REAL, pos INTEGER
);
CREATE TABLE IF NOT EXISTS carrier (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  rut TEXT, contact TEXT, phone TEXT, pos INTEGER
);
CREATE TABLE IF NOT EXISTS vehicle (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, plate TEXT NOT NULL UNIQUE,
  carrier_id TEXT REFERENCES carrier(id) ON DELETE SET NULL,      -- NULL = flota propia
  driver TEXT, driver_phone TEXT,
  capacity_kg REAL, capacity_packages INTEGER,
  active INTEGER NOT NULL DEFAULT 1, pos INTEGER
);
CREATE TABLE IF NOT EXISTS location (
  id TEXT PRIMARY KEY, zone TEXT NOT NULL, aisle INTEGER, bay INTEGER, level INTEGER,
  capacity_l REAL, capacity_kg REAL, pos INTEGER
);

-- ---------- Inventario ----------
CREATE TABLE IF NOT EXISTS stock_lot (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES product(sku),
  lot TEXT, expiry TEXT,
  qty INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0,
  location_id TEXT,                                               -- puede ser 'MUELLE' (sin ubicar)
  status TEXT NOT NULL DEFAULT 'ok',                              -- ok | cuarentena | reacond | garantia
  pos INTEGER,
  CHECK (qty >= 0 AND reserved >= 0 AND reserved <= qty)
);
CREATE INDEX IF NOT EXISTS ix_stock_sku ON stock_lot(sku);
CREATE INDEX IF NOT EXISTS ix_stock_loc ON stock_lot(location_id);
CREATE TABLE IF NOT EXISTS stock_serial (
  serial TEXT PRIMARY KEY,
  stock_id TEXT NOT NULL REFERENCES stock_lot(id) ON DELETE CASCADE,
  pos INTEGER
);
CREATE TABLE IF NOT EXISTS movement (                             -- kardex de trazabilidad
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT, type TEXT, sku TEXT, lot TEXT, qty REAL, location TEXT, ref TEXT, pos INTEGER
);
CREATE INDEX IF NOT EXISTS ix_mov_sku_lot ON movement(sku, lot);

-- ---------- Recepción (órdenes de compra / ASN) ----------
CREATE TABLE IF NOT EXISTS inbound (
  id TEXT PRIMARY KEY, po_number TEXT,
  supplier_id TEXT REFERENCES supplier(id) ON DELETE SET NULL, supplier_name TEXT,
  eta TEXT, status TEXT, pos INTEGER
);
CREATE TABLE IF NOT EXISTS inbound_line (
  inbound_id TEXT NOT NULL REFERENCES inbound(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL, sku TEXT NOT NULL REFERENCES product(sku),
  expected INTEGER, received INTEGER,
  PRIMARY KEY (inbound_id, line_no)
);

-- ---------- Pedidos de venta ----------
CREATE TABLE IF NOT EXISTS sales_order (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customer(id),
  priority TEXT, status TEXT, created_at TEXT,
  route_id TEXT, wave_id TEXT, replacement_note TEXT, pos INTEGER
);
CREATE INDEX IF NOT EXISTS ix_order_status ON sales_order(status);
CREATE TABLE IF NOT EXISTS sales_order_line (
  order_id TEXT NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL, sku TEXT NOT NULL REFERENCES product(sku), qty INTEGER NOT NULL,
  PRIMARY KEY (order_id, line_no)
);
CREATE TABLE IF NOT EXISTS order_line_serial (                    -- series entregadas por línea
  order_id TEXT NOT NULL, line_no INTEGER NOT NULL, pos INTEGER, serial TEXT NOT NULL,
  PRIMARY KEY (order_id, line_no, serial),
  FOREIGN KEY (order_id, line_no) REFERENCES sales_order_line(order_id, line_no) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_ols_serial ON order_line_serial(serial);

-- ---------- Picking ----------
CREATE TABLE IF NOT EXISTS wave (
  id TEXT PRIMARY KEY, type TEXT, status TEXT, created_at TEXT, line_count INTEGER, pos INTEGER
);
CREATE TABLE IF NOT EXISTS wave_order (
  wave_id TEXT NOT NULL REFERENCES wave(id) ON DELETE CASCADE, order_id TEXT NOT NULL, pos INTEGER,
  PRIMARY KEY (wave_id, order_id)
);
CREATE TABLE IF NOT EXISTS wave_task (
  wave_id TEXT NOT NULL REFERENCES wave(id) ON DELETE CASCADE, task_no INTEGER NOT NULL,
  task_ref TEXT, stock_id TEXT, location_id TEXT, zone TEXT, sku TEXT, lot TEXT, expiry TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wave_id, task_no)
);
CREATE TABLE IF NOT EXISTS wave_task_part (
  wave_id TEXT NOT NULL, task_no INTEGER NOT NULL, pos INTEGER, order_id TEXT NOT NULL, qty INTEGER NOT NULL,
  PRIMARY KEY (wave_id, task_no, order_id),
  FOREIGN KEY (wave_id, task_no) REFERENCES wave_task(wave_id, task_no) ON DELETE CASCADE
);

-- ---------- Packing ----------
CREATE TABLE IF NOT EXISTS package (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sales_order(id),
  seq INTEGER, total INTEGER,
  sscc TEXT NOT NULL UNIQUE,                                      -- SSCC-18 (GS1-128, AI 00)
  kg REAL, box TEXT, created_at TEXT, weight_diff REAL, pos INTEGER
);
CREATE INDEX IF NOT EXISTS ix_pkg_order ON package(order_id);

-- ---------- Rutas y despacho ----------
CREATE TABLE IF NOT EXISTS route (
  id TEXT PRIMARY KEY, vehicle_id TEXT REFERENCES vehicle(id),
  status TEXT, created_at TEXT, departed_at TEXT, pos INTEGER
);
CREATE TABLE IF NOT EXISTS route_stop (
  route_id TEXT NOT NULL REFERENCES route(id) ON DELETE CASCADE,
  stop_no INTEGER NOT NULL, order_id TEXT NOT NULL,
  PRIMARY KEY (route_id, stop_no)
);
CREATE TABLE IF NOT EXISTS route_folio (                          -- folio de la guía de despacho por pedido
  route_id TEXT NOT NULL REFERENCES route(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL, folio INTEGER NOT NULL,
  PRIMARY KEY (route_id, order_id)
);

-- ---------- Postventa ----------
CREATE TABLE IF NOT EXISTS return_item (
  id TEXT PRIMARY KEY, order_id TEXT, sku TEXT REFERENCES product(sku), qty INTEGER, serial TEXT,
  reason TEXT, condition TEXT, warranty INTEGER, lot TEXT, expiry TEXT,
  suggested_dest TEXT, rationale TEXT,
  dest TEXT,                                                      -- reingreso | reacond | garantia | merma
  status TEXT, location TEXT, rma TEXT, credit_folio TEXT, created_at TEXT, pos INTEGER
);
CREATE TABLE IF NOT EXISTS credit_note (
  folio TEXT PRIMARY KEY, seq INTEGER, type TEXT,                 -- Nota de crédito | Reemplazo
  return_id TEXT, order_id TEXT, customer_name TEXT, sku TEXT, qty INTEGER,
  net REAL, vat REAL, total REAL,
  status TEXT,                                                    -- Pendiente | Sincronizando | Sincronizada | Error
  erp_ref TEXT, tries INTEGER, error TEXT, new_order TEXT, created_at TEXT, pos INTEGER
);
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, msg TEXT, level TEXT, pos INTEGER
);

-- ---------- Vistas de apoyo para integraciones (solo lectura) ----------
CREATE VIEW IF NOT EXISTS v_stock_por_sku AS
  SELECT p.sku, p.name, SUM(s.qty) AS total, SUM(s.reserved) AS reservado,
         SUM(CASE WHEN s.status='ok' THEN s.qty - s.reserved ELSE 0 END) AS disponible
  FROM product p LEFT JOIN stock_lot s ON s.sku = p.sku GROUP BY p.sku;
CREATE VIEW IF NOT EXISTS v_lotes_por_vencer AS
  SELECT s.sku, p.name, s.lot, s.expiry, s.qty, s.location_id,
         CAST(julianday(s.expiry) - julianday('now','localtime') AS INTEGER) AS dias
  FROM stock_lot s JOIN product p ON p.sku = s.sku
  WHERE s.expiry IS NOT NULL AND s.qty > 0 ORDER BY s.expiry;
CREATE VIEW IF NOT EXISTS v_pedidos_pendientes AS
  SELECT o.id, c.name AS cliente, c.comuna, o.priority, o.status FROM sales_order o
  JOIN customer c ON c.id = o.customer_id WHERE o.status <> 'Despachado';
