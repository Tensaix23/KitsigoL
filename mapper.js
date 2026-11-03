'use strict';
/**
 * Traduce entre el estado de la aplicación (objeto S) y las tablas relacionales.
 * saveState(): reemplaza el contenido de las tablas dentro de UNA transacción.
 * loadState(): reconstruye el objeto S desde las tablas.
 */
const enc = (v, t) => {
  if (v === undefined || v === null) return null;
  if (t === 'b') return v ? 1 : 0;
  if (t === 'e') return v === '' ? null : v;
  if (t === 'n') return Number.isFinite(+v) ? +v : null;
  return v;
};
const dec = (v, t) => {
  if (t === 'b') return v == null ? undefined : !!v;
  if (t === 'e') return v == null ? '' : v;
  return v;                                     // null se conserva (ej. vencimiento vacío)
};
// spec: tabla + [columna, clave en la app, tipo]  (t=texto, n=número, b=booleano, e=texto vacío→NULL)
const SPEC = {
  product:  { t: 'product', c: [['sku','sku','t'],['name','name','t'],['weight_kg','w','n'],['volume_l','vol','n'],['monthly_rotation','vel','n'],['cost','cost','n'],['price','price','n'],['serialized','ser','b'],['perishable','per','b']] },
  supplier: { t: 'supplier', c: [['id','id','t'],['name','name','t'],['rut','rut','t'],['contact','contact','t'],['phone','phone','t'],['email','email','t']] },
  carrier:  { t: 'carrier', c: [['id','id','t'],['name','name','t'],['rut','rut','t'],['contact','contact','t'],['phone','phone','t']] },
  vehicle:  { t: 'vehicle', c: [['id','id','t'],['name','name','t'],['plate','plate','t'],['carrier_id','carrier','e'],['driver','driver','t'],['driver_phone','drvPhone','t'],['capacity_kg','kg','n'],['capacity_packages','bultos','n'],['active','active','b']] },
  location: { t: 'location', c: [['id','id','t'],['zone','z','t'],['aisle','a','n'],['bay','b','n'],['level','l','n'],['capacity_l','vol','n'],['capacity_kg','kg','n']] },
  stock:    { t: 'stock_lot', c: [['id','id','t'],['sku','sku','t'],['lot','lot','t'],['expiry','exp','t'],['qty','qty','n'],['reserved','res','n'],['location_id','loc','t'],['status','status','t']] },
  movs:     { t: 'movement', c: [['ts','ts','t'],['type','type','t'],['sku','sku','t'],['lot','lot','t'],['qty','qty','n'],['location','loc','t'],['ref','ref','t']] },
  packs:    { t: 'package', c: [['id','id','t'],['order_id','order','t'],['seq','i','n'],['total','n','n'],['sscc','sscc','t'],['kg','kg','n'],['box','box','t'],['created_at','created','t'],['weight_diff','diff','n']] },
  returns:  { t: 'return_item', c: [['id','id','t'],['order_id','order','t'],['sku','sku','t'],['qty','qty','n'],['serial','serial','e'],['reason','motivo','t'],['condition','cond','t'],['warranty','gar','b'],['lot','lot','e'],['expiry','exp','e'],['suggested_dest','suggest','t'],['rationale','reason','t'],['dest','dest','t'],['status','status','t'],['location','loc','e'],['rma','rma','t'],['credit_folio','credit','t'],['created_at','created','t']] },
  notes:    { t: 'credit_note', c: [['folio','folio','t'],['seq','seq','n'],['type','type','t'],['return_id','ret','t'],['order_id','order','t'],['customer_name','cust','t'],['sku','sku','t'],['qty','qty','n'],['net','neto','n'],['vat','iva','n'],['total','total','n'],['status','status','t'],['erp_ref','erp','e'],['tries','tries','n'],['error','err','e'],['new_order','newOrder','t'],['created_at','created','t']] },
  syncLog:  { t: 'sync_log', c: [['ts','ts','t'],['msg','msg','t'],['level','lvl','e']] }
};
const TABLES_DELETE_ORDER = ['wave_task_part','wave_task','wave_order','wave','route_folio','route_stop','route','package','order_line_serial','sales_order_line','sales_order','inbound_line','inbound','return_item','credit_note','stock_serial','stock_lot','movement','sync_log','vehicle','carrier','customer','supplier','location','product','counter','setting'];

function dump(db, spec, rows) {
  const cols = spec.c.map(c => c[0]);
  const ins = db.prepare(`INSERT INTO ${spec.t} (${cols.join(',')},pos) VALUES (${cols.map(() => '?').join(',')},?)`);
  (rows || []).forEach((r, i) => ins.run(...spec.c.map(([, k, t]) => enc(r[k], t)), i));
}
function read(db, spec) {
  return db.prepare(`SELECT * FROM ${spec.t} ORDER BY pos`).all().map(row => {
    const o = {};
    for (const [col, key, t] of spec.c) { const v = dec(row[col], t); if (v !== undefined) o[key] = v; }
    return o;
  });
}

