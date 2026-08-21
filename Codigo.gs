/**
 * ═══════════════════════════════════════════════════════════════
 *  PLATAFORMA TANGO ↔ FRÁVEGA — Backend (Google Apps Script)
 *  Grupo Bitek
 *
 *  Base de datos: la Google Sheet a la que está vinculado este script.
 *  Frontend: index.html en GitHub Pages (llama a este script vía doPost).
 *
 *  PUESTA EN MARCHA (una sola vez):
 *    1. Completar INITIAL_CREDENTIALS acá abajo.
 *    2. Ejecutar la función SETUP (botón ▶) y autorizar permisos.
 *    3. Implementar → Nueva implementación → App web
 *       (Ejecutar como: YO · Acceso: Cualquier persona) → copiar URL /exec.
 *    4. Pegar esa URL en el index.html (constante API_URL).
 *  Ver INSTRUCCIONES.md para el paso a paso completo.
 * ═══════════════════════════════════════════════════════════════
 */

// ── Credenciales iniciales (SETUP las guarda en Script Properties y
//    después podés borrarlas de acá si querés) ─────────────────────
var INITIAL_CREDENTIALS = {
  TANGO_ACCESS_TOKEN: 'f156249c-936d-4fa7-b3a7-1b181615677d_16488',
  FRAVEGA_SELLER_ID: 'fravegasellerprod1380',
  FRAVEGA_API_KEY: '6a442816637d9cf422c6c608',
  FRAVEGA_API_TOKEN: 'df500e4446e6e82c0ee94f5ff84ab84dae167085a3c596cffd79892d9507fc71d64f39d4',
  GOOGLE_CLIENT_ID: '849214701404-ff11l3oo5k9hecabvf99cnbbgjlegeam.apps.googleusercontent.com',
  // OnCity corre sobre VTEX (cuenta kenta993). Mismas credenciales que usa la
  // app de preparación de pedidos del depósito.
  VTEX_ACCOUNT: 'kenta993',
  VTEX_APP_KEY: 'vtexappkey-kenta993-ZVANCF',
  VTEX_APP_TOKEN: 'PPUAHFRMQHAHDCSTDANVNXOPAMMOQBZXXVCGOQGPDQBDYQFRIVRXRSOQRINKZZFHBVWZTINNOCZSNLTZJTNUDJJOFPWBZUKABGRTRRSHSLRFFGFZOKKXMQYSJTZUBPEC'
};

var ALLOWED_DOMAINS = ['bitek.com.ar'];
var ALLOWED_EMAILS = ['juanma.alonso3@gmail.com', 'bitekmeli@gmail.com'];
var SESSION_HOURS = 12;

// ── Endpoints externos ─────────────────────────────────────────────
var TANGO_BASE = 'https://tiendas.axoft.com/api/Aperture';
var FRAVEGA_BASE = 'https://seller-center-api.fravega.com';
var VTEX_ENV = 'vtexcommercestable';   // ambiente estable de VTEX (OnCity)

// ── Nombres de pestañas de la Sheet ────────────────────────────────
var SH = {
  CONFIG: 'Config',
  SKUS: 'RelacionesSKU',
  PENDING: 'Pendientes',
  LOGS: 'Logs',
  SYNCS: 'HistorialSync',
  ORDERS: 'HistorialOrdenes',
  INVOICES: 'HistorialFacturas',
  SENT: 'OrdenesEnviadas'
};

/**
 * Columnas de OrdenesEnviadas. Antes eran solo [order_id, fecha_hora]; ahora
 * guarda TODO lo que se le mandó a Tango, así la exportación de facturas ya no
 * necesita que vuelvas a subir el CSV de órdenes: cruza el reporte de Tango
 * contra este historial. La columna 1 sigue siendo order_id, que es lo que lee
 * _sentIds() para no reenviar un pedido dos veces.
 */
var COLS_SENT = ['order_id', 'suborder_id', 'fecha_hora', 'fecha_compra',
                 'cliente', 'documento', 'cuil', 'email', 'total', 'items',
                 'origen', 'estado_facturacion', 'nro_factura', 'fecha_factura',
                 'facturada_en'];

var DEFAULT_CONFIG = [
  ['stock_warehouse_code', '04', 'Depósito de Tango para el stock'],
  ['stock_subtract_engaged', '1', 'Restar comprometido (EngagedQuantity)'],
  ['stock_discount_pending', '1', 'Descontar pedidos pendientes (API Tango)'],
  ['stock_pause_ms', '300', 'Pausa entre llamadas a Frávega (ms)'],
  ['stock_destino_fravega', '1', 'Sincronizar stock hacia Frávega'],
  ['stock_destino_oncity', '1', 'Sincronizar stock hacia OnCity (VTEX)'],
  ['oncity_warehouse_id', '', 'Depósito de VTEX donde se escribe el stock (elegilo en Configuración)'],
  ['oncity_dry_run', '1', 'OnCity en modo simulación: calcula pero NO escribe en VTEX'],
  ['oncity_pause_ms', '250', 'Pausa entre llamadas a VTEX (ms)'],
  ['scheduler_enabled', '1', 'Sincronización automática habilitada'],
  ['scheduler_hours', '7,19', 'Horas del día para sincronizar (0-23, separadas por coma)'],
  ['orders_counterfoil', '46', 'Talonario de pedido'],
  ['orders_invoice_counterfoil', '43', 'Talonario de factura'],
  ['orders_warehouse_code', '04', 'Depósito (pedidos) — de aquí se descuenta el stock al facturar'],
  ['orders_seller_code', '01', 'Vendedor'],
  ['orders_sale_condition', '3', 'Condición de venta (3 = FRÁVEGA MARKETPLACE)'],
  ['orders_iva_category', 'CF', 'Categoría de IVA'],
  ['orders_document_type', '96', 'Tipo de documento'],
  ['orders_payment_method', 'A01', 'Forma de cobro'],
  ['orders_batch_size', '25', 'Órdenes por lote'],
  ['orders_estado_objetivo', 'Pendiente', 'Estado de facturación a importar'],
  // ── Ingreso de órdenes por API de Frávega ───────────────────────────────
  ['orders_api_espera_min', '90', 'Minutos que tiene que tener la orden antes de enviarla (Envío Pack necesita 90)'],
  ['orders_api_dias_atras', '30', 'Ventana de búsqueda hacia atrás (días)'],
  ['orders_api_page_size', '100', 'Órdenes por página de la API (máx. 100)'],
  ['orders_api_pause_ms', '400', 'Pausa entre llamadas de detalle a Frávega (ms)'],
  ['orders_api_max_detalle', '120', 'Máximo de detalles por ejecución (límite de 6 min de Apps Script)'],
  ['orders_api_id_field', 'auto', 'Qué ID usar como Nro de Orden: auto | suborderId | orderId'],
  ['orders_api_detalle_modo', '', 'Forma del endpoint de detalle que funcionó (se detecta solo)'],
  ['orders_api_facturar_envio', '0', 'Sumar el costo de envío al total (0 si usás Frávega Envíos)'],
  ['orders_api_tipo_entrega', '', 'Filtrar por tipo de entrega: vacío = todos · SP = sucursal · HD = domicilio'],
  ['invoices_origen', 'historial', 'De dónde salen las órdenes a facturar: historial | csv'],
  ['invoices_add_prefix', '1', 'Agregar prefijo al Nro de orden'],
  ['invoices_prefix', 'FVG-', 'Prefijo'],
  ['invoices_estado_objetivo', 'Pendiente', 'Estado a matchear en facturas'],
  ['invoices_template_id', '', 'ID de la Sheet plantilla de facturas (lo completa SETUP)']
];

var SEED_RELATIONS = [
  ['22160', '22712991'], ['18502', '22718907'], ['19501', '22718918'],
  ['21406', '22712922'], ['19502', '22718915'], ['19504', '22718912'],
  ['21405', '22712923'], ['18501', '22718908'], ['23106', '22718921'],
  ['18503', '22718905'], ['30006', '22712989'], ['65002', '22718877'],
  ['55840', '22718934'], ['72156', '22718958'], ['21605', '22712584'],
  ['20608', '22712583'], ['10305', '22712955'], ['22506', '22712990'],
  ['46050', '22716013'], ['47820', '22716014']
];

/* ═══════════════ SETUP (ejecutar una vez) ═══════════════ */

function SETUP() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('America/Argentina/Buenos_Aires');

  // Pestañas + encabezados
  _ensureSheet(ss, SH.CONFIG, ['clave', 'valor', 'descripcion']);
  _ensureSheet(ss, SH.SKUS, ['sku_tango', 'fravega_item_id', 'fravega_refid',
                             'descripcion', 'creada', 'modificada',
                             'oncity_refid', 'oncity_sku_id']);
  _ensureSheet(ss, SH.PENDING, ['sku', 'origen', 'estado', 'observaciones',
                                'detectado_en', 'resuelto_en']);
  _ensureSheet(ss, SH.LOGS, ['fecha_hora', 'usuario', 'modulo', 'accion',
                             'resultado', 'detalle', 'duracion_ms']);
  _ensureSheet(ss, SH.SYNCS, ['inicio', 'fin', 'disparada_por', 'resultado',
                              'ok', 'errores', 'no_publicados', 'sin_relacion',
                              'detalle_json', 'destino']);
  _ensureSheet(ss, SH.ORDERS, ['fecha_hora', 'usuario', 'archivo', 'total_filas',
                               'pendientes', 'nuevas', 'enviadas', 'rechazadas', 'detalle_json']);
  _ensureSheet(ss, SH.INVOICES, ['fecha_hora', 'usuario', 'archivo', 'cargadas',
                                 'sin_factura', 'sobrantes', 'detalle_json']);
  _ensureSheet(ss, SH.SENT, COLS_SENT);

  // Config por defecto (solo claves faltantes)
  var cfgSheet = ss.getSheetByName(SH.CONFIG);
  var existing = _colValues(cfgSheet, 1);
  DEFAULT_CONFIG.forEach(function (row) {
    if (existing.indexOf(row[0]) === -1) cfgSheet.appendRow(row);
  });

  // Seed de relaciones si está vacía
  var skuSheet = ss.getSheetByName(SH.SKUS);
  if (skuSheet.getLastRow() < 2) {
    var ts = _now();
    SEED_RELATIONS.forEach(function (r) {
      // refId de Frávega y de OnCity = el mismo código de Tango
      skuSheet.appendRow([r[0], r[1], r[0], '', ts, ts, r[0], '']);
    });
  }

  // (El .xlsx de facturas se genera 100% por código con su estructura completa;
  //  ya no hace falta una plantilla en Drive.)

  // Credenciales → Script Properties
  var props = PropertiesService.getScriptProperties();
  Object.keys(INITIAL_CREDENTIALS).forEach(function (k) {
    if (INITIAL_CREDENTIALS[k]) props.setProperty(k, INITIAL_CREDENTIALS[k]);
  });
  if (!props.getProperty('SECRET_KEY')) {
    props.setProperty('SECRET_KEY', Utilities.getUuid() + Utilities.getUuid());
  }

  MIGRAR_ONCITY();
  MIGRAR_ORDENES_API();
  configurarTriggers();
  log_('sistema', 'sistema', 'SETUP ejecutado', 'ok', '');
  return 'SETUP completo. Ahora: Implementar → Nueva implementación → App web.';
}

/** Crea/actualiza los triggers según scheduler_hours. Ejecutar tras cambiar horarios. */
function configurarTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncProgramada') ScriptApp.deleteTrigger(t);
  });
  var horas = String(getConfig('scheduler_hours') || '7,19').split(',');
  horas.forEach(function (h) {
    h = parseInt(h.trim(), 10);
    if (!isNaN(h) && h >= 0 && h <= 23) {
      ScriptApp.newTrigger('syncProgramada').timeBased().everyDays(1).atHour(h).create();
    }
  });
}

function syncProgramada() {
  if (getConfig('scheduler_enabled') !== '1') return;
  runStockSync('scheduler');
}

/**
 * EJECUTAR UNA VEZ desde el editor (botón ▶) después de pegar esta versión.
 *
 * Fuerza en la hoja Config los dos valores pedidos, aunque las claves ya
 * existan con otro valor:
 *   - Condición de venta = 3  (FRÁVEGA MARKETPLACE)
 *   - Depósito de pedidos = 04 (de este depósito se descuenta el stock al facturar)
 *
 * Por qué hace falta: la app lee lo que hay en la hoja Config, NO lo que dice
 * DEFAULT_CONFIG del código. Cambiar el código solo afecta a una instalación
 * nueva; para una que ya está andando hay que escribir el valor en la hoja,
 * que es justo lo que hace esta función. No requiere re-implementar la App web.
 */
function ACTUALIZAR_CONDICION_Y_DEPOSITO() {
  setConfig('orders_sale_condition', '3');
  setConfig('orders_warehouse_code', '04');
  log_('sistema', 'configuracion',
       'Aplicado: condición de venta=3 (FRÁVEGA MARKETPLACE), depósito pedidos=04',
       'ok', '');
  return 'Listo: condición de venta = 3 (FRÁVEGA MARKETPLACE), depósito pedidos = 04.';
}

/* ═══════════════ API HTTP (doPost) ═══════════════ */

function doGet() {
  return _json({ ok: true, servicio: 'Plataforma Tango-Fravega', hora: _now() });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return _json({ error: 'JSON inválido' }); }

  var action = req.action || '';
  try {
    // Login: única acción sin token de sesión
    if (action === 'login') return _json(login(req.credential));

    var user = _checkSession(req.token); // lanza si es inválido
    var p = req.payload || {};
    var out;
    switch (action) {
      case 'dashboard':          out = apiDashboard(); break;
      case 'stock.sync':         out = apiStockSync(user, p.destino); break;
      case 'stock.status':       out = apiStockStatus(); break;
      case 'stock.history':      out = _readRows(SH.SYNCS, 50).reverse(); break;
      case 'orders.analyze':     out = apiOrdersAnalyze(user, p.rows, p.archivo); break;
      case 'orders.send':        out = apiOrdersSend(user, p.rows, p.archivo); break;
      case 'orders.sendBatch':   out = apiOrdersSendBatch(user, p.orders, p.archivo); break;
      case 'orders.recordImport':out = apiOrdersRecordImport(user, p); break;
      case 'orders.history':     out = _readRows(SH.ORDERS, 50).reverse(); break;
      // ── Ingreso de órdenes por API de Frávega ──
      case 'orders.apiPreview':  out = apiOrdersApiPreview(user, p); break;
      case 'orders.apiSend':     out = apiOrdersApiSend(user, p); break;
      case 'orders.apiTest':     out = apiOrdersApiTest(); break;
      case 'invoices.generate':  out = apiInvoicesGenerate(user, p.ordenes, p.facturas); break;
      case 'invoices.pendientes':out = apiInvoicesPendientes(); break;
      case 'invoices.fromHistory': out = apiInvoicesFromHistory(user, p.facturas); break;
      case 'invoices.history':   out = _readRows(SH.INVOICES, 50).reverse(); break;
      case 'skus.list':          out = apiSkusList(p.q || ''); break;
      case 'skus.save':          out = apiSkusSave(user, p); break;
      case 'skus.delete':        out = apiSkusDelete(user, p.sku_tango); break;
      case 'skus.import':        out = apiSkusImport(user, p.rows); break;
      case 'pending.list':       out = _pendingList(); break;
      case 'pending.resolve':    out = apiPendingResolve(user, p.sku, p.origen); break;
      case 'logs.list':          out = apiLogsList(p); break;
      case 'settings.get':       out = apiSettingsGet(); break;
      case 'settings.set':       out = apiSettingsSet(user, p.valores); break;
      case 'oncity.warehouses':  out = vtexWarehouses(); break;
      case 'oncity.test':        out = apiOncityTest(); break;
      default: throw new Error('Acción desconocida: ' + action);
    }
    return _json({ ok: true, data: out });
  } catch (err) {
    var msg = String(err && err.message ? err.message : err);
    if (msg.indexOf('AUTH:') === 0) return _json({ error: msg.slice(5), auth: true });
    log_('sistema', 'sistema', 'Error en acción ' + action, 'error', msg);
    return _json({ error: msg });
  }
}

