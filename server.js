'use strict';
/**
 * Servidor del WMS: API REST + archivos de la aplicación + base de datos SQLite.
 *   GET  /api/health          estado del servicio
 *   GET  /api/version         versión actual de los datos (para detectar cambios de otros usuarios)
 *   GET  /api/state           datos completos para la aplicación
 *   PUT  /api/state           guarda los datos (control de versión optimista)
 *   GET  /api/tables          tablas y vistas disponibles (solo lectura, para integraciones)
 *   GET  /api/tables/:nombre  filas de una tabla o vista  (?limit=200&offset=0)
 * Variables de entorno: PORT (3000) · DB_PATH (data/wms.db) · API_KEY (opcional)
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { saveState, loadState } = require('./mapper');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'wms.db');
const API_KEY = process.env.API_KEY || '';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const getVersion = () => Number(db.prepare("SELECT value FROM meta WHERE key='version'").pluck().get() || 0);
const setVersion = v => db.prepare("INSERT INTO meta(key,value) VALUES('version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(v));
const isEmpty = () => db.prepare('SELECT COUNT(*) FROM product').pluck().get() === 0 && db.prepare('SELECT COUNT(*) FROM counter').pluck().get() === 0;

const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, version: getVersion(), db: path.basename(DB_PATH) }));

// Clave opcional: si API_KEY está definida, el resto de la API la exige en el encabezado x-api-key.
app.use('/api', (req, res, next) => {
  if (!API_KEY || req.get('x-api-key') === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.get('/api/version', (req, res) => res.json({ version: getVersion() }));

app.get('/api/state', (req, res) => {
  try {
    if (isEmpty()) return res.json({ version: getVersion(), empty: true, state: null });
    res.json({ version: getVersion(), empty: false, state: loadState(db) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.put('/api/state', (req, res) => {
  const { baseVersion, state } = req.body || {};
  if (!state || typeof state !== 'object' || !state.skus || !state.seq) return res.status(400).json({ error: 'estado inválido' });
  const current = getVersion();
  if (Number(baseVersion) !== current) return res.status(409).json({ error: 'conflict', version: current });
  try {
    db.transaction(() => { saveState(db, state); setVersion(current + 1); })();
    res.json({ version: current + 1 });
  } catch (e) {
    console.error('Error al guardar:', e.message);
    res.status(422).json({ error: 'No se pudo guardar: ' + e.message });
  }
});

const listable = () => db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
app.get('/api/tables', (req, res) => res.json(listable()));
app.get('/api/tables/:name', (req, res) => {
  const t = listable().find(x => x.name === req.params.name);
  if (!t) return res.status(404).json({ error: 'tabla no encontrada' });
  const limit = Math.min(1000, Math.max(1, +req.query.limit || 200)), offset = Math.max(0, +req.query.offset || 0);
  res.json({ table: t.name, rows: db.prepare(`SELECT * FROM "${t.name}" LIMIT ? OFFSET ?`).all(limit, offset) });
});

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => console.log(`WMS en http://localhost:${PORT}  ·  base de datos: ${DB_PATH}${API_KEY ? '  ·  API protegida con clave' : ''}`));
process.on('SIGINT', () => { server.close(); db.close(); process.exit(0); });
module.exports = { app, db };