function saveState(db, S) {
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    for (const t of TABLES_DELETE_ORDER) db.prepare(`DELETE FROM ${t}`).run();

    dump(db, SPEC.product, S.skus);
    dump(db, SPEC.supplier, S.provs);
    dump(db, SPEC.carrier, S.carriers);
    dump(db, SPEC.vehicle, S.vehicles);
    dump(db, SPEC.location, S.locs);

    // clientes: objeto { clave: {...} }
    const insC = db.prepare('INSERT INTO customer (id,name,rut,address,comuna,x_km,y_km,pos) VALUES (?,?,?,?,?,?,?,?)');
    Object.entries(S.cust || {}).forEach(([k, c], i) => insC.run(k, c.n, enc(c.rut, 't'), c.dir, c.com, enc(c.x, 'n'), enc(c.y, 'n'), i));

    // stock + series
    dump(db, SPEC.stock, S.stock);
    const insS = db.prepare('INSERT INTO stock_serial (serial,stock_id,pos) VALUES (?,?,?)');
    (S.stock || []).forEach(r => (r.serials || []).forEach((s, i) => insS.run(s, r.id, i)));

    dump(db, SPEC.movs, S.movs);

    // órdenes de compra / ASN
    const insI = db.prepare('INSERT INTO inbound (id,po_number,supplier_id,supplier_name,eta,status,pos) VALUES (?,?,?,?,?,?,?)');
    const insIL = db.prepare('INSERT INTO inbound_line (inbound_id,line_no,sku,expected,received) VALUES (?,?,?,?,?)');
    (S.asn || []).forEach((a, i) => {
      const p = (S.provs || []).find(x => x.name === a.prov);
      insI.run(a.id, enc(a.oc, 'e'), p ? p.id : null, a.prov, a.eta, a.status, i);
      a.lines.forEach((l, j) => insIL.run(a.id, j, l.sku, enc(l.exp, 'n'), enc(l.rec, 'n')));
    });

    // pedidos
    const insO = db.prepare('INSERT INTO sales_order (id,customer_id,priority,status,created_at,route_id,wave_id,replacement_note,pos) VALUES (?,?,?,?,?,?,?,?,?)');
    const insOL = db.prepare('INSERT INTO sales_order_line (order_id,line_no,sku,qty) VALUES (?,?,?,?)');
    const insOS = db.prepare('INSERT INTO order_line_serial (order_id,line_no,pos,serial) VALUES (?,?,?,?)');
    (S.orders || []).forEach((o, i) => {
      insO.run(o.id, o.cust, o.prio, o.status, o.created, enc(o.route, 't'), enc(o.wave, 't'), enc(o.rep, 't'), i);
      o.lines.forEach((l, j) => { insOL.run(o.id, j, l.sku, l.qty); (l.serials || []).forEach((s, k) => insOS.run(o.id, j, k, s)); });
    });

    // olas de picking
    const insW = db.prepare('INSERT INTO wave (id,type,status,created_at,line_count,pos) VALUES (?,?,?,?,?,?)');
    const insWO = db.prepare('INSERT INTO wave_order (wave_id,order_id,pos) VALUES (?,?,?)');
    const insWT = db.prepare('INSERT INTO wave_task (wave_id,task_no,task_ref,stock_id,location_id,zone,sku,lot,expiry,done) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const insWP = db.prepare('INSERT INTO wave_task_part (wave_id,task_no,pos,order_id,qty) VALUES (?,?,?,?,?)');
    (S.waves || []).forEach((w, i) => {
      insW.run(w.id, w.type, w.status, w.created, enc(w.lines, 'n'), i);
      w.orders.forEach((o, j) => insWO.run(w.id, o, j));
      w.tasks.forEach((t, j) => {
        insWT.run(w.id, j, t.id, t.stockId, t.loc, t.zone, t.sku, t.lot, enc(t.exp, 't'), t.done ? 1 : 0);
        t.parts.forEach((p, k) => insWP.run(w.id, j, k, p.order, p.qty));
      });
    });

    dump(db, SPEC.packs, S.packs);

    // rutas
    const insR = db.prepare('INSERT INTO route (id,vehicle_id,status,created_at,departed_at,pos) VALUES (?,?,?,?,?,?)');
    const insRS = db.prepare('INSERT INTO route_stop (route_id,stop_no,order_id) VALUES (?,?,?)');
    const insRF = db.prepare('INSERT INTO route_folio (route_id,order_id,folio) VALUES (?,?,?)');
    (S.routes || []).forEach((r, i) => {
      insR.run(r.id, r.veh, r.status, r.created, enc(r.departed, 't'), i);
      r.orders.forEach((o, j) => insRS.run(r.id, j, o));
      Object.entries(r.folios || {}).forEach(([o, f]) => insRF.run(r.id, o, f));
    });

    dump(db, SPEC.returns, S.returns);
    dump(db, SPEC.notes, S.notes);
    dump(db, SPEC.syncLog, S.syncLog);

    const insK = db.prepare('INSERT INTO counter (name,value) VALUES (?,?)');
    Object.entries(S.seq || {}).forEach(([k, v]) => insK.run(k, v));
    const insT = db.prepare('INSERT INTO setting (key,value) VALUES (?,?)');
    Object.entries(S.set || {}).forEach(([k, v]) => insT.run(k, JSON.stringify(v)));
  })();
}