/* ═══════════════ AUTH ═══════════════ */

function login(credential) {
  if (!credential) throw new Error('Falta el credential de Google');
  var r = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential),
    { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Token de Google inválido');
  var info = JSON.parse(r.getContentText());
  var clientId = _prop('GOOGLE_CLIENT_ID');
  if (clientId && info.aud !== clientId) throw new Error('El token no corresponde a esta aplicación');
  if (String(info.email_verified) !== 'true') throw new Error('Email no verificado');
  var email = String(info.email || '').toLowerCase();
  if (!_emailAllowed(email)) {
    log_(email, 'auth', 'Login rechazado', 'warning', '');
    throw new Error('Acceso denegado para ' + email);
  }
  log_(email, 'auth', 'Login', 'ok', '');
  return { token: _makeSession(email, info.name || email),
           email: email, name: info.name || email, picture: info.picture || '' };
}

function _emailAllowed(email) {
  if (ALLOWED_EMAILS.indexOf(email) !== -1) return true;
  var dom = email.split('@')[1] || '';
  return ALLOWED_DOMAINS.indexOf(dom) !== -1;
}

function _makeSession(email, name) {
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify(
    { email: email, name: name, exp: Date.now() + SESSION_HOURS * 3600 * 1000 }));
  return payload + '.' + _hmac(payload);
}

