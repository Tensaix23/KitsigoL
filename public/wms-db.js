/**
 * Conector entre la aplicación WMS y la base de datos (API del servidor).
 *
 * Configuración opcional, antes de cargar este archivo:
 *   window.WMS_CONFIG = { baseUrl: '/api', apiKey: '', debounceMs: 700, pollMs: 15000 };
 *
 * API pública (window.WMSDB):
 *   await WMSDB.pull()        -> estado guardado, o null si la base está vacía. Lanza error si no hay conexión.
 *   WMSDB.push(state)         -> guarda el estado (agrupa cambios rápidos en un solo envío)
 *   WMSDB.baseline(state)     -> marca el estado actual como ya guardado (evita reenviar datos sin cambios)
 *   WMSDB.onStatus(fn)        -> fn(estado) con: 'synced' | 'saving' | 'offline' | 'conflict' | 'stale'
 *   WMSDB.status              -> estado actual
 *   WMSDB.version             -> versión local de los datos
 */
(function () {
  var cfg = Object.assign({ baseUrl: '/api', apiKey: '', debounceMs: 700, pollMs: 15000 }, window.WMS_CONFIG || {});
  try { if (!cfg.apiKey) cfg.apiKey = localStorage.getItem('wms-api-key') || ''; } catch (e) {}
  var listeners = [], lastJson = null, timer = null, pending = null, busy = false, poll = null;
  var api = { version: 0, status: 'offline' };

  function set(s) { if (api.status !== s) { api.status = s; listeners.forEach(function (f) { try { f(s); } catch (e) {} }); } }
  function headers(json) {
    var h = {}; if (json) h['Content-Type'] = 'application/json';
    if (cfg.apiKey) h['x-api-key'] = cfg.apiKey; return h;
  }
  function req(path, opt) {
    opt = opt || {}; opt.headers = Object.assign(headers(!!opt.body), opt.headers || {});
    return fetch(cfg.baseUrl + path, opt);
  }

  api.onStatus = function (fn) { listeners.push(fn); };

  api.pull = function () {
    return req('/state').then(function (r) {
      if (r.status === 401) { var k = prompt && prompt('Clave de acceso a la base de datos'); if (k) { cfg.apiKey = k; try { localStorage.setItem('wms-api-key', k); } catch (e) {} return api.pull(); } }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j) throw new Error('sin respuesta');
      api.version = j.version; set('synced'); startPolling();
      return j.empty ? null : j.state;
    }).catch(function (e) { set('offline'); throw e; });
  };

  api.baseline = function (state) { lastJson = JSON.stringify(state); };

  api.push = function (state) {
    var json = JSON.stringify(state);         // instantánea inmediata: los cambios posteriores generan otro envío
    if (json === lastJson && pending == null) return;   // sin cambios: no se envía
    pending = json;
    clearTimeout(timer); timer = setTimeout(flush, cfg.debounceMs);
    if (api.status !== 'conflict') set('saving');
  };

  function flush() {
    if (busy) { timer = setTimeout(flush, 300); return; }
    if (pending == null || api.status === 'conflict') return;
    var body = pending; pending = null; busy = true;
    req('/state', { method: 'PUT', body: '{"baseVersion":' + api.version + ',"state":' + body + '}' })
      .then(function (r) {
        return r.json().then(function (j) {
          if (r.status === 409) { api.remoteVersion = j.version; set('conflict'); return; }
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          api.version = j.version; lastJson = body; set(pending == null ? 'synced' : 'saving');
        });
      })
      .catch(function (e) { console.warn('WMSDB:', e.message); pending = pending || body; set('offline'); setTimeout(flush, 5000); })
      .then(function () { busy = false; });
  }

  // Detecta cambios hechos por otros usuarios sin pisar lo que se está editando.
  function startPolling() {
    if (poll || !cfg.pollMs) return;
    poll = setInterval(function () {
      if (busy || pending != null || api.status === 'conflict') return;
      req('/version').then(function (r) { return r.json(); }).then(function (j) {
        if (j.version > api.version) { api.remoteVersion = j.version; set('stale'); }
        else if (api.status === 'offline' || api.status === 'stale') { if (j.version === api.version) set('synced'); }
      }).catch(function () { set('offline'); });
    }, cfg.pollMs);
  }

  window.WMSDB = api;
})();