function loadState(db) {
  const S = {};
  S.skus = read(db, SPEC.product);
  S.locs = read(db, SPEC.location);
  S.cust = {};
  db.prepare('SELECT * FROM customer ORDER BY pos').all().forEach(r => {
    S.cust[r.id] = { n: r.name, rut: r.rut, dir: r.address, com: r.comuna, x: r.x_km, y: r.y_km };
  });
  S.provs = read(db, SPEC.supplier);
  S.carriers = read(db, SPEC.carrier);
  S.vehicles = read(db, SPEC.vehicle);

  S.stock = read(db, SPEC.stock);
  const ser = {};
  db.prepare('SELECT * FROM stock_serial ORDER BY stock_id,pos').all().forEach(r => (ser[r.stock_id] ||= []).push(r.serial));
  S.stock.forEach(r => { r.serials = ser[r.id] || []; });
  S.movs = read(db, SPEC.movs);

  const il = {};
  db.prepare('SELECT * FROM inbound_line ORDER BY inbound_id,line_no').all().forEach(r => {
    const l = { sku: r.sku, exp: r.expected }; if (r.received != null) l.rec = r.received;
    (il[r.inbound_id] ||= []).push(l);
  });
  S.asn = db.prepare('SELECT * FROM inbound ORDER BY pos').all().map(r => ({ id: r.id, prov: r.supplier_name, oc: r.po_number || '', eta: r.eta, status: r.status, lines: il[r.id] || [] }));

  const ol = {}, os = {};
  db.prepare('SELECT * FROM order_line_serial ORDER BY order_id,line_no,pos').all().forEach(r => (os[r.order_id + '|' + r.line_no] ||= []).push(r.serial));
  db.prepare('SELECT * FROM sales_order_line ORDER BY order_id,line_no').all().forEach(r => (ol[r.order_id] ||= []).push({ sku: r.sku, qty: r.qty, serials: os[r.order_id + '|' + r.line_no] || [] }));
  S.orders = db.prepare('SELECT * FROM sales_order ORDER BY pos').all().map(r => {
    const o = { id: r.id, cust: r.customer_id, prio: r.priority, lines: ol[r.id] || [], status: r.status, created: r.created_at, route: r.route_id, wave: r.wave_id };
    if (r.replacement_note) o.rep = r.replacement_note; return o;
  });

  const wo = {}, wt = {}, wp = {};
  db.prepare('SELECT * FROM wave_order ORDER BY wave_id,pos').all().forEach(r => (wo[r.wave_id] ||= []).push(r.order_id));
  db.prepare('SELECT * FROM wave_task_part ORDER BY wave_id,task_no,pos').all().forEach(r => (wp[r.wave_id + '|' + r.task_no] ||= []).push({ order: r.order_id, qty: r.qty }));
  db.prepare('SELECT * FROM wave_task ORDER BY wave_id,task_no').all().forEach(r => (wt[r.wave_id] ||= []).push({ id: r.task_ref, stockId: r.stock_id, loc: r.location_id, zone: r.zone, sku: r.sku, lot: r.lot, exp: r.expiry, parts: wp[r.wave_id + '|' + r.task_no] || [], done: !!r.done }));
  S.waves = db.prepare('SELECT * FROM wave ORDER BY pos').all().map(r => ({ id: r.id, type: r.type, orders: wo[r.id] || [], tasks: wt[r.id] || [], status: r.status, created: r.created_at, lines: r.line_count }));

  S.packs = read(db, SPEC.packs);

  const rs = {}, rf = {};
  db.prepare('SELECT * FROM route_stop ORDER BY route_id,stop_no').all().forEach(r => (rs[r.route_id] ||= []).push(r.order_id));
  db.prepare('SELECT * FROM route_folio').all().forEach(r => (rf[r.route_id] ||= {})[r.order_id] = r.folio);
  S.routes = db.prepare('SELECT * FROM route ORDER BY pos').all().map(r => {
    const o = { id: r.id, veh: r.vehicle_id, orders: rs[r.id] || [], status: r.status, created: r.created_at, folios: rf[r.id] || {} };
    if (r.departed_at) o.departed = r.departed_at; return o;
  });

  S.returns = read(db, SPEC.returns);
  S.notes = read(db, SPEC.notes);
  S.syncLog = read(db, SPEC.syncLog);

  S.set = {};
  db.prepare('SELECT * FROM setting').all().forEach(r => { S.set[r.key] = JSON.parse(r.value); });
  S.seq = {};
  db.prepare('SELECT * FROM counter').all().forEach(r => { S.seq[r.name] = r.value; });
  return S;
}

module.exports = { saveState, loadState };