function _checkSession(token) {
  if (!token || token.indexOf('.') === -1) throw new Error('AUTH:Falta la sesión');
  var parts = token.split('.');
  if (_hmac(parts[0]) !== parts[1]) throw new Error('AUTH:Sesión inválida');
  var payload = JSON.parse(Utilities.newBlob(
    Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  if (payload.exp < Date.now()) throw new Error('AUTH:Sesión expirada');
  if (!_emailAllowed(payload.email)) throw new Error('AUTH:Acceso revocado');
  return payload;
}

function _hmac(text) {
  var sig = Utilities.computeHmacSha256Signature(text, _prop('SECRET_KEY'));
  return sig.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* ═══════════════ CLIENTES TANGO / FRÁVEGA ═══════════════ */

function _tangoHeaders() {
  return { accesstoken: _prop('TANGO_ACCESS_TOKEN'), 'Content-Type': 'application/json' };
}

function tangoVerify() {
  try {
    var r = UrlFetchApp.fetch(TANGO_BASE + '/dummy',
      { method: 'post', headers: _tangoHeaders(), muteHttpExceptions: true });
    var data = JSON.parse(r.getContentText());
    return data.isOk ? [true, 'Token válido'] : [false, String(data.Message || 'Token inválido')];
  } catch (e) { return [false, 'Sin conexión con Tango: ' + e.message]; }
}

function tangoFetchStock(warehouse, discountPending) {
  var all = [], page = 1;
  while (true) {
    var url = TANGO_BASE + '/Stock?pageSize=500&pageNumber=' + page +
      (warehouse ? '&WarehouseCode=' + encodeURIComponent(warehouse) : '') +
      (discountPending ? '&discountPendingOrders=true' : '');
    var r = UrlFetchApp.fetch(url, { headers: _tangoHeaders(), muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) {
      throw new Error('Tango /Stock HTTP ' + r.getResponseCode() + ': ' +
                      r.getContentText().slice(0, 200));
    }
    var body = JSON.parse(r.getContentText());
    all = all.concat(body.Data || []);
    if (!body.Paging || !body.Paging.MoreData) break;
    page++;
  }
  return all;
}

function tangoSendBatch(orders) {
  var r = UrlFetchApp.fetch(TANGO_BASE + '/order/batch', {
    method: 'post', headers: _tangoHeaders(), contentType: 'application/json',
    payload: JSON.stringify({ OrderBatch: orders }), muteHttpExceptions: true
  });
  var raw = r.getContentText();
  if (r.getResponseCode() !== 200) {
    throw new Error('Tango /order/batch HTTP ' + r.getResponseCode() + ': ' + raw.slice(0, 300));
  }
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    throw new Error('Tango /order/batch devolvió una respuesta no-JSON: ' + raw.slice(0, 300));
  }
  // Si Tango marca un error a nivel de la respuesta completa, lo exponemos.
  if (parsed && parsed.isOk === false && !_respData(parsed).length) {
    throw new Error('Tango /order/batch rechazó el lote: ' +
                    String(parsed.Message || raw).slice(0, 300));
  }
  parsed.__raw = raw;               // crudo para diagnóstico
  return parsed;
}

function _fravegaHeaders() {
  return {
    'seller-id': _prop('FRAVEGA_SELLER_ID'),
    'x-fvg-api-key': _prop('FRAVEGA_API_KEY'),
    'x-fvg-api-token': _prop('FRAVEGA_API_TOKEN')
  };
}

function fravegaUpdateStock(refid, quantity) {
  var url = FRAVEGA_BASE + '/api/v1/item/stock?refId=' + encodeURIComponent(refid);
  for (var intento = 0; intento <= 2; intento++) {
    try {
      var r = UrlFetchApp.fetch(url, {
        method: 'put', headers: _fravegaHeaders(), contentType: 'application/json',
        payload: JSON.stringify({ quantity: Math.round(quantity) }),
        muteHttpExceptions: true
      });
      var code = r.getResponseCode();
      if (code === 200) return [true, '200'];
      if ([429, 500, 502, 503, 504].indexOf(code) !== -1 && intento < 2) {
        Utilities.sleep(2000 * (intento + 1)); continue;
      }
      return [false, 'HTTP ' + code + ': ' + r.getContentText().slice(0, 200)];
    } catch (e) {
      if (intento < 2) { Utilities.sleep(2000 * (intento + 1)); continue; }
      return [false, 'excepción: ' + e.message];
    }
  }
  return [false, 'agotados los reintentos'];
}

function fravegaPing() {
  try {
    var r = UrlFetchApp.fetch(FRAVEGA_BASE + '/api/v1/item/stock?refId=__ping__', {
      method: 'put', headers: _fravegaHeaders(), contentType: 'application/json',
      payload: '{"quantity":0}', muteHttpExceptions: true
    });
    var code = r.getResponseCode();
    if (code === 404) return [true, 'Conexión y credenciales OK'];
    if (code === 401 || code === 403) return [false, 'Credenciales rechazadas (HTTP ' + code + ')'];
    if (code === 200) return [true, 'Conexión OK'];
    return [false, 'HTTP ' + code];
  } catch (e) { return [false, 'Sin conexión con Frávega: ' + e.message]; }
}

/* ═══════════════ MÓDULO STOCK ═══════════════ */

function runStockSync(disparadaPor, soloDestino) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { resultado: 'omitida', mensaje: 'Ya hay una sincronización en curso' };
  var t0 = Date.now();
  var inicio = _now();
  var detalle = [], ok = 0, errores = 0, noPublicados = 0, sinRelacion = 0;
  try {
    log_(disparadaPor, 'stock', 'Inicio de sincronización', 'info', '');
    var vt = tangoVerify();
    if (!vt[0]) throw new Error('Token de Tango inválido: ' + vt[1]);

    var warehouse = getConfig('stock_warehouse_code');
    var records = tangoFetchStock(warehouse, getConfig('stock_discount_pending') === '1');

    // Disponible = Quantity - Engaged (si aplica), nunca negativo
    var restar = getConfig('stock_subtract_engaged') === '1';
    var stock = {};
    records.forEach(function (it) {
      var sku = String(it.SKUCode || '').trim();
      if (!sku) return;
      var q = Number(it.Quantity) || 0;
      if (restar) q -= Number(it.EngagedQuantity) || 0;
      stock[sku] = (stock[sku] || 0) + q;
    });
    Object.keys(stock).forEach(function (s) { if (stock[s] < 0) stock[s] = 0; });
    log_(disparadaPor, 'stock', 'Stock leído de Tango (depósito ' + warehouse + ')',
         'info', Object.keys(stock).length + ' artículos con saldo');

    var rels = _skuRelations();          // { sku_tango: {refid, oncity_refid, ...} }

    // SKUs de Tango sin relación → pendientes
    Object.keys(stock).forEach(function (sku) {
      if (!rels[sku]) {
        sinRelacion++;
        _pendingAdd(sku, 'Tango', 'Detectado en sincronización de stock sin relación');
      }
    });

    // ── Destinos a actualizar ──────────────────────────────────────────────
    var destinos = [];
    if (getConfig('stock_destino_fravega') === '1') destinos.push('fravega');
    if (getConfig('stock_destino_oncity') === '1') destinos.push('oncity');
    if (soloDestino) destinos = destinos.indexOf(soloDestino) !== -1 ? [soloDestino] : [soloDestino];
    if (!destinos.length) throw new Error('No hay ningún destino habilitado en Configuración');

    var pauseFra = parseInt(getConfig('stock_pause_ms') || '300', 10);
    var pauseOnc = parseInt(getConfig('oncity_pause_ms') || '250', 10);
    var porDestino = {};

    // ── Frávega ────────────────────────────────────────────────────────────
    if (destinos.indexOf('fravega') !== -1) {
      var fOk = 0, fErr = 0, fNoPub = 0;
      Object.keys(rels).forEach(function (sku) {
        var qty = Math.round(stock[sku] || 0);
        var refid = rels[sku].refid || sku;
        var res = fravegaUpdateStock(refid, qty);
        if (res[0]) {
          fOk++; ok++;
          detalle.push({ destino: 'fravega', sku: sku, refId: refid, cantidad: qty, estado: 'ok' });
        } else if (res[1].indexOf('ref_id_not_found') !== -1) {
          fNoPub++; noPublicados++;
          detalle.push({ destino: 'fravega', sku: sku, refId: refid, cantidad: qty, estado: 'no publicado' });
        } else {
          fErr++; errores++;
          detalle.push({ destino: 'fravega', sku: sku, refId: refid, cantidad: qty, estado: 'error', detalle: res[1] });
          log_(disparadaPor, 'stock', 'Frávega: error al actualizar ' + sku, 'error', res[1]);
        }
        Utilities.sleep(pauseFra);
      });
      porDestino.fravega = { ok: fOk, errores: fErr, no_publicados: fNoPub };
      log_(disparadaPor, 'stock', 'Frávega actualizada', fErr ? 'warning' : 'ok',
           'ok=' + fOk + ' errores=' + fErr + ' no_publicados=' + fNoPub);
    }

    // ── OnCity (VTEX) ──────────────────────────────────────────────────────
    if (destinos.indexOf('oncity') !== -1) {
      var warehouseId = getConfig('oncity_warehouse_id');
      if (!warehouseId) throw new Error('Falta configurar el depósito de VTEX para OnCity');
      var simular = getConfig('oncity_dry_run') === '1';

      var nuevos = _oncityResolverIds(rels);   // traduce refId → skuId lo que falte
      if (nuevos) log_(disparadaPor, 'stock', 'OnCity: ' + nuevos + ' SKU nuevos traducidos a id de VTEX', 'info', '');

      var oOk = 0, oErr = 0, oNoPub = 0;
      Object.keys(rels).forEach(function (sku) {
        var qty = Math.round(stock[sku] || 0);
        var rel = rels[sku];
        var refid = rel.oncity_refid || sku;

        if (!rel.oncity_sku_id) {              // el artículo no está publicado en OnCity
          oNoPub++; noPublicados++;
          detalle.push({ destino: 'oncity', sku: sku, refId: refid, cantidad: qty, estado: 'no publicado',
                         detalle: 'Sin SKU en VTEX con ese refId' });
          return;
        }
        if (simular) {
          oOk++; ok++;
          detalle.push({ destino: 'oncity', sku: sku, refId: refid, cantidad: qty, estado: 'ok',
                         detalle: 'simulación (no se escribió en VTEX)' });
          return;
        }
        var res = vtexUpdateStock(rel.oncity_sku_id, warehouseId, qty);
        if (res[0]) {
          oOk++; ok++;
          detalle.push({ destino: 'oncity', sku: sku, refId: refid, cantidad: qty, estado: 'ok' });
        } else {
          oErr++; errores++;
          detalle.push({ destino: 'oncity', sku: sku, refId: refid, cantidad: qty, estado: 'error', detalle: res[1] });
          log_(disparadaPor, 'stock', 'OnCity: error al actualizar ' + sku, 'error', res[1]);
        }
        Utilities.sleep(pauseOnc);
      });
      porDestino.oncity = { ok: oOk, errores: oErr, no_publicados: oNoPub, simulacion: simular };
      log_(disparadaPor, 'stock', 'OnCity actualizada' + (simular ? ' (SIMULACIÓN)' : ''),
           oErr ? 'warning' : 'ok',
           'ok=' + oOk + ' errores=' + oErr + ' no_publicados=' + oNoPub);
    }

    var resultado = errores === 0 ? 'ok' : 'con errores';
    _appendRow(SH.SYNCS, [inicio, _now(), disparadaPor, resultado, ok, errores,
                          noPublicados, sinRelacion, JSON.stringify(detalle),
                          destinos.join('+')]);
    log_(disparadaPor, 'stock', 'Sincronización finalizada',
         errores === 0 ? 'ok' : 'warning',
         'ok=' + ok + ' errores=' + errores + ' no_publicados=' + noPublicados +
         ' sin_relacion=' + sinRelacion, Date.now() - t0);
    return { resultado: resultado, ok: ok, errores: errores,
             no_publicados: noPublicados, sin_relacion: sinRelacion,
             destinos: destinos, por_destino: porDestino, detalle: detalle };
  } catch (e) {
    _appendRow(SH.SYNCS, [inicio, _now(), disparadaPor, 'falló', ok, errores,
                          noPublicados, sinRelacion, JSON.stringify(detalle),
                          soloDestino || 'todos']);
    log_(disparadaPor, 'stock', 'Sincronización abortada', 'error', e.message, Date.now() - t0);
    return { resultado: 'falló', error: e.message };
  } finally {
    lock.releaseLock();
  }
}

function apiStockSync(user, destino) { return runStockSync(user.email, destino || ''); }

function apiStockStatus() {
  var hist = _readRows(SH.SYNCS, 1);
  return {
    ultima: hist.length ? hist[hist.length - 1] : null,
    proxima: _proximaSync(),
    habilitada: getConfig('scheduler_enabled') === '1'
  };
}

function _proximaSync() {
  if (getConfig('scheduler_enabled') !== '1') return null;
  var horas = String(getConfig('scheduler_hours') || '7,19').split(',')
    .map(function (h) { return parseInt(h.trim(), 10); })
    .filter(function (h) { return !isNaN(h) && h >= 0 && h <= 23; })
    .sort(function (a, b) { return a - b; });
  if (!horas.length) return null;
  var tz = 'America/Argentina/Buenos_Aires';
  var ahora = new Date();
  var horaActual = parseInt(Utilities.formatDate(ahora, tz, 'H'), 10);
  for (var i = 0; i < horas.length; i++) {
    if (horas[i] > horaActual) {
      return Utilities.formatDate(ahora, tz, 'yyyy-MM-dd') + ' ' +
             ('0' + horas[i]).slice(-2) + ':00 (aprox.)';
    }
  }
  var maniana = new Date(ahora.getTime() + 24 * 3600 * 1000);
  return Utilities.formatDate(maniana, tz, 'yyyy-MM-dd') + ' ' +
         ('0' + horas[0]).slice(-2) + ':00 (aprox.)';
}

/* ═══════════════ MÓDULO ÓRDENES ═══════════════ */

var PROVINCE_MAP = {
  'CIUDAD AUTONOMA DE BUENOS AIRES': '0', 'CAPITAL FEDERAL': '0', 'CABA': '0',
  'BUENOS AIRES': '1', 'CATAMARCA': '2', 'CORDOBA': '3', 'CORRIENTES': '4',
  'ENTRE RIOS': '5', 'JUJUY': '6', 'MENDOZA': '7', 'LA RIOJA': '8',
  'SALTA': '9', 'SAN JUAN': '10', 'SAN LUIS': '11', 'SANTA FE': '12',
  'SANTIAGO DEL ESTERO': '13', 'TUCUMAN': '14', 'CHACO': '16', 'CHUBUT': '17',
  'FORMOSA': '18', 'MISIONES': '19', 'NEUQUEN': '20', 'LA PAMPA': '21',
  'RIO NEGRO': '22', 'SANTA CRUZ': '23', 'TIERRA DEL FUEGO': '24'
};

function _normalize(t) {
  return String(t || '').toUpperCase()
    .replace(/Á/g, 'A').replace(/É/g, 'E').replace(/Í/g, 'I')
    .replace(/Ó/g, 'O').replace(/Ú/g, 'U').replace(/Ñ/g, 'N').trim();
}

function _provinceCode(name) {
  var n = _normalize(name);
  if (PROVINCE_MAP[n]) return PROVINCE_MAP[n];
  for (var k in PROVINCE_MAP) if (n.indexOf(k) !== -1) return PROVINCE_MAP[k];
  return '1';
}

function _cleanName(full) {
  var raw = String(full || '').trim(), email = '';
  var m = raw.match(/\S+@\S+\.\S+/);
  if (m) { email = m[0]; raw = raw.replace(email, '').trim(); }
  raw = raw.replace(/\s+/g, ' ').trim();
  var i = raw.indexOf(' ');
  return i === -1 ? [raw, '', email] : [raw.slice(0, i), raw.slice(i + 1), email];
}

function _parseAddress(addr) {
  addr = String(addr || '').trim();
  var m = addr.match(/^(.+?)\s+(\d+\s*[A-Za-z]?)$/);
  if (m) return [m[1].trim().slice(0, 30), m[2].trim()];
  return [addr.slice(0, 30), ''];
}

function _s(v, def) {
  if (v === null || v === undefined) return def || '';
  var s = String(v).trim();
  return (s === '' || s.toLowerCase() === 'nan') ? (def || '') : s;
}

function _dni(v) {
  var s = _s(v);
  return s.indexOf('.') !== -1 ? s.split('.')[0] : s;
}

function _buildOrder(orderId, rows, rels, cfg) {
  var first = rows[0], items = [], unmapped = [];
  rows.forEach(function (row) {
    var skuF = String(parseInt(row['SKU'], 10));
    var found = null;
    for (var st in rels) if (rels[st].item_id === skuF) { found = st; break; }
    if (!found) { unmapped.push(skuF); return; }
    items.push({
      ProductCode: skuF, SKUCode: found,
      Description: _s(row['Descripción SKU']).slice(0, 400),
      Quantity: Number(row['Cantidad de SKU']) || 1,
      UnitPrice: Number(row['Valor del SKU']) || 0,
      DiscountPercentage: 0.0
    });
  });
  if (unmapped.length) return [null, unmapped];

  var total = 0;
  rows.forEach(function (r) {
    total += (Number(r['Valor del SKU']) || 0) * (Number(r['Cantidad de SKU']) || 1);
  });
  total = Math.round(total * 100) / 100;

  var nombre = _cleanName(_s(first['Cliente']));
  var dni = _dni(first['DNI']);
  var billAddr = _parseAddress(_s(first['Domicilio de Facturación']));
  var billCity = _s(first['Ciudad']).slice(0, 20);
  var billProv = _provinceCode(_s(first['Provincia']));
  var billPostal = _s(first['Código Postal']);
  var delAddrRaw = _s(first['Domicilio de entrega']);
  var delAddr = delAddrRaw ? _parseAddress(delAddrRaw) : billAddr;
  var delCity = _s(first['Ciudad.1']).slice(0, 20) || billCity;
  var delProvRaw = _s(first['Provincia.1']);
  var digits = String(orderId).replace(/\D/g, '');

  return [{
    OrderID: orderId, OrderNumber: orderId,
    OrderCounterfoil: parseInt(cfg.orders_counterfoil, 10),
    InvoiceCounterfoil: parseInt(cfg.orders_invoice_counterfoil, 10),
    Date: _s(first['Fecha de Compra']).replace(/\//g, '-') + 'T00:00:00',
    Total: total, PaidTotal: total, FinancialSurcharge: 0.0,
    WarehouseCode: cfg.orders_warehouse_code, SellerCode: cfg.orders_seller_code,
    SaleConditionCode: cfg.orders_sale_condition,
    ValidateTotalWithPaidTotal: false, ValidateTotalWithItems: false,
    Customer: {
      CustomerID: /^\d+$/.test(dni) ? parseInt(dni, 10) : 1,
      Code: '000000', DocumentType: cfg.orders_document_type, DocumentNumber: dni,
      IVACategoryCode: cfg.orders_iva_category, User: orderId,
      Email: nombre[2] || (orderId + '@fravega.com'),
      FirstName: nombre[0], LastName: nombre[1], BusinessName: '',
      Street: billAddr[0], HouseNumber: billAddr[1], Floor: '', Apartment: '',
      City: billCity, ProvinceCode: billProv, PostalCode: billPostal,
      PhoneNumber1: '', PhoneNumber2: ''
    },
    Shipping: {
      ShippingID: 1, Street: delAddr[0], HouseNumber: delAddr[1],
      Floor: '', Apartment: '', City: delCity,
      ProvinceCode: delProvRaw ? _provinceCode(delProvRaw) : billProv,
      PostalCode: _s(first['Código Postal.1'], billPostal),
      PhoneNumber1: '', PhoneNumber2: ''
    },
    OrderItems: items, Payments: [],
    CashPayments: [{ PaymentID: digits ? parseInt(digits, 10) : 1,
                     PaymentMethod: cfg.orders_payment_method, PaymentTotal: total }]
  }, []];
}

function _analyzeOrders(rows) {
  var cfg = _configMap();
  var estado = cfg.orders_estado_objetivo || 'Pendiente';
  var pend = rows.filter(function (r) {
    return _s(r['Estado de Facturación']) === estado;
  });
  var rels = _skuRelations();
  var sent = _sentIds();

  // Agrupar por Nro de Orden preservando el orden
  var groups = {}, orderIds = [];
  pend.forEach(function (r) {
    var oid = _s(r['Nro de Orden']);
    if (!groups[oid]) { groups[oid] = []; orderIds.push(oid); }
    groups[oid].push(r);
  });

  var orders = [], skipped = [], excluded = [];
  orderIds.forEach(function (oid) {
    if (sent[oid]) { skipped.push(oid); return; }
    var res = _buildOrder(oid, groups[oid], rels, cfg);
    if (res[1].length) {
      res[1].forEach(function (sku) {
        _pendingAdd(sku, 'Fravega', 'Detectado en orden ' + oid + ' sin relación');
      });
      excluded.push({ orden: oid, skus_sin_relacion: res[1] });
    } else {
      orders.push(res[0]);
    }
  });
  return { total_filas: rows.length, filas_pendientes: pend.length,
           orders: orders, saltadas: skipped, excluidas: excluded };
}

function apiOrdersAnalyze(user, rows, archivo) {
  if (!rows || !rows.length) throw new Error('El CSV llegó vacío');
  var a = _analyzeOrders(rows);
  log_(user.email, 'ordenes', 'CSV analizado', 'info',
       'archivo=' + archivo + ' nuevas=' + a.orders.length +
       ' saltadas=' + a.saltadas.length + ' excluidas=' + a.excluidas.length);
  return {
    total_filas: a.total_filas, filas_pendientes: a.filas_pendientes,
    nuevas: a.orders.map(function (o) {
      return { orden: o.OrderID,
               cliente: (o.Customer.FirstName + ' ' + o.Customer.LastName).trim(),
               items: o.OrderItems.length, total: o.Total };
    }),
    orders: a.orders,   // órdenes completas (payload de Tango) para envío por tandas
    saltadas: a.saltadas, excluidas: a.excluidas
  };
}

function apiOrdersSend(user, rows, archivo) {
  var vt = tangoVerify();
  if (!vt[0]) throw new Error('Token de Tango inválido: ' + vt[1]);
  var a = _analyzeOrders(rows);   // re-análisis sobre los mismos datos
  if (!a.orders.length) throw new Error('No hay órdenes nuevas para enviar');
  return _sendOrders(a.orders, user, archivo,
                     { total_filas: a.total_filas, filas_pendientes: a.filas_pendientes,
                       excluidas: a.excluidas, saltadas: a.saltadas });
}

/**
 * Envío por TANDAS: el frontend arma las órdenes una vez y las manda de a
 * grupos chicos, para no pasar el límite de 6 min de Apps Script.
 * Recibe órdenes YA construidas (payload de Tango). Saltea las que ya están
 * en OrdenesEnviadas. Devuelve {enviadas, rechazadas}.
 * OJO: acá NO se escribe HistorialOrdenes (meta = null). La fila de resumen
 * del import la escribe apiOrdersRecordImport, que el frontend llama UNA vez
 * al terminar todas las tandas.
 */
function apiOrdersSendBatch(user, orders, archivo) {
  if (!orders || !orders.length) return { enviadas: [], rechazadas: [] };
  var vt = tangoVerify();
  if (!vt[0]) throw new Error('Token de Tango inválido: ' + vt[1]);
  // Filtrar las que ya se enviaron (idempotencia entre tandas / reintentos)
  var sent = _sentIds();
  var pendientes = orders.filter(function (o) { return !sent[o.OrderID]; });
  if (!pendientes.length) {
    // No las tragamos en silencio: avisamos que ya estaban registradas como enviadas.
    return { enviadas: [], rechazadas: orders.map(function (o) {
      return { orden: o.OrderID, error: 'Ya figuraba en OrdenesEnviadas; no se reenvió' };
    }) };
  }
  return _sendOrders(pendientes, user, archivo, null);
}

/**
 * Registra UNA fila de resumen del import en HistorialOrdenes.
 * Lo llama el frontend al terminar todas las tandas del envío por lotes,
 * porque apiOrdersSendBatch (con meta=null) no escribe el historial.
 */
function apiOrdersRecordImport(user, p) {
  p = p || {};
  var enviadas = p.enviadas || [];
  var rechazadas = p.rechazadas || [];
  var nuevas = (p.nuevas !== undefined && p.nuevas !== null && p.nuevas !== '')
    ? p.nuevas : (enviadas.length + rechazadas.length);
  _appendRow(SH.ORDERS, [_now(), user.email, p.archivo || 'Ordenes.csv',
                         (p.total_filas != null ? p.total_filas : ''),
                         (p.filas_pendientes != null ? p.filas_pendientes : ''),
                         nuevas, enviadas.length, rechazadas.length,
                         JSON.stringify({ enviadas: enviadas, rechazadas: rechazadas,
                                          excluidas: p.excluidas || [], saltadas: p.saltadas || [] })]);
  log_(user.email, 'ordenes', 'Importación registrada', 'ok',
       'archivo=' + (p.archivo || '') + ' enviadas=' + enviadas.length +
       ' rechazadas=' + rechazadas.length);
  return { ok: true };
}

/* ── Lectura tolerante de la respuesta de Tango ──────────────────────
 * Tango puede devolver las claves con distinto casing/nombre según endpoint
 * o versión. Estos helpers evitan que una diferencia de nombre haga que el
 * envío cuente "0 aceptadas / 0 rechazadas" en silencio. */
function _pick(obj, keys) {
  if (!obj) return undefined;
  for (var i = 0; i < keys.length; i++) {
    if (obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
  }
  return undefined;
}
function _respData(resp) {
  var d = _pick(resp, ['Data', 'data', 'Result', 'Results', 'results', 'Orders', 'orders', 'OrderBatch']);
  if (d === undefined || d === null) return [];
  return Array.isArray(d) ? d : [d];
}
function _itIds(it) {
  var v = _pick(it, ['OrderID', 'OrderId', 'orderId', 'orderID', 'OrderNumber', 'OrderNo',
                     'orderNumber', 'Id', 'ID', 'id']);
  return String(v === undefined ? '' : v).split(',')
    .map(function (x) { return x.trim(); }).filter(String);
}
function _itInprocess(it) {
  var v = _pick(it, ['Inprocess', 'InProcess', 'inProcess', 'inprocess',
                     'IsOk', 'isOk', 'Success', 'success', 'Ok', 'ok']);
  return v === true || String(v).toLowerCase() === 'true';
}
function _itError(it) {
  return _pick(it, ['ValidationException', 'validationException',
                    'Message', 'message', 'Error', 'error']);
}

/**
 * Núcleo de envío a Tango, con reintento -Rn y registro.
 * `registros` (opcional) es { OrderID: {cliente, documento, total, …} } y es lo
 * que hace que OrdenesEnviadas guarde todo lo que se mandó, para que después la
 * exportación de facturas cruce contra ese historial y no contra un CSV.
 */
function _sendOrders(orders, user, archivo, meta, registros) {
  var t0 = Date.now();
  registros = registros || {};
  var batchSize = parseInt(getConfig('orders_batch_size') || '25', 10);
  var cfgPago = getConfig('orders_payment_method') || 'A01';
  var results = [];

  function sendBatches(list) {
    for (var i = 0; i < list.length; i += batchSize) {
      var batch = list.slice(i, i + batchSize);
      var loteNro = (i / batchSize) + 1;
      try {
        var resp = tangoSendBatch(batch);
        // Guardamos la respuesta cruda en los logs para poder diagnosticar.
        log_(user.email, 'ordenes', 'Respuesta Tango /order/batch', 'info',
             'lote=' + loteNro + ' n=' + batch.length + ' resp=' +
             String(resp.__raw || '').slice(0, 1500));
        results.push({ status: 'ok', response: resp, lote: loteNro });
      } catch (e) {
        results.push({ status: 'error', error: e.message, lote: loteNro });
      }
    }
  }
  sendBatches(orders);

  // Reintento -Rn de rechazadas por estado ANULADA/CERRADA
  var accepted = _sentIds();
  results.forEach(function (r) {
    if (r.status !== 'ok') return;
    _respData(r.response).forEach(function (it) {
      if (_itInprocess(it)) _itIds(it).forEach(function (x) { accepted[x] = true; });
    });
  });
  var byId = {};
  orders.forEach(function (o) { byId[o.OrderID] = o; });
  var retries = [];
  results.slice().forEach(function (r) {
    if (r.status !== 'ok') return;
    _respData(r.response).forEach(function (it) {
      if (_itInprocess(it)) return;
      var err = String(_itError(it) || '');
      if (err.indexOf('Order state must be') === -1) return;
      var oid = _itIds(it)[0];
      var orig = oid ? byId[oid] : null;
      if (!orig) return;
      var n = 1;
      while (accepted[oid + '-R' + n]) n++;
      var nid = oid + '-R' + n;
      accepted[nid] = true;
      var copy = JSON.parse(JSON.stringify(orig));
      copy.OrderID = nid; copy.OrderNumber = nid;
      var dg = nid.replace(/\D/g, '');
      copy.CashPayments = [{ PaymentID: dg ? parseInt(dg, 10) : 1,
                             PaymentMethod: cfgPago, PaymentTotal: orig.Total }];
      // El reintento hereda los datos del pedido original, así la fila que
      // queda en OrdenesEnviadas sirve igual para matchear la factura.
      if (registros[oid]) {
        registros[nid] = JSON.parse(JSON.stringify(registros[oid]));
        registros[nid].order_id = nid;
      }
      retries.push(copy);
    });
  });
  if (retries.length) {
    log_(user.email, 'ordenes', 'Reintentando ' + retries.length + ' orden(es) con sufijo -Rn', 'warning', '');
    sendBatches(retries);
  }

  // Consolidar aceptadas / rechazadas
  var sentIds = [], failed = [];
  results.forEach(function (r) {
    if (r.status !== 'ok') {
      failed.push({ orden: 'lote ' + (r.lote || '?'), error: r.error }); return;
    }
    _respData(r.response).forEach(function (it) {
      var ids = _itIds(it);
      if (!ids.length) return;
      if (_itInprocess(it)) sentIds = sentIds.concat(ids);
      else ids.forEach(function (id) {
        failed.push({ orden: id, error: String(_itError(it) || 'rechazada') });
      });
    });
  });

  // Red de seguridad: si Tango respondió 200 pero no reconocimos NI aceptadas
  // NI rechazadas, NO lo ocultamos: exponemos la respuesta cruda para diagnóstico.
  if (!sentIds.length && !failed.length && orders.length) {
    results.forEach(function (r) {
      if (r.status !== 'ok') { failed.push({ orden: 'lote ' + (r.lote || '?'), error: r.error }); return; }
      failed.push({ orden: 'lote ' + (r.lote || '?') + ' (respuesta no reconocida)',
                    error: 'Tango respondió 200 sin órdenes identificables. Crudo: ' +
                           String(r.response.__raw || '').slice(0, 400) });
    });
    log_(user.email, 'ordenes', 'Envío sin resultados reconocibles', 'warning',
         'orders=' + orders.length + ' — revisar el crudo de la respuesta de Tango en los logs');
  }

  var ts = _now();
  sentIds.forEach(function (id) { _appendRow(SH.SENT, _filaSent(id, registros[id], ts)); });
  if (meta) {
    _appendRow(SH.ORDERS, [ts, user.email, archivo || 'Ordenes.csv', meta.total_filas,
                           meta.filas_pendientes, orders.length, sentIds.length, failed.length,
                           JSON.stringify({ enviadas: sentIds, rechazadas: failed,
                                            excluidas: meta.excluidas, saltadas: meta.saltadas })]);
  }
  log_(user.email, 'ordenes', 'Envío de órdenes (tanda)',
       failed.length ? 'warning' : 'ok',
       'enviadas=' + sentIds.length + ' rechazadas=' + failed.length, Date.now() - t0);
  return { enviadas: sentIds, rechazadas: failed };
}

/* ═══════════════ MÓDULO ÓRDENES POR API DE FRÁVEGA ═══════════════
 * Reemplaza el paso manual de bajar el CSV del seller center y subirlo.
 *
 * Cómo funciona:
 *   1. GET /api/v1/orders?status=pending  → listado paginado de las órdenes
 *      cobradas y todavía sin facturar (equivale al "Estado de Facturación =
 *      Pendiente" del CSV).
 *   2. Para cada orden nueva, GET /api/v1/orders/{id} → el detalle, que es lo
 *      único que trae los domicilios de facturación y de entrega.
 *   3. Se arma el mismo payload de Tango que armaba _buildOrder desde el CSV
 *      y se manda por el /order/batch de siempre.
 *
 * LA ESPERA DE ENVÍO PACK: el manual de Frávega pide que las órdenes tengan al
 * menos 90 minutos antes de tocarlas, porque Envío Pack necesita ese tiempo
 * para generar el envío en su plataforma. Se respeta de dos formas: se pide a
 * la API con purchasedateto = ahora − espera, y además se vuelve a verificar
 * orden por orden acá abajo. Una orden que todavía no cumplió el tiempo no se
 * saltea ni se pierde: queda listada como "esperando" y entra sola en la
 * próxima corrida. El tiempo se configura en orders_api_espera_min.
 * ══════════════════════════════════════════════════════════════════════════ */

var TZ_AR = 'America/Argentina/Buenos_Aires';

/** Fecha → string ISO 8601 en UTC, que es el formato que pide la API. */
function _isoUtc(d) {
  return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
}

/** Parsea una fecha de la API a milisegundos. Devuelve 0 si no se entiende. */
function _fechaMs(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  var s = String(v).trim();
  var d = new Date(s);
  if (!isNaN(d.getTime())) return d.getTime();
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);   // dd/mm/yyyy
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
  return 0;
}

/** Fecha de la API → el formato que espera Tango (yyyy-MM-ddTHH:mm:ss). */
function _fechaTango(v) {
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00';
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) + 'T00:00:00';
  var ms = _fechaMs(s);
  if (ms) return Utilities.formatDate(new Date(ms), TZ_AR, "yyyy-MM-dd'T'00:00:00");
  return Utilities.formatDate(new Date(), TZ_AR, "yyyy-MM-dd'T'00:00:00");
}

/** GET con reintentos contra la API de Frávega. Devuelve {ok, code, data|error}. */
function _fravegaGetJson(path) {
  var headers = _fravegaHeaders();
  headers['accept'] = 'application/json';
  for (var intento = 0; intento <= 2; intento++) {
    try {
      var r = UrlFetchApp.fetch(FRAVEGA_BASE + path,
        { method: 'get', headers: headers, muteHttpExceptions: true });
      var code = r.getResponseCode();
      var body = r.getContentText();
      if (code === 200) {
        try { return { ok: true, code: code, data: JSON.parse(body) }; }
        catch (e) { return { ok: false, code: code, error: 'respuesta no-JSON: ' + body.slice(0, 200) }; }
      }
      if ([429, 500, 502, 503, 504].indexOf(code) !== -1 && intento < 2) {
        Utilities.sleep(1500 * (intento + 1)); continue;
      }
      return { ok: false, code: code, error: 'HTTP ' + code + ': ' + body.slice(0, 250) };
    } catch (e) {
      if (intento < 2) { Utilities.sleep(1500 * (intento + 1)); continue; }
      return { ok: false, code: 'excepción', error: e.message };
    }
  }
  return { ok: false, code: 0, error: 'agotados los reintentos' };
}

/** El array de órdenes puede venir como Items, items, data… lo buscamos. */
function _apiItems(obj) {
  if (!obj) return [];
  var claves = ['Items', 'items', 'Data', 'data', 'Result', 'results', 'orders', 'Orders'];
  for (var i = 0; i < claves.length; i++) {
    if (Array.isArray(obj[claves[i]])) return obj[claves[i]];
  }
  return Array.isArray(obj) ? obj : [];
}

/** Los productos también cambian de nombre según el endpoint. */
function _apiProductos(detalle, item) {
  var fuentes = [detalle, item];
  var claves = ['products', 'Products', 'producto', 'Producto', 'items', 'Items'];
  for (var f = 0; f < fuentes.length; f++) {
    if (!fuentes[f]) continue;
    for (var i = 0; i < claves.length; i++) {
      var v = fuentes[f][claves[i]];
      if (Array.isArray(v) && v.length) return v;
      if (v && typeof v === 'object' && v.sellerSku !== undefined) return [v];
    }
  }
  return [];
}

/** Una página del listado de órdenes pendientes de facturación. */
function fravegaFetchOrdersPage(pagina, cfg) {
  var pageSize = parseInt(cfg.orders_api_page_size || '100', 10) || 100;
  if (pageSize > 100) pageSize = 100;
  if (pageSize < 1) pageSize = 100;

  var esperaMin = parseInt(cfg.orders_api_espera_min || '90', 10);
  if (isNaN(esperaMin) || esperaMin < 0) esperaMin = 0;
  var diasAtras = parseInt(cfg.orders_api_dias_atras || '30', 10) || 30;

  var hasta = new Date(Date.now() - esperaMin * 60 * 1000);
  var desde = new Date(hasta.getTime() - diasAtras * 86400000);

  var qs = '?page=' + pagina + '&page-size=' + pageSize + '&status=pending' +
           '&purchasedatefrom=' + encodeURIComponent(_isoUtc(desde)) +
           '&purchasedateto=' + encodeURIComponent(_isoUtc(hasta));
  if (cfg.orders_api_tipo_entrega) {
    qs += '&deliverytype=' + encodeURIComponent(cfg.orders_api_tipo_entrega);
  }

  var res = _fravegaGetJson('/api/v1/orders' + qs);
  if (!res.ok) {
    if (String(res.code) === '401' || String(res.code) === '403') {
      throw new Error('Frávega rechazó las credenciales para órdenes (HTTP ' + res.code +
        '). El token de Seller Center necesita permiso de "operador OMS y Operador ' +
        'Facturante": hay que pedírselo a seller support. El mismo token sigue ' +
        'funcionando para stock, así que no es un problema de configuración.');
    }
    throw new Error('Frávega /orders: ' + res.error);
  }
  return res.data || {};
}

/* El manual es ambiguo sobre el detalle: el path dice {id} = orden y el query
 * dice orderid = suborden. Probamos las combinaciones hasta que una responda y
 * guardamos cuál fue, para no reintentar en cada llamada. */
var DETALLE_MODOS = [
  { id: 'a', arma: function (o, s) { return '/api/v1/orders/' + encodeURIComponent(o) + '?orderid=' + encodeURIComponent(s); } },
  { id: 'b', arma: function (o, s) { return '/api/v1/orders/' + encodeURIComponent(s) + '?orderid=' + encodeURIComponent(o); } },
  { id: 'c', arma: function (o, s) { return '/api/v1/orders/' + encodeURIComponent(s); } },
  { id: 'd', arma: function (o, s) { return '/api/v1/orders/' + encodeURIComponent(o); } }
];

function fravegaOrderDetail(orderId, suborderId, cfg) {
  var guardado = String(cfg.orders_api_detalle_modo || '').trim();
  var orden = [];
  DETALLE_MODOS.forEach(function (m) { if (m.id === guardado) orden.push(m); });
  DETALLE_MODOS.forEach(function (m) { if (m.id !== guardado) orden.push(m); });

  var ultimo = '';
  for (var i = 0; i < orden.length; i++) {
    var res = _fravegaGetJson(orden[i].arma(orderId, suborderId));
    if (res.ok && res.data) {
      if (orden[i].id !== guardado) {
        setConfig('orders_api_detalle_modo', orden[i].id);
        cfg.orders_api_detalle_modo = orden[i].id;
      }
      return res.data;
    }
    ultimo = res.error;
    // Sin permisos no tiene sentido seguir probando formas de la URL.
    if (String(res.code) === '401' || String(res.code) === '403') break;
  }
  throw new Error('No se pudo leer el detalle (orden ' + orderId + ' / suborden ' +
                  suborderId + '): ' + ultimo);
}

/**
 * Decide cuál de los dos IDs es el "Nro de Orden" con el que ya venís
 * trabajando. Es lo que evita que al prender la API se re-envíen a Tango
 * pedidos que ya cargaste por CSV: se fija cuál de los dos aparece en
 * OrdenesEnviadas y usa ese.
 */
function _elegirCampoId(items, cfg) {
  var pref = String(cfg.orders_api_id_field || 'auto').trim();
  if (pref === 'orderId' || pref === 'suborderId') return pref;

  var sent = _sentIds();
  var hitsOrder = 0, hitsSub = 0;
  items.forEach(function (it) {
    if (it.orderId !== undefined && sent[String(it.orderId)]) hitsOrder++;
    if (it.suborderId !== undefined && sent[String(it.suborderId)]) hitsSub++;
  });
  if (hitsSub > hitsOrder) return 'suborderId';
  if (hitsOrder > hitsSub) return 'orderId';
  // Empate (típico: ninguna de estas órdenes se envió todavía). El manual dice
  // que la suborden es "el id trazable para la orden del seller", que es el que
  // ves en el seller center y en el CSV.
  return 'suborderId';
}

/**
 * sellerSku → código de Tango. El manual se contradice sobre qué es sellerSku
 * (nuestro código o el id de publicación de Frávega), así que probamos las dos
 * lecturas y funciona en cualquiera de los dos casos.
 */
function _resolverSkuApi(sellerSku, rels, indiceItem) {
  var s = String(sellerSku === null || sellerSku === undefined ? '' : sellerSku).trim();
  if (!s) return '';
  if (rels[s]) return s;                      // sellerSku = código de Tango
  if (indiceItem[s]) return indiceItem[s];    // sellerSku = item id de Frávega
  var n = parseInt(s, 10);                    // por si viene con ceros a la izquierda
  if (!isNaN(n)) {
    var sn = String(n);
    if (rels[sn]) return sn;
    if (indiceItem[sn]) return indiceItem[sn];
  }
  return '';
}

/** Primer valor no vacío de la lista. */
function _primero() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v !== null && v !== undefined && String(v).trim() !== '' &&
        String(v).toLowerCase() !== 'null') return String(v).trim();
  }
  return '';
}

