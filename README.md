# WMS Centro Logístico · Base de datos y servidor

Contiene la base de datos (SQLite), la API que la conecta con la aplicación y la propia aplicación.

## Puesta en marcha
Requiere Node.js 18 o superior.

```bash
npm install
npm start            # http://localhost:3000
```
Al abrir la aplicación por primera vez, la base está vacía: la app carga los datos de ejemplo y los guarda.
Para empezar con datos propios, use «Restablecer datos de ejemplo» y luego edite desde *Datos maestros*.

Variables opcionales: `PORT`, `DB_PATH` (por defecto `data/wms.db`), `API_KEY` (ver `.env.example`).

## Archivos
| Archivo | Función |
|---|---|
| `schema.sql` | Esquema: 28 tablas y 3 vistas. Se aplica solo al iniciar (idempotente). |
| `mapper.js` | Convierte entre el estado de la app y las tablas. Guarda todo en una transacción. |
| `server.js` | API REST y servidor de la aplicación. |
| `public/wms-db.js` | **Conector** entre la app y la API: carga, guarda con retraso de 0,7 s, detecta conflictos y cambios de otros usuarios. |
| `public/index.html` | La aplicación, ya enlazada al conector. |
| `public/vendor/` | Librerías de códigos de barras y QR (funciona sin internet). |
| `data/wms.db` | Se crea al iniciar. Es el archivo a respaldar. |

## Cómo se enlazan
1. La app llama a `WMSDB.pull()` al abrir y carga el estado desde la base.
2. Cada cambio llama a `WMSDB.push(estado)`, que lo envía a `PUT /api/state`.
3. El servidor valida la versión y reescribe las tablas en una transacción. Si algo viola una regla (stock negativo, SKU inexistente, patente repetida), no guarda nada y devuelve el error.
4. Si otro usuario guardó antes, el servidor responde 409 y la app muestra «Otro usuario guardó antes»; con «Cargar datos actualizados» se recarga. Si la conexión se cae, la app reintenta cada 5 s.

El indicador del menú lateral muestra el estado: conectada, guardando, sin conexión, conflicto o cambios de otros usuarios.

## API
| Método y ruta | Uso |
|---|---|
| `GET /api/health` | Estado del servicio |
| `GET /api/version` | Versión actual de los datos |
| `GET /api/state` · `PUT /api/state` | Lectura y guardado completo (lo usa la app) |
| `GET /api/tables` | Lista de tablas y vistas |
| `GET /api/tables/:nombre?limit=200&offset=0` | Filas de una tabla o vista, solo lectura (para el ERP, BI, etc.) |

Vistas útiles: `v_stock_por_sku`, `v_lotes_por_vencer`, `v_pedidos_pendientes`.

## Tablas
- **Maestros:** `product`, `supplier`, `customer`, `carrier`, `vehicle`, `location`
- **Inventario:** `stock_lot`, `stock_serial`, `movement`
- **Recepción:** `inbound`, `inbound_line`
- **Pedidos y picking:** `sales_order`, `sales_order_line`, `order_line_serial`, `wave`, `wave_order`, `wave_task`, `wave_task_part`
- **Packing y despacho:** `package`, `route`, `route_stop`, `route_folio`
- **Postventa:** `return_item`, `credit_note`, `sync_log`
- **Control:** `meta`, `counter`, `setting`

## Límites conocidos
- La app guarda el estado completo en cada cambio. Es adecuado para un centro con pocos operadores simultáneos; con mucho volumen conviene pasar a endpoints por operación.
- `API_KEY` es una protección básica. En producción, publique detrás de HTTPS y de un inicio de sesión (proxy inverso).
- La integración con el ERP y el timbraje de guías ante el SII siguen siendo simulados.
- Respaldo: copie `data/wms.db` (con el servidor detenido) o use `sqlite3 data/wms.db ".backup copia.db"`.