/** Arma el domicilio de Tango a partir del objeto de dirección de Frávega. */
function _domicilioApi(dir) {
  dir = dir || {};
  return {
    street: _primero(dir.street, dir.Street).slice(0, 30),
    number: _primero(dir.number, dir.Number),
    floor: _primero(dir.floor, dir.Floor),
    apartment: _primero(dir.apartment, dir.Apartment, dir.department),
    city: _primero(dir.city, dir.City).slice(0, 20),
    state: _primero(dir.state, dir.State, dir.province),
    zip: _primero(dir.zipCode, dir.ZipCode, dir.postalCode)
  };
}

/**
 * Construye el payload de Tango desde la API.
 * Devuelve [orden, skusSinRelacion, registro] — registro es lo que se guarda
 * en OrdenesEnviadas para después cruzar contra el reporte de facturación.
 */
function _buildOrderFromApi(idOrden, item, detalle, rels, indiceItem, cfg) {
  var prods = _apiProductos(detalle, item);
  if (!prods.length) return [null, ['(la orden no trae productos)'], null];

  var items = [], unmapped = [], totalItems = 0, resumen = [];
  prods.forEach(function (p) {
    var sellerSku = _primero(p.sellerSku, p.SellerSku, p.sku, p.Sku);
    var tangoSku = _resolverSkuApi(sellerSku, rels, indiceItem);
    if (!tangoSku) { unmapped.push(String(sellerSku)); return; }

    var cant = Number(p.quantity) || 1;
    var sub = Number(p.subtotal);
    if (!isFinite(sub) || sub <= 0) {
      sub = (Number(p.basePrice) || 0) * cant - (Number(p.discounts) || 0);
    }
    var unit = cant ? Math.round((sub / cant) * 100) / 100 : sub;
    totalItems += sub;
    resumen.push(tangoSku + ' x' + cant);

    items.push({
      ProductCode: String(sellerSku),
      SKUCode: tangoSku,
      Description: String(_primero(p.name, p.Name, rels[tangoSku].descripcion)).slice(0, 400),
      Quantity: cant,
      UnitPrice: unit,
      DiscountPercentage: 0.0
    });
  });
  if (unmapped.length) return [null, unmapped, null];

  detalle = detalle || {};
  var buyer = detalle.buyer || {};
  var bi = detalle.billingInfo || {};
  var bp = bi.billingPerson || {};
  var sd = detalle.shippingData || {};

  var fact = _domicilioApi(bi.billingAddress || sd.shippingAddress);
  var entrega = _domicilioApi(sd.shippingAddress || bi.billingAddress);

  // Nombre: la API ya lo trae partido, que es mejor que adivinarlo del CSV.
  var nombre = _primero(buyer.firstName, buyer.FirstName);
  var apellido = _primero(buyer.lastName, buyer.LastName);
  if (!nombre && !apellido) {
    var completo = _cleanName(_primero(bp.name, item && item.clientName, detalle.clientName));
    nombre = completo[0]; apellido = completo[1];
  }
  var nombreCompleto = (nombre + ' ' + apellido).trim();

  var doc = _dni(_primero(bp.document, buyer.documentNumber, item && item.documentNumber));
  var cuil = _primero(buyer.cuil, buyer.Cuil);
  var email = _primero(bp.email, buyer.email);

  // Total a facturar. Con Frávega Envíos se factura solo la mercadería: el
  // manual dice que "subtotal" es el valor que tiene que usar el seller.
  var total = Math.round(totalItems * 100) / 100;
  if (cfg.orders_api_facturar_envio === '1') {
    total += Number(detalle.deliveriesTotal) || 0;
    total = Math.round(total * 100) / 100;
  }

  // Si Frávega dice otro total de productos, lo avisamos en la vista previa en
  // vez de mandarlo distinto en silencio.
  var totalFravega = Number(detalle.productsTotal);
  var aviso = '';
  if (isFinite(totalFravega) && totalFravega > 0 &&
      Math.abs(totalFravega - Math.round(totalItems * 100) / 100) > 1) {
    aviso = 'Frávega informa productsTotal=' + totalFravega +
            ' y la suma de los ítems da ' + (Math.round(totalItems * 100) / 100);
  }

  var digits = String(idOrden).replace(/\D/g, '');
  var fechaCompra = _primero(detalle.purchaseDate, item && item.purchaseDate, item && item.createdOn);

  var orden = {
    OrderID: idOrden, OrderNumber: idOrden,
    OrderCounterfoil: parseInt(cfg.orders_counterfoil, 10),
    InvoiceCounterfoil: parseInt(cfg.orders_invoice_counterfoil, 10),
    Date: _fechaTango(fechaCompra),
    Total: total, PaidTotal: total, FinancialSurcharge: 0.0,
    WarehouseCode: cfg.orders_warehouse_code, SellerCode: cfg.orders_seller_code,
    SaleConditionCode: cfg.orders_sale_condition,
    ValidateTotalWithPaidTotal: false, ValidateTotalWithItems: false,
    Customer: {
      CustomerID: /^\d+$/.test(doc) ? parseInt(doc, 10) : 1,
      Code: '000000',
      DocumentType: cfg.orders_document_type,
      DocumentNumber: doc,
      IVACategoryCode: cfg.orders_iva_category,
      User: idOrden,
      Email: email || (idOrden + '@fravega.com'),
      FirstName: nombre, LastName: apellido, BusinessName: '',
      Street: fact.street, HouseNumber: fact.number,
      Floor: fact.floor, Apartment: fact.apartment,
      City: fact.city, ProvinceCode: _provinceCode(fact.state), PostalCode: fact.zip,
      PhoneNumber1: '', PhoneNumber2: ''
    },
    Shipping: {
      ShippingID: 1,
      Street: entrega.street, HouseNumber: entrega.number,
      Floor: entrega.floor, Apartment: entrega.apartment,
      City: entrega.city, ProvinceCode: _provinceCode(entrega.state),
      PostalCode: entrega.zip || fact.zip,
      PhoneNumber1: '', PhoneNumber2: ''
    },
    OrderItems: items, Payments: [],
    CashPayments: [{ PaymentID: digits ? parseInt(digits, 10) : 1,
                     PaymentMethod: cfg.orders_payment_method, PaymentTotal: total }]
  };

  var registro = {
    order_id: idOrden,
    suborder_id: _primero(item && item.suborderId, detalle.suborderId),
    fecha_compra: fechaCompra ? Utilities.formatDate(new Date(_fechaMs(fechaCompra) || Date.now()),
                                                     TZ_AR, 'yyyy-MM-dd HH:mm:ss') : '',
    cliente: nombreCompleto,
    documento: doc,
    cuil: cuil,
    email: email,
    total: total,
    items: resumen.join(' · '),
    origen: 'api',
    aviso: aviso
  };

  return [orden, [], registro];
}

/**
 * Trae una página de órdenes de Frávega y las deja listas para mandar a Tango.
 * El frontend la llama una vez por página y va acumulando.
 */
function apiOrdersApiPreview(user, p) {
  p = p || {};
  var pagina = parseInt(p.pagina || 1, 10) || 1;
  var cfg = _configMap();
  var t0 = Date.now();

  var body = fravegaFetchOrdersPage(pagina, cfg);
  var items = _apiItems(body);
  var campoId = _elegirCampoId(items, cfg);

  var rels = _skuRelations();
  var indiceItem = {};
  Object.keys(rels).forEach(function (s) {
    if (rels[s].item_id) indiceItem[rels[s].item_id] = s;
  });
  var sent = _sentIds();

  var pausa = parseInt(cfg.orders_api_pause_ms || '400', 10);
  if (isNaN(pausa) || pausa < 0) pausa = 400;
  var maxDet = parseInt(cfg.orders_api_max_detalle || '120', 10) || 120;
  var esperaMin = parseInt(cfg.orders_api_espera_min || '90', 10);
  if (isNaN(esperaMin) || esperaMin < 0) esperaMin = 0;
  var corte = Date.now() - esperaMin * 60 * 1000;

  var orders = [], registros = {}, nuevas = [], saltadas = [],
      excluidas = [], esperando = [], fallidas = [];
  var detalles = 0, truncada = false;

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var oid = _primero(it.orderId, it.OrderId);
    var sid = _primero(it.suborderId, it.SuborderId);
    var idOrden = (campoId === 'orderId') ? (oid || sid) : (sid || oid);
    if (!idOrden) continue;

    if (sent[idOrden]) { saltadas.push(idOrden); continue; }

    // ── La espera de Envío Pack, verificada orden por orden ──
    // El filtro purchasedateto ya debería dejarlas afuera, pero lo volvemos a
    // chequear acá: si la API ignorara el filtro, una orden demasiado nueva
    // llegaría a Tango antes de que Envío Pack genere el envío.
    var fc = _fechaMs(_primero(it.purchaseDate, it.createdOn));
    if (esperaMin && fc && fc > corte) {
      esperando.push({ orden: idOrden,
                       compra: Utilities.formatDate(new Date(fc), TZ_AR, 'yyyy-MM-dd HH:mm'),
                       faltan_min: Math.ceil((fc - corte) / 60000) });
      continue;
    }

    if (detalles >= maxDet || (Date.now() - t0) > 4.5 * 60 * 1000) { truncada = true; break; }

    var detalle;
    try {
      detalle = fravegaOrderDetail(oid, sid, cfg);
      detalles++;
    } catch (e) {
      fallidas.push({ orden: idOrden, error: e.message });
      continue;
    }
    if (pausa) Utilities.sleep(pausa);

    var res = _buildOrderFromApi(idOrden, it, detalle, rels, indiceItem, cfg);
    if (res[1].length) {
      res[1].forEach(function (sku) {
        _pendingAdd(sku, 'Fravega', 'Detectado por API en la orden ' + idOrden + ' sin relación');
      });
      excluidas.push({ orden: idOrden, skus_sin_relacion: res[1] });
      continue;
    }

    orders.push(res[0]);
    registros[idOrden] = res[2];
    nuevas.push({
      orden: idOrden,
      suborden: res[2].suborder_id,
      cliente: res[2].cliente,
      documento: res[2].documento,
      fecha: res[2].fecha_compra,
      items: res[0].OrderItems.length,
      total: res[0].Total,
      entrega: _primero(it.deliveryType, it.DeliveryType),
      aviso: res[2].aviso
    });
  }

  log_(user.email, 'ordenes', 'Órdenes leídas de la API de Frávega', 'info',
       'pagina=' + pagina + '/' + (body.pages || 1) + ' total=' + (body.total || 0) +
       ' nuevas=' + nuevas.length + ' saltadas=' + saltadas.length +
       ' esperando=' + esperando.length + ' excluidas=' + excluidas.length +
       ' fallidas=' + fallidas.length + ' campo_id=' + campoId,
       Date.now() - t0);

  return {
    pagina: Number(body.currentPage || pagina),
    paginas: Number(body.pages || 1),
    total: Number(body.total || 0),
    en_pagina: items.length,
    campo_id: campoId,
    espera_min: esperaMin,
    orders: orders, registros: registros,
    nuevas: nuevas, saltadas: saltadas, excluidas: excluidas,
    esperando: esperando, fallidas: fallidas,
    truncada: truncada
  };
}

/** Manda a Tango las órdenes que armó apiOrdersApiPreview. */
function apiOrdersApiSend(user, p) {
  p = p || {};
  var orders = p.orders || [];
  var registros = p.registros || {};
  if (!orders.length) return { enviadas: [], rechazadas: [] };

  var vt = tangoVerify();
  if (!vt[0]) throw new Error('Token de Tango inválido: ' + vt[1]);

  var sent = _sentIds();
  var pendientes = orders.filter(function (o) { return !sent[o.OrderID]; });
  if (!pendientes.length) {
    return { enviadas: [], rechazadas: orders.map(function (o) {
      return { orden: o.OrderID, error: 'Ya figuraba en OrdenesEnviadas; no se reenvió' };
    }) };
  }
  return _sendOrders(pendientes, user, p.archivo || 'API Frávega', null, registros);
}

/**
 * Prueba de conexión que se puede correr desde la pantalla de Órdenes.
 * No manda nada a Tango: solo consulta y reporta qué encontró.
 */
function apiOrdersApiTest() {
  var cfg = _configMap();
  var out = { ok: false, mensaje: '', total: 0, muestra: [], detalle_ok: false };

  var body;
  try { body = fravegaFetchOrdersPage(1, cfg); }
  catch (e) { out.mensaje = e.message; return out; }

  var items = _apiItems(body);
  out.ok = true;
  out.total = Number(body.total || 0);
  out.paginas = Number(body.pages || 1);
  out.campo_id = _elegirCampoId(items, cfg);
  out.espera_min = parseInt(cfg.orders_api_espera_min || '90', 10);
  out.mensaje = 'Conexión OK · ' + out.total + ' orden(es) pendientes de facturación';

  if (!items.length) {
    out.mensaje += ' — no hay nada pendiente en la ventana configurada';
    return out;
  }

  var rels = _skuRelations();
  var indiceItem = {};
  Object.keys(rels).forEach(function (s) { if (rels[s].item_id) indiceItem[rels[s].item_id] = s; });

  var primero = items[0];
  var oid = _primero(primero.orderId), sid = _primero(primero.suborderId);
  var detalle = null;
  try { detalle = fravegaOrderDetail(oid, sid, cfg); out.detalle_ok = true; }
  catch (e) { out.detalle_error = e.message; }

  out.modo_detalle = getConfig('orders_api_detalle_modo');

  items.slice(0, 5).forEach(function (it) {
    var prods = _apiProductos(null, it);
    var skus = prods.map(function (p) {
      var s = _primero(p.sellerSku, p.sku);
      var t = _resolverSkuApi(s, rels, indiceItem);
      return s + (t ? (t === s ? ' (= SKU Tango)' : ' → Tango ' + t) : ' ⚠ sin relación');
    });
    out.muestra.push({
      orderId: _primero(it.orderId), suborderId: _primero(it.suborderId),
      cliente: _primero(it.clientName), fecha: _primero(it.purchaseDate, it.createdOn),
      entrega: _primero(it.deliveryType), skus: skus.join(' · ')
    });
  });

  if (detalle) {
    var sd = detalle.shippingData || {};
    var sa = sd.shippingAddress || {};
    var bi = detalle.billingInfo || {};
    var ba = bi.billingAddress || {};
    out.domicilio_facturacion = _primero(ba.street) + ' ' + _primero(ba.number) + ', ' +
      _primero(ba.city) + ', ' + _primero(ba.state) + ' CP ' + _primero(ba.zipCode);
    out.domicilio_entrega = _primero(sa.street) + ' ' + _primero(sa.number) + ', ' +
      _primero(sa.city) + ', ' + _primero(sa.state) + ' CP ' + _primero(sa.zipCode);
    out.operador_logistico = _primero(sd.logisticOperator);
    var b = detalle.buyer || {};
    out.comprador = (_primero(b.firstName) + ' ' + _primero(b.lastName)).trim() +
      ' · doc ' + _primero(b.documentNumber) + ' · CUIL ' + _primero(b.cuil);
  }
  return out;
}

/* ═══════════════ MÓDULO FACTURAS ═══════════════ */

function _normKey(s) {
  s = String(s || '').toUpperCase();
  s = s.replace(/[ÁÀÂÄ]/g, 'A').replace(/[ÉÈÊË]/g, 'E').replace(/[ÍÌÎÏ]/g, 'I')
       .replace(/[ÓÒÔÖ]/g, 'O').replace(/[ÚÙÛÜ]/g, 'U').replace(/Ñ/g, 'N');
  s = s.replace(/[^A-Z0-9 ]/g, ' ');
  return s.split(/\s+/).filter(String).sort().join(' ');
}

function _fechaFmt(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {  // serial de Excel
    var d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return ('0' + d.getUTCDate()).slice(-2) + '/' + ('0' + (d.getUTCMonth() + 1)).slice(-2) +
           '/' + d.getUTCFullYear();
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);          // yyyy-mm-dd
  if (m) return m[3] + '/' + m[2] + '/' + m[1];
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/); // dd/mm/yyyy
  if (m) return ('0' + m[1]).slice(-2) + '/' + ('0' + m[2]).slice(-2) + '/' + m[3];
  return s;
}

function apiInvoicesGenerate(user, ordenesRows, facturasRows) {
  if (!ordenesRows || !ordenesRows.length) throw new Error('El CSV de órdenes llegó vacío');
  if (!facturasRows || !facturasRows.length) throw new Error('El reporte de facturación llegó vacío');
  ['RAZON_SOCI', 'N_COMP', 'FECHA_EMI'].forEach(function (c) {
    if (!(c in facturasRows[0])) throw new Error("El reporte no tiene la columna '" + c + "'");
  });

  var estado = (getConfig('invoices_estado_objetivo') || 'Pendiente').toLowerCase();
  var addPrefix = getConfig('invoices_add_prefix') === '1';
  var prefijo = getConfig('invoices_prefix') || 'FVG-';

  var pend = ordenesRows.filter(function (r) {
    return _s(r['Estado de Facturación']).toLowerCase() === estado;
  });

  // Pool de facturas por cliente normalizado (ordenadas por N_COMP)
  var pool = {};
  facturasRows.slice().sort(function (a, b) {
    return String(a['N_COMP']).localeCompare(String(b['N_COMP']));
  }).forEach(function (f) {
    var k = _normKey(f['RAZON_SOCI']);
    (pool[k] = pool[k] || []).push(f);
  });

  var filas = [], sinFactura = [];
  pend.forEach(function (r) {
    var k = _normKey(r['Cliente']);
    if (pool[k] && pool[k].length) {
      var f = pool[k].shift();
      var orden = _s(r['Nro de Orden']);
      if (addPrefix && orden.toUpperCase().indexOf(prefijo.toUpperCase()) !== 0) {
        orden = prefijo + orden;
      }
      // Nro de factura sin guiones ni espacios (formato B0000700001993)
      var nroFactura = String(f['N_COMP']).replace(/[\s\-]/g, '');
      filas.push([orden, nroFactura, _fechaFmt(f['FECHA_EMI'])]);
    } else {
      sinFactura.push({ orden: _s(r['Nro de Orden']), cliente: _s(r['Cliente']) });
    }
  });
  var sobrantes = [];
  Object.keys(pool).forEach(function (k) {
    pool[k].forEach(function (f) {
      sobrantes.push({ cliente: String(f['RAZON_SOCI']), factura: String(f['N_COMP']) });
    });
  });

  var xls = _generarXlsxFacturas(filas);

  _appendRow(SH.INVOICES, [_now(), user.email, xls.archivo, filas.length,
                           sinFactura.length, sobrantes.length,
                           JSON.stringify({ sin_factura: sinFactura, sobrantes: sobrantes })]);
  log_(user.email, 'facturas', 'Exportación generada (desde CSV)', 'ok',
       'cargadas=' + filas.length + ' sin_factura=' + sinFactura.length +
       ' sobrantes=' + sobrantes.length);

  return { archivo: xls.archivo, cargadas: filas.length,
           sin_factura: sinFactura, sobrantes: sobrantes,
           base64: xls.base64 };
}

/**
 * Arma el .xlsx con la ESTRUCTURA COMPLETA que pide Frávega:
 *   Hoja "Ordenes": 7 columnas (las 4 extra van vacías, se completan luego)
 *   Hoja "Transportadoras": 50 opciones (para el dropdown)
 *   Hoja "config": version / operation
 * `filas` es una lista de [orden, nroFactura, fecha].
 */
function _generarXlsxFacturas(filas) {
  var nombre = 'Tabla-modelo-facturas COMPLETO ' +
    Utilities.formatDate(new Date(), TZ_AR, 'yyyyMMdd_HHmmss');
  var ss = SpreadsheetApp.create(nombre);

  // Hoja Ordenes
  var hoja = ss.getSheets()[0];
  hoja.setName('Ordenes');
  hoja.getRange(1, 1, 1, 7).setValues([[
    'Orden*', 'Nro Factura*', 'Fecha*', 'Url factura',
    'Nro Seguimiento', 'Url seguimiento', 'Transportadora']]);
  if (filas.length) {
    var full = filas.map(function (f) { return [f[0], f[1], f[2], '', '', '', '']; });
    hoja.getRange(2, 1, full.length, 7).setValues(full);
  }

  // Hoja Transportadoras (opciones válidas del dropdown, 50 filas)
  var transp = ss.insertSheet('Transportadoras');
  var opciones = [];
  opciones.push(['FravegaEnvios - Envio a domicilio']);
  for (var t = 0; t < 49; t++) opciones.push(['Retiro en Sucursal']);
  transp.getRange(1, 1, 50, 1).setValues(opciones);

  // Validación de datos en la columna Transportadora (G2:G9999)
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(transp.getRange('A1:A50'), true)
    .setAllowInvalid(true).build();
  hoja.getRange('G2:G9999').setDataValidation(rule);

  // Hoja config
  var cfgSheet = ss.insertSheet('config');
  cfgSheet.getRange(1, 1, 2, 2).setValues([['version', '1'], ['operation', 'invoice']]);

  SpreadsheetApp.flush();

  var xlsx = UrlFetchApp.fetch(
    'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
  DriveApp.getFileById(ss.getId()).setTrashed(true);  // no acumular copias en Drive

  return { archivo: nombre + '.xlsx', base64: Utilities.base64Encode(xlsx.getBytes()) };
}

/* ── Facturación cruzando contra el historial de OrdenesEnviadas ──────────
 * Con las órdenes entrando por API ya no hace falta volver a subir el CSV de
 * Frávega: la app guardó cliente, documento y total de cada pedido que le mandó
 * a Tango. Subís solo el reporte de facturación de Tango y el cruce se hace
 * primero por número de documento (que es unívoco) y recién después por nombre.
 * Cada orden que se matchea queda marcada como facturada, así no se vuelve a
 * usar en la próxima exportación. */

/** Busca en el reporte de Tango la columna que trae el documento del cliente. */
function _columnaDocumento(fila) {
  var alias = ['nro_doc', 'nrodoc', 'nro_docum', 'nro_documento', 'documento', 'doc',
               'dni', 'cuit', 'nro_cuit', 'cuit_cuil', 'cuil', 'nro_iva', 'nro_ident'];
  var claves = Object.keys(fila || {});
  for (var i = 0; i < claves.length; i++) {
    var norm = String(claves[i]).toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (alias.indexOf(norm) !== -1) return claves[i];
  }
  return '';
}

/** Solo los dígitos, para comparar documentos sin importar puntos ni guiones. */
function _soloDigitos(v) { return String(v === null || v === undefined ? '' : v).replace(/\D/g, ''); }

/** Las órdenes que se mandaron a Tango y todavía no tienen factura cargada. */
function apiInvoicesPendientes() {
  var rows = _readRows(SH.SENT, 1000);
  var pend = [], sinDatos = 0;
  rows.forEach(function (r) {
    var estado = String(r.estado_facturacion || '').toLowerCase();
    if (estado === 'facturada') return;
    var cliente = String(r.cliente || '').trim();
    var doc = _soloDigitos(r.documento);
    if (!cliente && !doc) { sinDatos++; return; }   // filas viejas, de antes de la API
    pend.push({ orden: String(r.order_id), suborden: String(r.suborder_id || ''),
                cliente: cliente, documento: doc,
                fecha_compra: String(r.fecha_compra || ''),
                total: r.total, items: String(r.items || ''),
                origen: String(r.origen || '') });
  });
  return { pendientes: pend.reverse(), sin_datos: sinDatos, total: pend.length };
}

/**
 * Cruza el reporte de facturación de Tango contra el historial de órdenes
 * enviadas y genera el .xlsx para Frávega. NO necesita el CSV de órdenes.
 */
function apiInvoicesFromHistory(user, facturasRows) {
  if (!facturasRows || !facturasRows.length) throw new Error('El reporte de facturación llegó vacío');
  ['RAZON_SOCI', 'N_COMP', 'FECHA_EMI'].forEach(function (c) {
    if (!(c in facturasRows[0])) throw new Error("El reporte no tiene la columna '" + c + "'");
  });

  var addPrefix = getConfig('invoices_add_prefix') === '1';
  var prefijo = getConfig('invoices_prefix') || 'FVG-';
  var colDoc = _columnaDocumento(facturasRows[0]);

  var sheet = _sheet(SH.SENT);
  var last = sheet.getLastRow();
  if (last < 2) throw new Error('El historial de órdenes enviadas está vacío. ' +
                                'Primero ingresá pedidos con la API o el CSV.');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
                     .map(function (h) { return String(h).trim(); });
  var col = {};
  headers.forEach(function (h, i) { col[h] = i; });
  ['estado_facturacion', 'nro_factura', 'fecha_factura', 'facturada_en'].forEach(function (c) {
    if (col[c] === undefined) {
      throw new Error('A la hoja OrdenesEnviadas le falta la columna "' + c +
                      '". Ejecutá MIGRAR_ORDENES_API() desde el editor.');
    }
  });
  var datos = sheet.getRange(2, 1, last - 1, headers.length).getValues();

  // Pool de facturas ordenadas por número, indexadas por documento y por nombre.
  var facturas = facturasRows.slice().sort(function (a, b) {
    return String(a['N_COMP']).localeCompare(String(b['N_COMP']));
  });
  var usadas = {}, porDoc = {}, porNombre = {};
  facturas.forEach(function (f, i) {
    f.__i = i;
    if (colDoc) {
      var d = _soloDigitos(f[colDoc]);
      if (d) (porDoc[d] = porDoc[d] || []).push(f);
    }
    var k = _normKey(f['RAZON_SOCI']);
    (porNombre[k] = porNombre[k] || []).push(f);
  });

  function tomar(lista) {
    if (!lista) return null;
    for (var i = 0; i < lista.length; i++) {
      if (!usadas[lista[i].__i]) { usadas[lista[i].__i] = true; return lista[i]; }
    }
    return null;
  }

  var filas = [], sinFactura = [], matcheadas = 0;
  var porDocCount = 0, porNombreCount = 0;
  var ts = _now();

  for (var r = 0; r < datos.length; r++) {
    var fila = datos[r];
    var estado = String(fila[col.estado_facturacion] || '').toLowerCase();
    if (estado === 'facturada') continue;

    var orden = String(fila[col.order_id] || '').trim();
    if (!orden) continue;
    var cliente = String(fila[col.cliente] || '').trim();
    var doc = _soloDigitos(fila[col.documento]);
    if (!cliente && !doc) continue;   // fila vieja sin datos: no se puede matchear

    // 1) por documento (unívoco)  2) por nombre normalizado (respaldo)
    var f = doc ? tomar(porDoc[doc]) : null;
    if (f) porDocCount++;
    if (!f && cliente) { f = tomar(porNombre[_normKey(cliente)]); if (f) porNombreCount++; }

    if (!f) {
      sinFactura.push({ orden: orden, cliente: cliente, documento: doc });
      continue;
    }

    var ordenSalida = orden;
    if (addPrefix && ordenSalida.toUpperCase().indexOf(prefijo.toUpperCase()) !== 0) {
      ordenSalida = prefijo + ordenSalida;
    }
    var nroFactura = String(f['N_COMP']).replace(/[\s\-]/g, '');
    var fechaFactura = _fechaFmt(f['FECHA_EMI']);
    filas.push([ordenSalida, nroFactura, fechaFactura]);

    fila[col.estado_facturacion] = 'facturada';
    fila[col.nro_factura] = nroFactura;
    fila[col.fecha_factura] = fechaFactura;
    fila[col.facturada_en] = ts;
    matcheadas++;
  }

  if (matcheadas) sheet.getRange(2, 1, datos.length, headers.length).setValues(datos);

  var sobrantes = [];
  facturas.forEach(function (f) {
    if (!usadas[f.__i]) {
      sobrantes.push({ cliente: String(f['RAZON_SOCI']), factura: String(f['N_COMP']) });
    }
  });

  var xls = _generarXlsxFacturas(filas);

  _appendRow(SH.INVOICES, [_now(), user.email, xls.archivo, filas.length,
                           sinFactura.length, sobrantes.length,
                           JSON.stringify({ sin_factura: sinFactura, sobrantes: sobrantes,
                                            por_documento: porDocCount,
                                            por_nombre: porNombreCount })]);
  log_(user.email, 'facturas', 'Exportación generada (desde el historial)', 'ok',
       'cargadas=' + filas.length + ' por_documento=' + porDocCount +
       ' por_nombre=' + porNombreCount + ' sin_factura=' + sinFactura.length +
       ' sobrantes=' + sobrantes.length);

  return { archivo: xls.archivo, cargadas: filas.length,
           sin_factura: sinFactura, sobrantes: sobrantes,
           por_documento: porDocCount, por_nombre: porNombreCount,
           columna_documento: colDoc || '(el reporte no trae documento: se matcheó solo por nombre)',
           base64: xls.base64 };
}

/* ═══════════════ MÓDULO SKUs / PENDIENTES ═══════════════ */

function _skuRelations() {
  var rows = _readRows(SH.SKUS);
  var out = {};
  rows.forEach(function (r) {
    var sku = String(r.sku_tango || '').trim();
    if (!sku) return;
    out[sku] = { item_id: String(r.fravega_item_id || '').trim(),
                 refid: String(r.fravega_refid || '').trim() || sku,
                 // OnCity (VTEX): el refId es el mismo código de Tango salvo que
                 // se cargue otro. oncity_sku_id es el id interno de VTEX, que
                 // se resuelve solo la primera vez y queda cacheado en la hoja.
                 oncity_refid: String(r.oncity_refid || '').trim() || sku,
                 oncity_sku_id: String(r.oncity_sku_id || '').trim(),
                 descripcion: String(r.descripcion || '') };
  });
  return out;
}

function apiSkusList(q) {
  var rows = _readRows(SH.SKUS);
  q = String(q || '').toLowerCase();
  if (q) {
    rows = rows.filter(function (r) {
      return ['sku_tango', 'fravega_item_id', 'fravega_refid', 'descripcion',
              'oncity_refid', 'oncity_sku_id']
        .some(function (c) { return String(r[c] || '').toLowerCase().indexOf(q) !== -1; });
    });
  }
  return rows;
}

function apiSkusSave(user, p) {
  var sku = String(p.sku_tango || '').trim();
  if (!sku) throw new Error('sku_tango es obligatorio');
  var refid = String(p.fravega_refid || '').trim() || sku;
  var item = String(p.fravega_item_id || '').trim();
  var desc = String(p.descripcion || '').trim();
  var onRef = String(p.oncity_refid || '').trim() || sku;
  var onId = String(p.oncity_sku_id || '').trim();
  var sheet = _sheet(SH.SKUS);
  var col = _colValues(sheet, 1);
  var ts = _now();
  var idx = col.indexOf(sku);
  var original = String(p.original_sku || '').trim();

  if (original && original !== sku) {           // renombrar SKU
    var idxOrig = col.indexOf(original);
    if (idxOrig === -1) throw new Error('Relación no encontrada: ' + original);
    if (idx !== -1) throw new Error('Ya existe una relación para ' + sku);
    sheet.getRange(idxOrig + 2, 1, 1, 6)
         .setValues([[sku, item, refid, desc, sheet.getRange(idxOrig + 2, 5).getValue(), ts]]);
    _skuSetOncity(sheet, idxOrig + 2, onRef, onId);   // el id de VTEX se vuelve a resolver si va vacío
  } else if (idx !== -1) {                      // actualizar
    var refAnterior = String(sheet.getRange(idx + 2, 7).getValue() || '').trim();
    sheet.getRange(idx + 2, 2, 1, 5)
         .setValues([[item, refid, desc, sheet.getRange(idx + 2, 5).getValue() || ts, ts]]);
    // si cambió el refId de OnCity, el id interno cacheado ya no sirve
    _skuSetOncity(sheet, idx + 2, onRef,
      onId || (refAnterior === onRef ? String(sheet.getRange(idx + 2, 8).getValue() || '') : ''));
  } else {                                      // crear
    sheet.appendRow([sku, item, refid, desc, ts, ts, onRef, onId]);
  }
  log_(user.email, 'skus', 'Relación guardada: ' + sku, 'ok', '');
  return { ok: true };
}

function apiSkusDelete(user, skuTango) {
  var sheet = _sheet(SH.SKUS);
  var idx = _colValues(sheet, 1).indexOf(String(skuTango).trim());
  if (idx === -1) throw new Error('Relación no encontrada');
  sheet.deleteRow(idx + 2);
  log_(user.email, 'skus', 'Relación eliminada: ' + skuTango, 'warning', '');
  return { ok: true };
}

function apiSkusImport(user, rows) {
  if (!rows || !rows.length) throw new Error('El archivo llegó vacío');
  var creadas = 0, actualizadas = 0, errores = [];
  var sheet = _sheet(SH.SKUS);
  var col = _colValues(sheet, 1);
  var ts = _now();
  rows.forEach(function (r, i) {
    var sku = String(r.sku_tango || '').trim();
    if (!sku) { errores.push('Fila ' + (i + 2) + ': falta sku_tango'); return; }
    var item = String(r.fravega_item_id || '').trim();
    var refid = String(r.fravega_refid || '').trim() || sku;
    var desc = String(r.descripcion || '').trim();
    var onRef = String(r.oncity_refid || '').trim() || sku;
    var onId = String(r.oncity_sku_id || '').trim();
    var idx = col.indexOf(sku);
    if (idx !== -1) {
      var refAnt = String(sheet.getRange(idx + 2, 7).getValue() || '').trim();
      sheet.getRange(idx + 2, 2, 1, 5)
           .setValues([[item, refid, desc, sheet.getRange(idx + 2, 5).getValue() || ts, ts]]);
      _skuSetOncity(sheet, idx + 2, onRef,
        onId || (refAnt === onRef ? String(sheet.getRange(idx + 2, 8).getValue() || '') : ''));
      actualizadas++;
    } else {
      sheet.appendRow([sku, item, refid, desc, ts, ts, onRef, onId]);
      col.push(sku);
      creadas++;
    }
  });
  log_(user.email, 'skus', 'Importación de relaciones',
       errores.length ? 'warning' : 'ok',
       'creadas=' + creadas + ' actualizadas=' + actualizadas + ' errores=' + errores.length);
  return { creadas: creadas, actualizadas: actualizadas, errores: errores };
}

function _pendingList() {
  return _readRows(SH.PENDING).filter(function (r) { return r.estado === 'pendiente'; })
    .reverse();
}

function _pendingAdd(sku, origen, obs) {
  var sheet = _sheet(SH.PENDING);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(sku) && data[i][1] === origen) {
      sheet.getRange(i + 1, 3, 1, 2).setValues([['pendiente', obs]]);
      sheet.getRange(i + 1, 6).setValue('');
      return;
    }
  }
  sheet.appendRow([String(sku), origen, 'pendiente', obs, _now(), '']);
}

function apiPendingResolve(user, sku, origen) {
  var sheet = _sheet(SH.PENDING);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(sku) && data[i][1] === origen) {
      sheet.getRange(i + 1, 3).setValue('resuelto');
      sheet.getRange(i + 1, 6).setValue(_now());
      log_(user.email, 'skus', 'Pendiente resuelto: ' + sku, 'ok', '');
      return { ok: true };
    }
  }
  throw new Error('Pendiente no encontrado');
}

/* ═══════════════ LOGS / CONFIG / DASHBOARD ═══════════════ */

function log_(usuario, modulo, accion, resultado, detalle, duracionMs) {
  try {
    _appendRow(SH.LOGS, [_now(), usuario, modulo, accion, resultado,
                         String(detalle || '').slice(0, 2000), duracionMs || '']);
  } catch (e) { /* nunca romper por un log */ }
}

function apiLogsList(p) {
  var rows = _readRows(SH.LOGS, 2000).reverse();
  return rows.filter(function (r) {
    if (p.modulo && r.modulo !== p.modulo) return false;
    if (p.resultado && r.resultado !== p.resultado) return false;
    if (p.desde && String(r.fecha_hora) < p.desde) return false;
    if (p.hasta && String(r.fecha_hora) > p.hasta + ' 23:59:59') return false;
    if (p.q) {
      var q = p.q.toLowerCase();
      if ((String(r.accion) + String(r.detalle) + String(r.usuario))
          .toLowerCase().indexOf(q) === -1) return false;
    }
    return true;
  }).slice(0, 500);
}

function _configMap() {
  var out = {};
  _sheet(SH.CONFIG).getDataRange().getValues().slice(1).forEach(function (r) {
    out[String(r[0])] = String(r[1]);
  });
  return out;
}

function getConfig(key) { return _configMap()[key] || ''; }

function setConfig(key, value) {
  var sheet = _sheet(SH.CONFIG);
  var idx = _colValues(sheet, 1).indexOf(key);
  if (idx === -1) sheet.appendRow([key, String(value), '']);
  else sheet.getRange(idx + 2, 2).setValue(String(value));
}

function apiSettingsGet() {
  var props = PropertiesService.getScriptProperties();
  return {
    valores: _configMap(),
    credenciales: {
      tango_token: !!props.getProperty('TANGO_ACCESS_TOKEN'),
      fravega_seller_id: !!props.getProperty('FRAVEGA_SELLER_ID'),
      fravega_api_key: !!props.getProperty('FRAVEGA_API_KEY'),
      fravega_api_token: !!props.getProperty('FRAVEGA_API_TOKEN'),
      google_client_id: !!props.getProperty('GOOGLE_CLIENT_ID'),
      vtex_app_key: !!props.getProperty('VTEX_APP_KEY'),
      vtex_app_token: !!props.getProperty('VTEX_APP_TOKEN')
    },
    proxima_sincronizacion: _proximaSync()
  };
}

function apiSettingsSet(user, valores) {
  var editables = {};
  DEFAULT_CONFIG.forEach(function (r) { editables[r[0]] = true; });
  var cambios = [];
  Object.keys(valores || {}).forEach(function (k) {
    if (!editables[k]) throw new Error('Clave no editable: ' + k);
    setConfig(k, valores[k]);
    cambios.push(k + '=' + valores[k]);
  });
  if ('scheduler_hours' in (valores || {}) || 'scheduler_enabled' in (valores || {})) {
    configurarTriggers();
  }
  log_(user.email, 'configuracion', 'Configuración actualizada', 'ok', cambios.join(', '));
  return { ok: true, proxima_sincronizacion: _proximaSync() };
}

function apiDashboard() {
  var vt = tangoVerify();
  var vf = fravegaPing();
  var vo = getConfig('stock_destino_oncity') === '1' ? vtexPing() : [true, 'Destino deshabilitado'];
  var syncs = _readRows(SH.SYNCS, 1);
  var ultima = syncs.length ? syncs[syncs.length - 1] : null;
  var pendientes = _pendingList().length;
  var skus = _sheet(SH.SKUS).getLastRow() - 1;
  var invoices = _readRows(SH.INVOICES, 1);
  var ordersRows = _readRows(SH.ORDERS, 200);
  var totalEnviadas = 0;
  ordersRows.forEach(function (r) { totalEnviadas += Number(r.enviadas) || 0; });
  var errores24 = _readRows(SH.LOGS, 500).filter(function (r) {
    return r.resultado === 'error' &&
      (new Date().getTime() - new Date(String(r.fecha_hora)).getTime()) < 86400000;
  });

  var alertas = [];
  if (!vt[0]) alertas.push('Tango: ' + vt[1]);
  if (!vf[0]) alertas.push('Frávega: ' + vf[1]);
  if (!vo[0]) alertas.push('OnCity: ' + vo[1]);
  if (getConfig('stock_destino_oncity') === '1' && getConfig('oncity_dry_run') === '1') {
    alertas.push('OnCity está en modo simulación: se calcula el stock pero NO se escribe en VTEX');
  }
  if (getConfig('stock_destino_oncity') === '1' && !getConfig('oncity_warehouse_id')) {
    alertas.push('Falta elegir el depósito de VTEX para OnCity (Configuración)');
  }
  if (pendientes) alertas.push('Hay ' + pendientes + ' SKU sin relación');
  if (ultima && ultima.resultado !== 'ok') {
    alertas.push('La última sincronización terminó: ' + ultima.resultado);
  }

  return {
    tango: { ok: vt[0], detalle: vt[1] },
    fravega: { ok: vf[0], detalle: vf[1] },
    oncity: { ok: vo[0], detalle: vo[1],
              habilitado: getConfig('stock_destino_oncity') === '1',
              simulacion: getConfig('oncity_dry_run') === '1' },
    sincronizacion: { ultima: ultima, proxima: _proximaSync(),
                      habilitada: getConfig('scheduler_enabled') === '1' },
    contadores: { relaciones: Math.max(skus, 0), sku_pendientes: pendientes,
                  ordenes_importadas: totalEnviadas, errores_24h: errores24.length },
    ultima_exportacion: invoices.length ? invoices[invoices.length - 1] : null,
    errores_recientes: errores24.slice(-5).reverse(),
    alertas: alertas
  };
}

/**
 * Prepara una planilla que YA existe para trabajar con OnCity: agrega las
 * columnas nuevas, las claves de configuración y guarda las credenciales de
 * VTEX. Es idempotente: se puede correr las veces que quieras.
 */
function MIGRAR_ONCITY() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Columnas nuevas en la tabla de relaciones
  var sk = ss.getSheetByName(SH.SKUS);
  if (sk) {
    var heads = sk.getRange(1, 1, 1, Math.max(sk.getLastColumn(), 1)).getValues()[0]
                  .map(function (h) { return String(h).trim(); });
    ['oncity_refid', 'oncity_sku_id'].forEach(function (h) {
      if (heads.indexOf(h) === -1) { sk.getRange(1, heads.length + 1).setValue(h).setFontWeight('bold'); heads.push(h); }
    });
    // refId de OnCity vacío = mismo código de Tango
    var last = sk.getLastRow();
    if (last > 1) {
      var cRef = heads.indexOf('oncity_refid') + 1;
      var skus = sk.getRange(2, 1, last - 1, 1).getValues();
      var refs = sk.getRange(2, cRef, last - 1, 1).getValues();
      var cambios = false;
      for (var i = 0; i < refs.length; i++) {
        if (!String(refs[i][0]).trim() && String(skus[i][0]).trim()) {
          refs[i][0] = String(skus[i][0]).trim(); cambios = true;
        }
      }
      if (cambios) sk.getRange(2, cRef, refs.length, 1).setValues(refs);
    }
  }

  // 2. Columna de destino en el historial de sincronizaciones
  var sy = ss.getSheetByName(SH.SYNCS);
  if (sy) {
    var h2 = sy.getRange(1, 1, 1, Math.max(sy.getLastColumn(), 1)).getValues()[0]
               .map(function (h) { return String(h).trim(); });
    if (h2.indexOf('destino') === -1) {
      sy.getRange(1, h2.length + 1).setValue('destino').setFontWeight('bold');
    }
  }

  // 3. Claves de configuración que falten
  var cfg = ss.getSheetByName(SH.CONFIG);
  if (cfg) {
    var existentes = _colValues(cfg, 1);
    DEFAULT_CONFIG.forEach(function (row) {
      if (existentes.indexOf(row[0]) === -1) cfg.appendRow(row);
    });
  }

  // 4. Credenciales de VTEX
  var props = PropertiesService.getScriptProperties();
  ['VTEX_ACCOUNT', 'VTEX_APP_KEY', 'VTEX_APP_TOKEN'].forEach(function (k) {
    if (INITIAL_CREDENTIALS[k]) props.setProperty(k, INITIAL_CREDENTIALS[k]);
  });

  return 'Migración OnCity lista. Ahora elegí el depósito de VTEX en Configuración.';
}

/** Si VTEX tiene un solo depósito, lo deja configurado sin tener que elegirlo a mano. */
function USAR_UNICO_DEPOSITO() {
  var ws = vtexWarehouses();
  if (ws.length !== 1) {
    Logger.log('Hay %s depósitos: elegí uno en Configuración. %s', ws.length, JSON.stringify(ws));
    return null;
  }
  setConfig('oncity_warehouse_id', ws[0].id);
  Logger.log('Depósito de OnCity configurado: %s (%s)', ws[0].id, ws[0].name);
  return ws[0];
}

/* ───────────────────────────────────────────────────────────────────────────
 * CARGA MANUAL DE LOS ID DE VTEX
 * Pegá acá el listado del seller center: a la izquierda NUESTRO código (el de
 * Tango, que es el refId), a la derecha el ID del SKU en VTEX. Después ejecutá
 * CARGAR_IDS_ONCITY(). Crea la relación si no existía y completa el id si ya
 * estaba. Se puede correr las veces que quieras.
 * ─────────────────────────────────────────────────────────────────────────── */
var IDS_ONCITY = {
  // 'refId / código Tango' : 'skuId de VTEX'   ← del export del seller center
  '10306': '5',     // Caja Fuerte Digital Reforzada acero Kenta Negro
  '18501': '14',     // Soporte de TV Monitor 14'' a 43'' Max 22kg FB44
  '18502': '15',     // Soporte de TV Monitor reforzado 26'' a 65'' Max 35 kg. 
  '18503': '16',     // Soporte TV Monitor Articulado 26'' a 55'' Max 30 kg. S3
  '19501': '17',     // Balanza De Baño Digital Con App Bluetooth 180kg Kenta N
  '19502': '19',     // Balanza De Cocina Anti-Deslizante Led Digital 10kg Con 
  '19503': '18',     // Balanza Digital Portátil para Valijas o Viajes KTB07 50
  '19504': '20',     // Balanza De Cocina Led Digital 5kg Con Tara Alta Presici
  '20608': '1',     // Freidora de aire digital 8Lts Kenta
  '21405': '2',     // Tostadora acero inoxidable 6 Niveles gris Kenta
  '21406': '3',     // Tostadora 6 Niveles Alta Potencia Kenta Blanco
  '21605': '12',     // Sandwichera 3 en 1 Wafflera Grill Sandwich Kenta
  '22506': '7',     // Planchita De Pelo Cerámica Turmalina 4 Niveles Kenta
  '23106': '4',     // Minipimer Mixer Kenta - Licuadora de mano 500 W
  '30006': '6',     // Ventilador 3 en 1 18 pulgadas 90W Alta Calidad Kenta
  '33002': '23',     // Freidora De Aire Airfryer 8l + Tostadora 6 Niveles Kent
  '33003': '24',     // FREIDORA DE AIRE + TOSTADORA GRIS + SANDWICHERA
  '46050': '11',     // Hidrolavadora 1500 Psi Potente Kenta Azul 1400w Azul
  '47820': '31',     // Grupo Electrógeno KTG39
  '47830': '32',     // Grupo Electrógeno KTG56
  '55829': '34',     // Monopatín Scooter Eléctrico Infantil MK029 Luces C/fren
  '55840': '33',     // Monopatín Scooter Eléctrico Kenta Mk084 Potente 500w 30
  '55877': '26',     // Propulsor Acuático Scooter Submarino Pileta Mar Rio Ama
  '65002': '13',     // Plancha A Vapor Vertical 1500w 3 Niveles Kenta Digital 
  '72156': '9'      // Robot Limpiador Inteligente Aspiradora Trapeadora Kenta
};

function CARGAR_IDS_ONCITY() {
  var sheet = _sheet(SH.SKUS);
  var col = _colValues(sheet, 1);
  var rels = _skuRelations();
  var ts = _now();

  // índice por refId de OnCity, porque la clave del listado es el refId
  var porRef = {};
  Object.keys(rels).forEach(function (sku) { porRef[rels[sku].oncity_refid] = sku; });

  var actualizados = 0, creados = 0;
  Object.keys(IDS_ONCITY).forEach(function (ref) {
    var id = String(IDS_ONCITY[ref] || '').trim();
    if (!id) return;
    var sku = porRef[ref] || ref;          // si no hay relación, el código es el mismo
    var idx = col.indexOf(sku);
    if (idx !== -1) {
      _skuSetOncity(sheet, idx + 2, ref, id);
      actualizados++;
    } else {
      // artículo que existe en OnCity pero todavía no estaba en la tabla
      sheet.appendRow([sku, '', sku, '', ts, ts, ref, id]);
      col.push(sku);
      creados++;
    }
  });

  Logger.log('IDs cargados: %s actualizados, %s creados', actualizados, creados);
  var rels2 = _skuRelations();
  var faltan = Object.keys(rels2).filter(function (k) { return !rels2[k].oncity_sku_id; });
  Logger.log('Relaciones con id listo: %s de %s', Object.keys(rels2).length - faltan.length, Object.keys(rels2).length);
  if (faltan.length) Logger.log('Todavía sin id: %s', faltan.join(', '));
  return { actualizados: actualizados, creados: creados, sin_id: faltan };
}

/**
 * Escribe el stock de UN solo artículo en VTEX, con su valor real de Tango.
 * Es la prueba mínima antes de largar la sincronización completa: si esto
 * devuelve 200, la escritura de inventario está habilitada para la AppKey.
 * No es destructivo: escribe exactamente el número que corresponde.
 *   PROBAR_ESCRITURA_ONCITY('19501')   ← o sin argumento, toma el primero con id
 */
function PROBAR_ESCRITURA_ONCITY(skuTango) {
  var wh = getConfig('oncity_warehouse_id');
  if (!wh) { Logger.log('Falta configurar el depósito de VTEX (USAR_UNICO_DEPOSITO).'); return; }

  var rels = _skuRelations();
  var sku = String(skuTango || '').trim();
  if (!sku) {
    var conId = Object.keys(rels).filter(function (k) { return rels[k].oncity_sku_id; });
    if (!conId.length) { Logger.log('Ninguna relación tiene id de VTEX todavía.'); return; }
    sku = conId[0];
  }
  var rel = rels[sku];
  if (!rel) { Logger.log('No existe la relación para el SKU %s', sku); return; }
  if (!rel.oncity_sku_id) { Logger.log('El SKU %s no tiene id de VTEX cargado.', sku); return; }

  var records = tangoFetchStock(getConfig('stock_warehouse_code'),
                                getConfig('stock_discount_pending') === '1');
  var restar = getConfig('stock_subtract_engaged') === '1';
  var qty = 0;
  records.forEach(function (it) {
    if (String(it.SKUCode || '').trim() !== sku) return;
    var q = Number(it.Quantity) || 0;
    if (restar) q -= Number(it.EngagedQuantity) || 0;
    qty += q;
  });
  qty = Math.max(0, Math.round(qty));

  Logger.log('Escribiendo en VTEX: SKU Tango %s → skuId %s · depósito %s · cantidad %s',
             sku, rel.oncity_sku_id, wh, qty);
  var res = vtexUpdateStock(rel.oncity_sku_id, wh, qty);
  Logger.log(res[0] ? '✓ ESCRITURA OK (HTTP %s). Ya se puede sincronizar de verdad.'
                    : '✗ FALLÓ: %s', res[1]);
  return res;
}

/**
 * Prueba de escritorio: conexión con VTEX, depósitos disponibles y traducción
 * de los primeros refId. NO escribe stock. Ejecutala desde el editor.
 */
function PROBAR_ONCITY() {
  var ping = vtexPing();
  Logger.log('Conexión VTEX: %s · %s', ping[0] ? 'OK' : 'FALLA', ping[1]);
  if (!ping[0]) return;
  var ws = vtexWarehouses();
  Logger.log('Depósitos de VTEX: %s', JSON.stringify(ws));
  var whCfg = getConfig('oncity_warehouse_id');
  Logger.log('Depósito configurado: "%s"', whCfg);
  if (!whCfg && ws.length === 1) {
    Logger.log('  → Hay un solo depósito en VTEX ("%s"). Elegilo en Configuración o ejecutá USAR_UNICO_DEPOSITO().', ws[0].id);
  }
  var rels = _skuRelations();
  var claves = Object.keys(rels);

  // Diagnóstico detallado del PRIMER refId: acá se ve si el catálogo responde
  // 403 (permisos de la AppKey), 404 (no existe) o devuelve algo inesperado.
  if (claves.length) {
    var diag = [];
    var primero = rels[claves[0]];
    var idPrimero = vtexSkuIdByRef(primero.oncity_refid, diag);
    Logger.log('--- Diagnóstico de la búsqueda para refId %s ---', primero.oncity_refid);
    diag.forEach(function (d) {
      Logger.log('  [%s] HTTP %s → id "%s" · %s', d.intento, d.http, d.id, d.respuesta);
    });
    Logger.log('  Resultado: %s', idPrimero || '(no se pudo resolver)');
    Logger.log('--- fin del diagnóstico ---');
  }

  var listas = claves.filter(function (k) { return rels[k].oncity_sku_id; });
  Logger.log('Relaciones con id de VTEX listo: %s de %s', listas.length, claves.length);
  claves.slice(0, 10).forEach(function (sku) {
    Logger.log('  Tango %s → refId %s → skuId VTEX %s', sku, rels[sku].oncity_refid,
               rels[sku].oncity_sku_id || '(sin id — no publicado en OnCity)');
  });
  if (listas.length < claves.length) {
    Logger.log('Para completar los que faltan: APRENDER_IDS_DE_PEDIDOS(10) o cargalos a mano.');
  }
  Logger.log('Modo simulación: %s', getConfig('oncity_dry_run') === '1' ? 'SÍ (no escribe)' : 'NO (escribe de verdad)');
}

/* ═══════════════ ONCITY (VTEX) ═══════════════
 * Segundo destino del stock. Misma idea que Frávega: se lee el stock del
 * depósito de Tango y se escribe en la tienda. Diferencias propias de VTEX:
 *   · VTEX identifica el artículo por un id interno (skuId), no por el refId.
 *     El refId es el código nuestro (el mismo de Tango), así que la primera vez
 *     se traduce refId → skuId y queda cacheado en la hoja de relaciones.
 *   · El stock se escribe contra un depósito (warehouse) puntual de VTEX.
 * ══════════════════════════════════════════════════════════════════════════ */

function _vtexBase() {
  var acc = _prop('VTEX_ACCOUNT');
  if (!acc) throw new Error('Falta VTEX_ACCOUNT en Script Properties');
  return 'https://' + acc + '.' + VTEX_ENV + '.com.br';
}

function _vtexHeaders() {
  return {
    'X-VTEX-API-AppKey': _prop('VTEX_APP_KEY'),
    'X-VTEX-API-AppToken': _prop('VTEX_APP_TOKEN'),
    'Accept': 'application/json'
  };
}

function _vtexFetch(path, opts) {
  opts = opts || {};
  opts.headers = _vtexHeaders();
  opts.muteHttpExceptions = true;
  opts.followRedirects = true;
  return UrlFetchApp.fetch(_vtexBase() + path, opts);
}

function vtexPing() {
  try {
    var r = _vtexFetch('/api/logistics/pvt/configuration/warehouses');
    var code = r.getResponseCode();
    if (code === 200) {
      var n = (JSON.parse(r.getContentText()) || []).length;
      return [true, 'Conexión OK · ' + n + ' depósito(s) en VTEX'];
    }
    if (code === 401 || code === 403) return [false, 'Credenciales rechazadas (HTTP ' + code + ')'];
    return [false, 'HTTP ' + code + ': ' + r.getContentText().slice(0, 160)];
  } catch (e) { return [false, 'Sin conexión con VTEX: ' + e.message]; }
}

/** Depósitos de VTEX, para elegir en Configuración cuál recibe el stock. */
function vtexWarehouses() {
  var r = _vtexFetch('/api/logistics/pvt/configuration/warehouses');
  if (r.getResponseCode() !== 200) {
    throw new Error('VTEX /warehouses HTTP ' + r.getResponseCode() + ': ' +
                    r.getContentText().slice(0, 200));
  }
  return (JSON.parse(r.getContentText()) || []).map(function (w) {
    return { id: String(w.id), name: String(w.name || w.id) };
  });
}

/**
 * refId (nuestro código) → skuId interno de VTEX.
 * VTEX expone esto por varios endpoints y no todos están habilitados en todas
 * las cuentas (depende de los permisos de la AppKey sobre el Catálogo). Por eso
 * probamos varios caminos y, si se pasa `diag`, dejamos anotado qué respondió
 * cada uno: eso es lo que permite distinguir "no existe" de "sin permisos".
 */
function vtexSkuIdByRef(refId, diag) {
  if (!refId) return '';
  var intentos = [
    { nombre: 'catalog_system/stockkeepingunitidsbyrefid',
      path: '/api/catalog_system/pvt/sku/stockkeepingunitidsbyrefid/' + encodeURIComponent(refId),
      leer: function (t) { var a = JSON.parse(t || '[]'); return (a && a.length) ? String(a[0]) : ''; } },
    { nombre: 'catalog/stockkeepingunit?refId',
      path: '/api/catalog/pvt/stockkeepingunit?refId=' + encodeURIComponent(refId),
      leer: function (t) {
        var o = JSON.parse(t || '{}');
        if (o && o.Id) return String(o.Id);
        if (o && o.length && o[0] && o[0].Id) return String(o[0].Id);
        return '';
      } },
    { nombre: 'catalog_system/pub/products/search (alternateIds_RefId)',
      path: '/api/catalog_system/pub/products/search?fq=alternateIds_RefId:' + encodeURIComponent(refId),
      leer: function (t) { return _vtexItemDeBusqueda(t, refId); } },
    { nombre: 'catalog_system/pub/products/search (texto libre)',
      path: '/api/catalog_system/pub/products/search/' + encodeURIComponent(refId),
      leer: function (t) { return _vtexItemDeBusqueda(t, refId); } }
  ];

  for (var i = 0; i < intentos.length; i++) {
    var it = intentos[i];
    try {
      var r = _vtexFetch(it.path);
      var code = r.getResponseCode();
      var body = r.getContentText();
      var id = '';
      if (code >= 200 && code < 300) { try { id = it.leer(body); } catch (e) { id = ''; } }
      if (diag) diag.push({ intento: it.nombre, http: code, id: id, respuesta: String(body).slice(0, 180) });
      if (id) return id;
    } catch (e) {
      if (diag) diag.push({ intento: it.nombre, http: 'excepción', id: '', respuesta: String(e.message).slice(0, 180) });
    }
  }
  return '';
}

/** Saca el itemId de una respuesta de búsqueda del catálogo público. */
function _vtexItemDeBusqueda(texto, refId) {
  var arr = JSON.parse(texto || '[]');
  if (!arr || !arr.length) return '';
  for (var p = 0; p < arr.length; p++) {
    var items = arr[p].items || [];
    for (var k = 0; k < items.length; k++) {
      var refs = items[k].referenceId || [];
      for (var z = 0; z < refs.length; z++) {
        if (String(refs[z].Value).trim() === String(refId).trim()) return String(items[k].itemId);
      }
    }
  }
  // sin coincidencia exacta de refId: si la búsqueda trajo un solo SKU, es ese
  if (arr.length === 1 && arr[0].items && arr[0].items.length === 1) return String(arr[0].items[0].itemId);
  return '';
}

/**
 * Plan B que no depende del catálogo: los pedidos de OnCity traen el skuId y el
 * refId juntos. Recorre los pedidos recientes y completa los ids que falten.
 * Sirve para todo artículo que se haya vendido alguna vez.
 */
function APRENDER_IDS_DE_PEDIDOS(paginas) {
  var mapa = {};   // refId → skuId
  var page = 1;
  var tope = Number(paginas) || 5;
  while (page <= tope) {
    var r = _vtexFetch('/api/oms/pvt/orders?per_page=100&page=' + page + '&orderBy=creationDate,desc');
    if (r.getResponseCode() !== 200) break;
    var lista = (JSON.parse(r.getContentText()) || {}).list || [];
    if (!lista.length) break;
    for (var i = 0; i < lista.length; i++) {
      var d = _vtexFetch('/api/oms/pvt/orders/' + encodeURIComponent(lista[i].orderId));
      if (d.getResponseCode() !== 200) continue;
      var items = (JSON.parse(d.getContentText()) || {}).items || [];
      items.forEach(function (it) {
        var ref = String(it.refId || '').trim();
        if (ref && it.id) mapa[ref] = String(it.id);
      });
    }
    page++;
  }
  Logger.log('Pares refId→skuId aprendidos de los pedidos: %s', JSON.stringify(mapa));

  var sheet = _sheet(SH.SKUS);
  var col = _colValues(sheet, 1);
  var rels = _skuRelations();
  var completados = 0;
  Object.keys(rels).forEach(function (sku) {
    var rel = rels[sku];
    if (rel.oncity_sku_id) return;
    var id = mapa[rel.oncity_refid];
    if (!id) return;
    var idx = col.indexOf(sku);
    if (idx !== -1) { _skuSetOncity(sheet, idx + 2, rel.oncity_refid, id); completados++; }
  });
  // Qué quedó sin resolver: son artículos que nunca se vendieron en OnCity.
  var faltan = [];
  var rels2 = _skuRelations();
  Object.keys(rels2).forEach(function (sku) {
    if (!rels2[sku].oncity_sku_id) faltan.push(sku + ' (refId ' + rels2[sku].oncity_refid + ')');
  });
  Logger.log('Relaciones completadas con id de VTEX: %s', completados);
  Logger.log('Con id listo: %s de %s', Object.keys(rels2).length - faltan.length, Object.keys(rels2).length);
  if (faltan.length) {
    Logger.log('Sin id (nunca se vendieron en OnCity, o no están publicados): %s', faltan.join(', '));
    Logger.log('  → Se pueden completar a mano: columna oncity_sku_id de RelacionesSKU, o desde la pantalla de SKUs.');
  }
  return { aprendidos: Object.keys(mapa).length, completados: completados, sin_id: faltan };
}

/** Escribe la cantidad disponible de un SKU en el depósito de VTEX. */
function vtexUpdateStock(skuId, warehouseId, quantity) {
  var path = '/api/logistics/pvt/inventory/skus/' + encodeURIComponent(skuId) +
             '/warehouses/' + encodeURIComponent(warehouseId);
  var payload = JSON.stringify({
    unlimitedQuantity: false,
    dateUtcOnBalanceSystem: null,
    quantity: Math.max(0, Math.round(quantity))
  });
  for (var intento = 0; intento <= 2; intento++) {
    try {
      var r = _vtexFetch(path, { method: 'put', contentType: 'application/json', payload: payload });
      var code = r.getResponseCode();
      if (code >= 200 && code < 300) return [true, String(code)];
      if ([429, 500, 502, 503, 504].indexOf(code) !== -1 && intento < 2) {
        Utilities.sleep(2000 * (intento + 1)); continue;
      }
      return [false, 'HTTP ' + code + ': ' + r.getContentText().slice(0, 200)];
    } catch (e) {
      if (intento < 2) { Utilities.sleep(2000 * (intento + 1)); continue; }
      return [false, 'excepción: ' + e.message];
    }
  }
  return [false, 'agotados los reintentos'];
}

/** Guarda refId/skuId de OnCity en la fila de la relación. */
function _skuSetOncity(sheet, fila, refid, skuId) {
  sheet.getRange(fila, 7, 1, 2).setValues([[refid, skuId]]);
}

/**
 * Resuelve los skuId de VTEX que falten y los cachea en la hoja, para no
 * volver a preguntarle al catálogo en cada sincronización.
 */
function _oncityResolverIds(rels) {
  var sheet = _sheet(SH.SKUS);
  var col = _colValues(sheet, 1);
  var resueltos = 0;
  Object.keys(rels).forEach(function (sku) {
    var rel = rels[sku];
    if (rel.oncity_sku_id) return;
    var id = vtexSkuIdByRef(rel.oncity_refid);
    rel.oncity_sku_id = id;
    var idx = col.indexOf(sku);
    if (idx !== -1) _skuSetOncity(sheet, idx + 2, rel.oncity_refid, id);
    if (id) resueltos++;
  });
  return resueltos;
}

/** Prueba manual desde la app: conexión, depósitos y traducción de un refId. */
function apiOncityTest() {
  var ping = vtexPing();
  var out = { conexion: { ok: ping[0], detalle: ping[1] }, depositos: [], muestra: [] };
  if (!ping[0]) return out;
  out.depositos = vtexWarehouses();
  var rels = _skuRelations();
  var skus = Object.keys(rels).slice(0, 5);
  skus.forEach(function (sku) {
    var rel = rels[sku];
    var id = rel.oncity_sku_id || vtexSkuIdByRef(rel.oncity_refid);
    out.muestra.push({ sku_tango: sku, refid: rel.oncity_refid, sku_id: id || '(no encontrado)' });
  });
  return out;
}

/* ═══════════════ HELPERS DE SHEETS ═══════════════ */

function _sheet(name) {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!s) throw new Error('Falta la pestaña "' + name + '": ejecutá SETUP');
  return s;
}

function _ensureSheet(ss, name, headers) {
  var s = ss.getSheetByName(name) || ss.insertSheet(name);
  if (s.getLastRow() === 0) {
    s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}

function _appendRow(name, row) { _sheet(name).appendRow(row); }

function _colValues(sheet, col) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, col, last - 1, 1).getValues()
    .map(function (r) { return String(r[0]); });
}

/** Lee las últimas `limit` filas como objetos {encabezado: valor}. */
function _readRows(name, limit) {
  var sheet = _sheet(name);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var start = limit ? Math.max(2, last - limit + 1) : 2;
  var data = sheet.getRange(start, 1, last - start + 1, headers.length).getValues();
  return data.map(function (row) {
    var o = {};
    headers.forEach(function (h, i) {
      var v = row[i];
      o[String(h)] = (v instanceof Date)
        ? Utilities.formatDate(v, 'America/Argentina/Buenos_Aires', 'yyyy-MM-dd HH:mm:ss')
        : v;
    });
    return o;
  });
}

function _sentIds() {
  var out = {};
  _colValues(_sheet(SH.SENT), 1).forEach(function (id) { out[id] = true; });
  return out;
}

/** Fila de OrdenesEnviadas con todo lo que se le mandó a Tango. */
function _filaSent(id, reg, ts) {
  reg = reg || {};
  return [id, reg.suborder_id || '', ts, reg.fecha_compra || '',
          reg.cliente || '', reg.documento || '', reg.cuil || '', reg.email || '',
          (reg.total === undefined || reg.total === null) ? '' : reg.total,
          reg.items || '', reg.origen || 'csv', 'pendiente', '', '', ''];
}

/**
 * Prepara una planilla que YA existe para el ingreso de órdenes por API:
 * agrega las columnas nuevas de OrdenesEnviadas y las claves de configuración
 * que falten. Es idempotente: se puede correr las veces que quieras y no toca
 * los datos que ya están.
 */
function MIGRAR_ORDENES_API() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Columnas nuevas en OrdenesEnviadas
  var s = ss.getSheetByName(SH.SENT);
  if (!s) {
    s = _ensureSheet(ss, SH.SENT, COLS_SENT);
  } else {
    var ancho = Math.max(s.getLastColumn(), 1);
    var heads = s.getRange(1, 1, 1, ancho).getValues()[0]
                 .map(function (h) { return String(h).trim(); });
    // La hoja vieja tenía solo [order_id, fecha_hora]. La fecha estaba en la
    // columna 2 y ahora va en la 3, así que la movemos antes de renombrar nada.
    var esVieja = heads.length <= 2 && heads[1] === 'fecha_hora';
    if (esVieja && s.getLastRow() > 1) {
      var n = s.getLastRow() - 1;
      var fechas = s.getRange(2, 2, n, 1).getValues();
      s.getRange(2, 2, n, 1).clearContent();
      s.getRange(2, 3, n, 1).setValues(fechas);
      s.getRange(2, 11, n, 1).setValue('csv');           // origen
      s.getRange(2, 12, n, 1).setValue('pendiente');     // estado_facturacion
    }
    COLS_SENT.forEach(function (h, i) {
      if (String(heads[i] || '').trim() !== h) {
        s.getRange(1, i + 1).setValue(h).setFontWeight('bold');
      }
    });
    s.setFrozenRows(1);
  }

  // 2. Claves de configuración que falten
  var cfg = ss.getSheetByName(SH.CONFIG);
  if (cfg) {
    var existentes = _colValues(cfg, 1);
    DEFAULT_CONFIG.forEach(function (row) {
      if (existentes.indexOf(row[0]) === -1) cfg.appendRow(row);
    });
  }

  log_('sistema', 'sistema', 'Migración de órdenes por API aplicada', 'ok', '');
  return 'Listo. OrdenesEnviadas quedó con las columnas nuevas y la configuración ' +
         'de la API de Frávega. Las órdenes viejas quedaron marcadas como origen=csv.';
}

function _prop(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function _now() {
  return Utilities.formatDate(new Date(), 'America/Argentina/Buenos_Aires',
                              'yyyy-MM-dd HH:mm:ss');
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
