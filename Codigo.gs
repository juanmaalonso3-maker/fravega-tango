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
  VTEX_APP_TOKEN: 'PPUAHFRMQHAHDCSTDANVNXOPAMMOQBZXXVCGOQGPDQBDYQFRIVRXRSOQRINKZZFHBVWZTINNOCZSNLTZJTNUDJJOFPWBZUKABGRTRRSHSLRFFGFZOKKXMQYSJTZUBPEC',
  // Frávega también corre sobre VTEX: los pedidos NO salen del Seller Center
  // (esa API nos devolvía 401) sino de la Orders API de VTEX, con estas
  // credenciales propias. El Seller Center se sigue usando para el stock.
  // El nombre de cuenta sale del propio AppKey: vtexappkey-{cuenta}-XXXXXX.
  FRAVEGA_VTEX_ACCOUNT: 'fravegasellerprod1380',
  FRAVEGA_VTEX_APP_KEY: 'vtexappkey-fravegasellerprod1380-UETFEE',
  FRAVEGA_VTEX_APP_TOKEN: 'IRNRUTGGUCUGSLHTRONNXBBBURFFHVIAKVXGLXIBCMNENIHCZJPBYDXTIDRMADTJIHWRTEJSGSUEQFHYQNOVECIIUZDLUCUTKOAPTTJHIDOMDHHHGFIHFEODMCUCYCQB'
};

/**
 * Los dos marketplaces corren sobre VTEX, cada uno con su cuenta y su
 * configuración. Todo el módulo de pedidos trabaja con este descriptor, así
 * que agregar un tercer canal mañana es agregar una entrada acá.
 *
 *   props     → dónde están las credenciales en Script Properties
 *   prefijo   → prefijo de sus claves en la hoja Config
 *   relRef    → columna de RelacionesSKU que matchea el refId de sus pedidos
 *   relId     → columna con el id interno de VTEX (si la hay)
 */
var CANALES = {
  fravega: {
    nombre: 'Frávega',
    props: { account: 'FRAVEGA_VTEX_ACCOUNT', key: 'FRAVEGA_VTEX_APP_KEY', token: 'FRAVEGA_VTEX_APP_TOKEN' },
    prefijo: 'fvtex_',
    relRef: 'refid',
    relId: ''
  },
  oncity: {
    nombre: 'OnCity',
    props: { account: 'VTEX_ACCOUNT', key: 'VTEX_APP_KEY', token: 'VTEX_APP_TOKEN' },
    prefijo: 'oncity_',
    relRef: 'oncity_refid',
    relId: 'oncity_sku_id'
  }
};

function _canal(nombre) {
  var c = CANALES[String(nombre || '').toLowerCase()];
  if (!c) throw new Error('Canal desconocido: ' + nombre);
  return c;
}

/**
 * Versión del backend. El index.html tiene la suya y las compara al arrancar:
 * si no coinciden, avisa en pantalla. Es para no volver a perder tiempo cuando
 * el código está pegado pero la implementación quedó en una versión vieja, o
 * cuando GitHub Pages todavía sirve el HTML anterior desde la caché.
 * SUBIR ESTE NÚMERO cada vez que cambien las acciones del doPost.
 */
var APP_VERSION = '2026-08-24.11';

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
                 'facturada_en', 'canal'];

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
  // ── Ingreso de órdenes de OnCity (VTEX OMS) ─────────────────────────────
  ['oncity_estados', 'ready-for-handling', 'Estados de VTEX a importar (separados por coma)'],
  ['oncity_desde_fecha', '', 'No traer pedidos anteriores a esta fecha (aaaa-mm-dd). Vacío = usar los días de abajo'],
  ['oncity_dias_atras', '60', 'Ventana de búsqueda hacia atrás (días)'],
  ['oncity_page_size', '50', 'Pedidos por página de VTEX'],
  ['oncity_orders_pause_ms', '300', 'Pausa entre consultas de detalle a VTEX (ms)'],
  ['oncity_max_detalle', '120', 'Máximo de detalles por ejecución'],
  ['oncity_precio_divisor', '100', 'VTEX devuelve centavos: dividir por 100'],
  ['oncity_facturar_envio', '0', 'Sumar el costo de envío al total'],
  ['oncity_espera_min', '0', 'Minutos de antigüedad mínima del pedido (OnCity no lo necesita)'],
  ['oncity_id_field', 'auto', 'Nro de Orden: auto | orderId | marketplaceOrderId'],
  ['oncity_quitar_prefijo', '', 'Prefijo a sacarle al orderId (OnCity no necesita)'],
  ['oncity_ignorar', '', 'Pedidos que no hay que traer nunca (separados por coma)'],
  ['oncity_sale_condition', '01', 'Condición de venta de Tango para OnCity'],
  ['oncity_counterfoil', '', 'Talonario de pedido para OnCity (vacío = el mismo que Frávega)'],
  ['oncity_invoice_counterfoil', '', 'Talonario de factura para OnCity (vacío = el mismo que Frávega)'],
  ['oncity_orders_warehouse', '', 'Depósito de pedidos para OnCity (vacío = el mismo que Frávega)'],
  ['oncity_seller_code', '', 'Vendedor para OnCity (vacío = el mismo que Frávega)'],
  // ── Pedidos de Frávega por VTEX (reemplaza al Seller Center, que da 401) ──
  ['fvtex_estados', 'ready-for-handling,handling', 'Estados de VTEX a importar (separados por coma)'],
  ['fvtex_desde_fecha', '', 'No traer pedidos anteriores a esta fecha (aaaa-mm-dd)'],
  ['fvtex_dias_atras', '90', 'Ventana de búsqueda hacia atrás (días)'],
  ['fvtex_page_size', '50', 'Pedidos por página de VTEX'],
  ['fvtex_orders_pause_ms', '300', 'Pausa entre consultas de detalle (ms)'],
  ['fvtex_max_detalle', '120', 'Máximo de detalles por ejecución'],
  ['fvtex_precio_divisor', '100', 'VTEX devuelve centavos: dividir por 100'],
  ['fvtex_facturar_envio', '0', 'Sumar el costo de envío al total (0 con Frávega Envíos)'],
  ['fvtex_espera_min', '90', 'Minutos de antigüedad mínima del pedido (Envío Pack necesita 90)'],
  ['fvtex_id_field', 'auto', 'Nro de Orden: auto | orderId | marketplaceOrderId'],
  ['fvtex_quitar_prefijo', 'FVG-', 'Prefijo a sacarle al orderId de VTEX para que coincida con el Nro de Orden del CSV'],
  // Pedidos que VTEX sigue mostrando en "handling" pero que NO hay que mandar a
  // Tango. Verificado contra el CSV del 24/08: cuatro figuran como Facturada y
  // seis ni siquiera aparecen en el reporte de Frávega. Quedan trabados porque
  // la factura se sube por planilla al seller center y eso no mueve el estado
  // en VTEX. Sin esta lista reaparecen en cada búsqueda.
  ['fvtex_ignorar',
   'v92800253frvg-02,v92301597frvg-01,v92231043frvg-01,v91950395frvg-01,' +
   'v92387730frvg-02,v92039990frvg-01,v92031720frvg-02,v91729694frvg-01,' +
   'v91647562frvg-02,v90875662frvg-02',
   'Pedidos que no hay que traer nunca (separados por coma)'],
  // ── Ingreso automático de órdenes ───────────────────────────────────────
  ['orders_auto_enabled', '0', 'Traer y enviar las órdenes a Tango automáticamente'],
  ['orders_auto_hours', '8,11,14,17,20', 'Horas del día para importar órdenes (0-23, separadas por coma)'],
  ['orders_auto_canales', 'fravega,oncity', 'Canales que entran en la corrida automática'],
  ['orders_auto_max', '80', 'Si una corrida encuentra más pedidos que esto, NO envía y avisa'],
  ['orders_auto_email', '', 'Email para el aviso de cada corrida (vacío = sin aviso)'],
  ['orders_auto_email_siempre', '0', 'Avisar siempre (1) o solo cuando hay algo para revisar (0)'],
  ['invoices_match_importe', '1', 'Usar también el importe para matchear facturas'],
  ['invoices_tolerancia_importe', '1', 'Diferencia máxima de importe aceptada (en pesos)'],
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

/**
 * Crea/actualiza los triggers de stock y de órdenes según la configuración.
 * La app la llama sola al guardar Configuración; también se puede correr a mano.
 */
function configurarTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'syncProgramada' || f === 'ordenesProgramadas') ScriptApp.deleteTrigger(t);
  });

  _crearTriggersHorarios('syncProgramada', getConfig('scheduler_hours'));

  // Las órdenes solo se agendan si la automatización está prendida: así no
  // quedan triggers corriendo mientras se prueba la integración.
  if (getConfig('orders_auto_enabled') === '1') {
    _crearTriggersHorarios('ordenesProgramadas', getConfig('orders_auto_hours'));
  }
}

function _crearTriggersHorarios(handler, horasTxt) {
  String(horasTxt).split(',').forEach(function (h) {
    h = parseInt(String(h).trim(), 10);
    if (!isNaN(h) && h >= 0 && h <= 23) {
      ScriptApp.newTrigger(handler).timeBased().everyDays(1).atHour(h).create();
    }
  });
}

function syncProgramada() {
  if (getConfig('scheduler_enabled') !== '1') return;
  runStockSync('scheduler');
}

/** Handler del trigger horario de órdenes. */
function ordenesProgramadas() {
  if (getConfig('orders_auto_enabled') !== '1') return;
  runOrdersImport('scheduler');
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

/**
 * EJECUTAR UNA VEZ desde el editor después de pegar esta versión.
 *
 * Fuerza en la hoja Config los estados de VTEX que hay que traer de Frávega.
 * Hace falta porque la app lee lo que hay en la hoja, NO lo que dice
 * DEFAULT_CONFIG: cambiar el código solo afecta a una instalación nueva.
 *
 * Por qué estos dos estados: verificado contra el CSV de órdenes del 24/08.
 * De las órdenes que Frávega marca como "Pendiente" de facturación, unas están
 * en "ready-for-handling" y la mayoría en "handling" ("Preparando Entrega"),
 * porque el backoffice de Frávega Envíos les hace el start-handling por su
 * cuenta. Filtrar solo por ready-for-handling dejaba afuera casi todas.
 *
 * Los otros estados que existen y NO se traen:
 *   invoiced                   → ya facturada (en el CSV figura "Facturada")
 *   canceled                   → cancelada
 *   waiting-ffmt-authorization → todavía no autorizada por fulfillment
 */
function ACTUALIZAR_ESTADOS_VTEX() {
  setConfig('fvtex_estados', 'ready-for-handling,handling');
  setConfig('fvtex_dias_atras', '90');
  log_('sistema', 'configuracion',
       'Estados de Frávega actualizados: ready-for-handling + handling', 'ok', '');
  return 'Listo: Frávega ahora trae ready-for-handling y handling, con ventana de 90 días.';
}

/**
 * EJECUTAR DESDE EL EDITOR para dejar la automatización de órdenes escrita y
 * agendada, sin depender de la pantalla de Configuración.
 *
 * Cambiá los valores de acá abajo si querés otros horarios o canales, guardá,
 * y ejecutá la función. Al terminar deja en el registro cuántos horarios
 * quedaron realmente agendados en Google, que es la prueba de que está armado.
 */
function CONFIGURAR_AUTOMATICO() {
  var VALORES = {
    orders_auto_enabled: '1',                    // '0' para apagarlo
    orders_auto_hours: '8,11,14,17,20',           // horas del día
    orders_auto_canales: 'fravega,oncity',        // canales que entran
    orders_auto_max: '80',                        // tope de seguridad por corrida
    orders_auto_email: 'juan.alonso@bitek.com.ar',
    orders_auto_email_siempre: '0'                // '1' = resumen en cada corrida
  };

  Object.keys(VALORES).forEach(function (k) { setConfig(k, VALORES[k]); });
  configurarTriggers();

  var agendados = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    agendados.push(t.getHandlerFunction());
  });
  var ordenes = agendados.filter(function (f) { return f === 'ordenesProgramadas'; }).length;
  var stock = agendados.filter(function (f) { return f === 'syncProgramada'; }).length;

  Logger.log('── Configuración escrita en la hoja ──');
  Object.keys(VALORES).forEach(function (k) {
    Logger.log('   %s = %s', k, getConfig(k));
  });
  Logger.log('');
  Logger.log('── Horarios agendados en Google ──');
  Logger.log('   órdenes (ordenesProgramadas): %s', ordenes);
  Logger.log('   stock   (syncProgramada)    : %s', stock);
  Logger.log('');
  Logger.log(ordenes > 0
    ? '✅ Listo: las órdenes se van a traer solas a las ' + VALORES.orders_auto_hours + ' hs.'
    : '⚠️ No quedó ningún horario agendado. Revisá que orders_auto_enabled sea 1.');

  log_('sistema', 'configuracion', 'Automatización de órdenes configurada', 'ok',
       'horas=' + VALORES.orders_auto_hours + ' canales=' + VALORES.orders_auto_canales +
       ' triggers=' + ordenes);

  return { horarios_ordenes: ordenes, horarios_stock: stock, valores: VALORES };
}

/**
 * Apaga la automatización de órdenes y borra sus horarios.
 * El stock sigue sincronizándose como siempre.
 */
function APAGAR_AUTOMATICO() {
  setConfig('orders_auto_enabled', '0');
  configurarTriggers();
  Logger.log('Automatización de órdenes apagada. El stock sigue andando.');
  return 'Apagado.';
}

/* ═══════════════ API HTTP (doPost) ═══════════════ */

function doGet() {
  return _json({ ok: true, servicio: 'Plataforma Tango-Fravega',
                 version: APP_VERSION, hora: _now() });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return _json({ error: 'JSON inválido' }); }

  var action = req.action || '';
  try {
    // Login: única acción sin token de sesión
    if (action === 'login') return _json(login(req.credential));
    // Sin sesión: sirve para que el frontend verifique que está hablando con
    // la versión del backend que le corresponde.
    if (action === 'version') return _json({ ok: true, data: { version: APP_VERSION } });

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
      case 'invoices.pendientes':out = apiInvoicesPendientes(p.canal || ''); break;
      case 'invoices.fromHistory': out = apiInvoicesFromHistory(user, p.facturas); break;
      case 'invoices.history':   out = _readRows(SH.INVOICES, 50).reverse(); break;
      // ── OnCity (VTEX) ──
      case 'vtex.orders.preview': out = apiVtexOrdersPreview(user, p); break;
      case 'vtex.orders.send':    out = apiVtexOrdersSend(user, p); break;
      case 'vtex.test':           out = apiVtexTest(p.canal); break;
      case 'vtex.orders.ignore':  out = apiVtexIgnorar(user, p); break;
      case 'orders.autoStatus':   out = apiOrdersAutoStatus(); break;
      case 'orders.autoRun':      out = apiOrdersAutoRun(user); break;
      case 'oncity.invoices':     out = apiOncityInvoices(user, p); break;
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
      default: throw new Error('Acción desconocida: ' + action +
        '. El backend desplegado es la versión ' + APP_VERSION + ' y no conoce esa acción: ' +
        'seguramente el index.html y la implementación de Apps Script no están en la misma ' +
        'versión. Revisá que hayas hecho Implementar → Nueva versión, y recargá la página ' +
        'con Ctrl+Shift+R.');
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
  return _proximaCorrida(getConfig('scheduler_hours') || '7,19');
}

/** Próxima corrida a partir de una lista de horas "8,11,14". */
function _proximaCorrida(horasTxt) {
  var horas = String(horasTxt).split(',')
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
        'funcionando para stock, así que no es un problema de configuración. ' +
        'Respuesta de Frávega: ' + res.error);
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

/* ═══════════════ MÓDULO PEDIDOS POR VTEX (Frávega y OnCity) ═══════════════
 * Los dos marketplaces corren sobre VTEX, así que comparten todo el módulo.
 * Cambia la cuenta, las credenciales y la configuración de Tango; la mecánica
 * es idéntica:
 *
 *   1. GET /api/oms/pvt/orders?f_status=ready-for-handling → los pedidos
 *      listos para preparar, que son los que hay que facturar.
 *   2. GET /api/oms/pvt/orders/{orderId} → el detalle con cliente, domicilio
 *      e ítems.
 *   3. Se arma el payload de Tango y se manda por el /order/batch de siempre.
 *
 * COSAS DE VTEX QUE HAY QUE TENER EN CUENTA, verificadas contra pedidos reales
 * de OnCity:
 *   · Los importes vienen en CENTAVOS (2137036 = $21.370,36).
 *   · El orderId (RMS-1655781718593-01) es el mismo texto que usa la plantilla
 *     de facturación, así que sirve como clave para cerrar el circuito.
 *   · Viene el DNI sin enmascarar y también el teléfono.
 *   · El orderId tiene demasiados dígitos para el PaymentID de Tango: se usa
 *     "sequence", que es un entero corto y único.
 *
 * IMPORTANTE (documentación de Frávega): los sellers con Frávega Envíos NO
 * deben ejecutar "start-handling" por API, porque eso lo hace solo el backoffice
 * de Frávega Envíos al procesar el pedido. Este módulo solo LEE pedidos, nunca
 * cambia su estado, así que no interfiere con ese circuito.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Valores por defecto tomados del código, indexados por clave. */
var _DEFAULTS_CACHE = null;
function _defaultConfig(clave) {
  if (!_DEFAULTS_CACHE) {
    _DEFAULTS_CACHE = {};
    DEFAULT_CONFIG.forEach(function (r) { _DEFAULTS_CACHE[r[0]] = r[1]; });
  }
  return _DEFAULTS_CACHE[clave];
}

/**
 * Lee una clave de config del canal.
 * Orden de búsqueda: hoja Config → DEFAULT_CONFIG del código → respaldo.
 *
 * El paso del medio es importante: cuando se agrega una clave nueva al código,
 * la hoja Config no la tiene hasta que se corre MIGRAR_ORDENES_API(). Sin ese
 * respaldo, la clave nueva quedaba vacía y la funcionalidad no se activaba, sin
 * ningún error visible. Fue exactamente lo que pasó con fvtex_quitar_prefijo.
 */
function _cfgCanalVal(cfg, canal, clave, respaldo) {
  var c = _canal(canal);
  var k = c.prefijo + clave;
  var v = cfg[k];
  if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  var d = _defaultConfig(k);
  if (d !== undefined && String(d).trim() !== '') return String(d).trim();
  return respaldo === undefined ? '' : respaldo;
}

/** Config de Tango para un canal, con los valores generales como respaldo. */
function _cfgCanal(cfg, canal) {
  return {
    canal: canal,
    nombre: _canal(canal).nombre,
    orders_counterfoil: _cfgCanalVal(cfg, canal, 'counterfoil', cfg.orders_counterfoil),
    orders_invoice_counterfoil: _cfgCanalVal(cfg, canal, 'invoice_counterfoil', cfg.orders_invoice_counterfoil),
    orders_warehouse_code: _cfgCanalVal(cfg, canal, 'orders_warehouse', cfg.orders_warehouse_code),
    orders_seller_code: _cfgCanalVal(cfg, canal, 'seller_code', cfg.orders_seller_code),
    orders_sale_condition: _cfgCanalVal(cfg, canal, 'sale_condition', cfg.orders_sale_condition),
    orders_iva_category: cfg.orders_iva_category,
    orders_document_type: cfg.orders_document_type,
    orders_payment_method: cfg.orders_payment_method,
    divisor: parseFloat(_cfgCanalVal(cfg, canal, 'precio_divisor', '100')) || 100,
    facturar_envio: _cfgCanalVal(cfg, canal, 'facturar_envio', '0') === '1',
    estados: String(_cfgCanalVal(cfg, canal, 'estados', 'ready-for-handling'))
      .split(',').map(function (s) { return s.trim(); }).filter(String),
    desde_fecha: _cfgCanalVal(cfg, canal, 'desde_fecha', ''),
    dias_atras: parseInt(_cfgCanalVal(cfg, canal, 'dias_atras', '60'), 10) || 60,
    page_size: Math.min(100, parseInt(_cfgCanalVal(cfg, canal, 'page_size', '50'), 10) || 50),
    pausa: Math.max(0, parseInt(_cfgCanalVal(cfg, canal, 'orders_pause_ms', '300'), 10) || 0),
    max_detalle: parseInt(_cfgCanalVal(cfg, canal, 'max_detalle', '120'), 10) || 120,
    espera_min: Math.max(0, parseInt(_cfgCanalVal(cfg, canal, 'espera_min', '0'), 10) || 0),
    id_field: _cfgCanalVal(cfg, canal, 'id_field', 'auto'),
    quitar_prefijo: _cfgCanalVal(cfg, canal, 'quitar_prefijo', ''),
    ignorar: String(_cfgCanalVal(cfg, canal, 'ignorar', ''))
      .split(',').map(function (x) { return x.trim(); }).filter(String)
  };
}

/** Índices de RelacionesSKU para traducir lo que viene en el pedido. */
function _indiceSkuCanal(canal, rels) {
  var c = _canal(canal);
  var porRef = {}, porSkuId = {};
  Object.keys(rels).forEach(function (s) {
    var ref = rels[s][c.relRef];
    if (ref) porRef[String(ref)] = s;
    if (c.relId && rels[s][c.relId]) porSkuId[String(rels[s][c.relId])] = s;
  });
  return { porRef: porRef, porSkuId: porSkuId };
}

/** Una página de pedidos de VTEX para un estado puntual. */
function vtexOrdersPage(canal, estado, pagina, c) {
  var desde;
  if (c.desde_fecha) {
    desde = new Date(String(c.desde_fecha) + 'T00:00:00Z');
    if (isNaN(desde.getTime())) desde = null;
  }
  if (!desde) desde = new Date(Date.now() - c.dias_atras * 86400000);

  // La espera (Envío Pack) se aplica como tope superior de la fecha de compra.
  var hasta = new Date(Date.now() - c.espera_min * 60 * 1000);

  var path = '/api/oms/pvt/orders?per_page=' + c.page_size + '&page=' + pagina +
             '&orderBy=creationDate,desc' +
             '&f_status=' + encodeURIComponent(estado) +
             '&f_creationDate=' + encodeURIComponent(
               'creationDate:[' + _isoUtc(desde) + ' TO ' + _isoUtc(hasta) + ']');

  var r = _vtexFetch(path, null, canal);
  var code = r.getResponseCode();
  if (code !== 200) {
    if (code === 401 || code === 403) {
      throw new Error('VTEX (' + _canal(canal).nombre + ') rechazó la lectura de pedidos ' +
        '(HTTP ' + code + '). La AppKey necesita permiso sobre OMS: en el admin de VTEX, ' +
        'Account Settings → Roles, agregarle "OMS full access" al rol de la AppKey. ' +
        'Si la cuenta la administra el marketplace, hay que pedírselo a ellos.');
    }
    throw new Error('VTEX /oms/orders HTTP ' + code + ': ' + r.getContentText().slice(0, 250));
  }
  return JSON.parse(r.getContentText() || '{}');
}

/** Detalle completo de un pedido de VTEX. */
function vtexOrderDetail(canal, orderId) {
  var r = _vtexFetch('/api/oms/pvt/orders/' + encodeURIComponent(orderId), null, canal);
  if (r.getResponseCode() !== 200) {
    throw new Error('VTEX detalle ' + orderId + ' HTTP ' + r.getResponseCode() + ': ' +
                    r.getContentText().slice(0, 200));
  }
  return JSON.parse(r.getContentText() || '{}');
}

/**
 * Saca el prefijo que VTEX le agrega al orderId.
 * En Frávega el pedido que en el CSV figura como "v92813856frvg-01" en VTEX es
 * "FVG-v92813856frvg-01". Sacarle el prefijo es lo que hace que:
 *   · no se dupliquen en Tango los pedidos ya cargados por CSV, y
 *   · la exportación de facturas siga agregando "FVG-" como siempre.
 */
function _sinPrefijo(id, prefijo) {
  var s = String(id || '');
  if (!prefijo) return s;
  return s.toUpperCase().indexOf(String(prefijo).toUpperCase()) === 0
    ? s.slice(String(prefijo).length) : s;
}

/**
 * Decide qué identificador usar como Nro de Orden en Tango.
 * VTEX da dos: orderId (RMS-1655781718593-01) y marketplaceOrderId
 * (1655781718593-01). Si ya hay pedidos cargados, se fija cuál de los dos
 * aparece en OrdenesEnviadas y usa ese, para no duplicar nada.
 */
function _elegirIdVtex(lista, c) {
  if (c.id_field === 'orderId' || c.id_field === 'marketplaceOrderId') return c.id_field;
  var sent = _sentIds();
  var hitsOrder = 0, hitsMkp = 0;
  lista.forEach(function (o) {
    if (o.orderId && sent[_sinPrefijo(o.orderId, c.quitar_prefijo)]) hitsOrder++;
    if (o.marketplaceOrderId && sent[String(o.marketplaceOrderId)]) hitsMkp++;
  });
  if (hitsMkp > hitsOrder) return 'marketplaceOrderId';
  return 'orderId';
}

/**
 * Payload de Tango a partir de un pedido de VTEX.
 * Devuelve [orden, skusSinRelacion, registro].
 */
function _buildOrderFromVtex(d, idOrden, idx, rels, c) {
  var div = c.divisor;
  var items = [], unmapped = [], totalItems = 0, resumen = [];

  (d.items || []).forEach(function (it) {
    var ref = String(it.refId || '').trim();
    var skuId = String(it.id || '').trim();
    var tango = idx.porRef[ref] || idx.porSkuId[skuId] || (rels[ref] ? ref : '');
    if (!tango) { unmapped.push(ref || skuId || '(sin refId)'); return; }

    var cant = Number(it.quantity) || 1;
    var unitCent = Number(it.sellingPrice);
    if (!isFinite(unitCent) || unitCent <= 0) unitCent = Number(it.price) || 0;
    var unit = Math.round((unitCent / div) * 100) / 100;
    totalItems += unit * cant;
    resumen.push(tango + ' x' + cant);

    items.push({
      ProductCode: ref || skuId,
      SKUCode: tango,
      Description: String(it.name || rels[tango].descripcion || '').slice(0, 400),
      Quantity: cant,
      UnitPrice: unit,
      DiscountPercentage: 0.0
    });
  });
  if (unmapped.length) return [null, unmapped, null];
  if (!items.length) return [null, ['(el pedido no trae ítems)'], null];

  var total = Math.round(totalItems * 100) / 100;
  var envio = 0;
  (d.totals || []).forEach(function (t) {
    if (String(t.id).toLowerCase() === 'shipping') envio = (Number(t.value) || 0) / div;
  });
  if (c.facturar_envio) total = Math.round((total + envio) * 100) / 100;

  // Aviso si nuestro total no coincide con el que informa VTEX.
  var totalVtex = Math.round((Number(d.value) || 0) / div * 100) / 100;
  var aviso = '';
  if (totalVtex > 0 && Math.abs(totalVtex - total) > 1) {
    aviso = 'VTEX informa un total de ' + totalVtex + ' y los ítems suman ' + total +
            (envio ? ' (envío: ' + envio + ')' : '');
  }

  var cli = d.clientProfileData || {};
  var sh = d.shippingData || {};
  var ad = sh.address || {};

  var nombre = _primero(cli.firstName);
  var apellido = _primero(cli.lastName);
  if (!nombre && !apellido) {
    var partido = _cleanName(_primero(d.clientName, ad.receiverName));
    nombre = partido[0]; apellido = partido[1];
  }
  var doc = _dni(_primero(cli.document, cli.corporateDocument));
  var email = _primero(cli.email);
  var tel = _primero(cli.phone);

  var calle = _primero(ad.street).slice(0, 30);
  var nro = _primero(ad.number);
  var compl = _primero(ad.complement);
  var ciudad = _primero(ad.city, ad.neighborhood).slice(0, 20);
  var prov = _provinceCode(_primero(ad.state));
  var cp = _primero(ad.postalCode);

  // El orderId tiene demasiados dígitos para el PaymentID de Tango (entero).
  // "sequence" es un número corto y único por pedido.
  var pagoId = parseInt(_primero(d.sequence).replace(/\D/g, ''), 10);
  if (!pagoId || pagoId > 2000000000) {
    var dg = String(idOrden).replace(/\D/g, '');
    pagoId = dg ? parseInt(dg.slice(-9), 10) : 1;
  }

  var ms = _fechaMs(d.creationDate);
  var fechaTango = ms
    ? Utilities.formatDate(new Date(ms), TZ_AR, "yyyy-MM-dd'T'HH:mm:ss")
    : _fechaTango(d.creationDate);

  var orden = {
    OrderID: String(idOrden), OrderNumber: String(idOrden),
    OrderCounterfoil: parseInt(c.orders_counterfoil, 10),
    InvoiceCounterfoil: parseInt(c.orders_invoice_counterfoil, 10),
    Date: fechaTango,
    Total: total, PaidTotal: total, FinancialSurcharge: 0.0,
    WarehouseCode: c.orders_warehouse_code, SellerCode: c.orders_seller_code,
    SaleConditionCode: c.orders_sale_condition,
    ValidateTotalWithPaidTotal: false, ValidateTotalWithItems: false,
    Customer: {
      CustomerID: /^\d+$/.test(doc) ? parseInt(doc, 10) : 1,
      Code: '000000',
      DocumentType: c.orders_document_type,
      DocumentNumber: doc,
      IVACategoryCode: c.orders_iva_category,
      User: String(idOrden),
      Email: email || (String(idOrden) + '@marketplace.com'),
      FirstName: nombre, LastName: apellido, BusinessName: _primero(cli.corporateName),
      Street: calle, HouseNumber: nro, Floor: '', Apartment: compl,
      City: ciudad, ProvinceCode: prov, PostalCode: cp,
      PhoneNumber1: tel, PhoneNumber2: ''
    },
    Shipping: {
      ShippingID: 1,
      Street: calle, HouseNumber: nro, Floor: '', Apartment: compl,
      City: ciudad, ProvinceCode: prov, PostalCode: cp,
      PhoneNumber1: tel, PhoneNumber2: ''
    },
    OrderItems: items, Payments: [],
    CashPayments: [{ PaymentID: pagoId,
                     PaymentMethod: c.orders_payment_method, PaymentTotal: total }]
  };

  var li = (sh.logisticsInfo || [])[0] || {};
  var registro = {
    order_id: String(idOrden),
    suborder_id: _primero(d.marketplaceOrderId),
    fecha_compra: ms ? Utilities.formatDate(new Date(ms), TZ_AR, 'yyyy-MM-dd HH:mm:ss') : '',
    cliente: (nombre + ' ' + apellido).trim(),
    documento: doc,
    cuil: '',
    email: email,
    total: total,
    items: resumen.join(' · '),
    origen: 'api',
    canal: c.canal,
    aviso: aviso,
    transportadora: _primero(li.deliveryCompany)
  };

  return [orden, [], registro];
}

/** Trae los pedidos de un canal y los deja listos para mandar a Tango. */
function apiVtexOrdersPreview(user, p) {
  p = p || {};
  var canal = String(p.canal || 'oncity').toLowerCase();
  var cfg = _configMap();
  var c = _cfgCanal(cfg, canal);
  var t0 = Date.now();

  var rels = _skuRelations();
  var idx = _indiceSkuCanal(canal, rels);
  var sent = _sentIds();

  var orders = [], registros = {}, nuevas = [],
      saltadas = [], excluidas = [], fallidas = [];
  var detalles = 0, truncada = false, totalListados = 0, campoId = '';
  var porEstado = {};   // cuántos pedidos vinieron de cada estado
  var ignorados = [];
  var setIgnorar = {};
  c.ignorar.forEach(function (x) { setIgnorar[x] = true; });

  for (var e = 0; e < c.estados.length && !truncada; e++) {
    var pagina = 1, paginas = 1;
    while (pagina <= paginas && !truncada) {
      var body = vtexOrdersPage(canal, c.estados[e], pagina, c);
      paginas = Number((body.paging || {}).pages || 1);
      var lista = body.list || [];
      totalListados += lista.length;
      porEstado[c.estados[e]] = (porEstado[c.estados[e]] || 0) +
        Number((body.paging || {}).total || lista.length) * (pagina === 1 ? 1 : 0);
      if (!lista.length) break;
      if (!campoId) campoId = _elegirIdVtex(lista, c);

      for (var i = 0; i < lista.length; i++) {
        var it = lista[i];
        var idOrden = (campoId === 'marketplaceOrderId')
          ? String(it.marketplaceOrderId || it.orderId || '')
          : _sinPrefijo(it.orderId || it.marketplaceOrderId || '', c.quitar_prefijo);
        if (!idOrden) continue;
        if (setIgnorar[idOrden]) { ignorados.push(idOrden); continue; }
        if (sent[idOrden]) { saltadas.push(idOrden); continue; }

        var limite = p.deadline || (t0 + 4.5 * 60 * 1000);
        if (detalles >= c.max_detalle || Date.now() > limite) { truncada = true; break; }

        var d;
        try { d = vtexOrderDetail(canal, it.orderId); detalles++; }
        catch (err) { fallidas.push({ orden: idOrden, error: err.message }); continue; }
        if (c.pausa) Utilities.sleep(c.pausa);

        var res = _buildOrderFromVtex(d, idOrden, idx, rels, c);
        if (res[1].length) {
          res[1].forEach(function (sku) {
            _pendingAdd(sku, c.nombre, 'Detectado en el pedido ' + idOrden + ' sin relación');
          });
          excluidas.push({ orden: idOrden, skus_sin_relacion: res[1] });
          continue;
        }

        orders.push(res[0]);
        registros[idOrden] = res[2];
        nuevas.push({
          orden: idOrden,
          cliente: res[2].cliente,
          documento: res[2].documento,
          fecha: res[2].fecha_compra,
          items: res[0].OrderItems.length,
          total: res[0].Total,
          transportadora: res[2].transportadora,
          estado: String(it.status || ''),
          aviso: res[2].aviso
        });
      }
      pagina++;
    }
  }

  log_(user.email, 'ordenes', 'Pedidos leídos de ' + c.nombre + ' (VTEX)', 'info',
       'estados=' + c.estados.join('+') + ' listados=' + totalListados +
       ' nuevas=' + nuevas.length + ' saltadas=' + saltadas.length +
       ' excluidas=' + excluidas.length + ' fallidas=' + fallidas.length +
       ' campo_id=' + campoId, Date.now() - t0);

  // Red de seguridad contra duplicados: si el historial tiene pedidos de este
  // canal pero NINGUNO de los que trajimos coincide, es casi seguro que el
  // formato del Nro de Orden no es el correcto (prefijo, campo equivocado).
  // Mandar así duplicaría en Tango todo lo ya cargado.
  var yaDelCanal = 0;
  _readRows(SH.SENT, 2000).forEach(function (r) {
    if (String(r.canal || 'fravega').toLowerCase() === canal) yaDelCanal++;
  });
  var alerta = '';
  if (yaDelCanal > 0 && saltadas.length === 0 && nuevas.length > 0) {
    alerta = 'Hay ' + yaDelCanal + ' pedido(s) de ' + c.nombre + ' en el historial, pero ' +
      'ninguno de los ' + nuevas.length + ' que se trajeron coincide. Revisá el formato del ' +
      'Nro de Orden (prefijo "' + (c.quitar_prefijo || 'ninguno') + '", campo "' + campoId +
      '") contra el que usás para facturar ANTES de enviar: si no coincide, Tango va a ' +
      'recibir duplicados.';
  }

  return {
    canal: canal, nombre: c.nombre, alerta: alerta, ya_del_canal: yaDelCanal,
    estados: c.estados, por_estado: porEstado,
    listados: totalListados, campo_id: campoId || c.id_field,
    orders: orders, registros: registros,
    nuevas: nuevas, saltadas: saltadas, ignorados: ignorados,
    excluidas: excluidas, fallidas: fallidas,
    truncada: truncada,
    condicion_venta: c.orders_sale_condition,
    talonario: c.orders_counterfoil,
    espera_min: c.espera_min
  };
}

/**
 * Agrega pedidos a la lista de ignorados del canal.
 * Sirve para sacarse de encima los que VTEX no mueve de estado: si no, vuelven
 * a aparecer en cada búsqueda.
 */
function apiVtexIgnorar(user, p) {
  p = p || {};
  var canal = String(p.canal || 'oncity').toLowerCase();
  var nuevas = (p.ordenes || []).map(function (x) { return String(x).trim(); }).filter(String);
  if (!nuevas.length) return { ok: true, total: 0 };

  var clave = _canal(canal).prefijo + 'ignorar';
  var actual = String(getConfig(clave) || '')
    .split(',').map(function (x) { return x.trim(); }).filter(String);
  var set = {};
  actual.forEach(function (x) { set[x] = true; });
  var agregadas = 0;
  nuevas.forEach(function (x) { if (!set[x]) { set[x] = true; actual.push(x); agregadas++; } });

  setConfig(clave, actual.join(','));
  log_(user.email, 'ordenes', 'Pedidos ignorados en ' + _canal(canal).nombre, 'warning',
       'agregados=' + agregadas + ' total=' + actual.length + ' · ' + nuevas.join(','));
  return { ok: true, agregadas: agregadas, total: actual.length };
}

/** Manda a Tango los pedidos ya armados de un canal. */
function apiVtexOrdersSend(user, p) {
  p = p || {};
  var canal = String(p.canal || 'oncity').toLowerCase();
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
  return _sendOrders(pendientes, user, p.archivo || ('API ' + _canal(canal).nombre),
                     null, registros);
}

/**
 * Prueba de conexión de un canal, para correr desde la pantalla de Órdenes.
 * No manda nada a Tango: consulta, muestra una muestra y verifica el mapeo.
 */
function apiVtexTest(canal) {
  canal = String(canal || 'oncity').toLowerCase();
  var cfg = _configMap();
  var c = _cfgCanal(cfg, canal);
  var out = { canal: canal, nombre: c.nombre, ok: false, mensaje: '',
              cuenta: _prop(_canal(canal).props.account),
              condicion_venta: c.orders_sale_condition,
              estados: c.estados, quitar_prefijo: c.quitar_prefijo,
              muestra: [], detalle_ok: false };

  // Consultamos TODOS los estados configurados, no solo el primero: si no, el
  // test decía "2 pedidos" mientras la búsqueda real traía 63.
  var lista = [], porEstado = {}, total = 0;
  for (var e = 0; e < c.estados.length; e++) {
    var body;
    try { body = vtexOrdersPage(canal, c.estados[e], 1, c); }
    catch (err) { out.mensaje = err.message; return out; }
    var n = Number((body.paging || {}).total || (body.list || []).length);
    porEstado[c.estados[e]] = n;
    total += n;
    lista = lista.concat(body.list || []);
  }
  out.ok = true;
  out.total = total;
  out.por_estado = porEstado;
  out.campo_id = _elegirIdVtex(lista, c);
  out.mensaje = 'Conexión OK · ' + total + ' pedido(s) pendientes';

  if (!lista.length) {
    out.mensaje += ' — no hay nada en la ventana configurada';
    return out;
  }

  var rels = _skuRelations();
  var idx = _indiceSkuCanal(canal, rels);

  var d = null;
  try { d = vtexOrderDetail(canal, lista[0].orderId); out.detalle_ok = true; }
  catch (e) { out.detalle_error = e.message; }

  lista.slice(0, 5).forEach(function (o) {
    out.muestra.push({
      orderId: _primero(o.orderId),
      nro_para_tango: _sinPrefijo(_primero(o.orderId), c.quitar_prefijo),
      marketplaceOrderId: _primero(o.marketplaceOrderId),
      cliente: _primero(o.clientName),
      fecha: _primero(o.creationDate),
      total: (Number(o.totalValue) || 0) / c.divisor,
      estado: _primero(o.status)
    });
  });

  if (d) {
    var cli = d.clientProfileData || {};
    var ad = (d.shippingData || {}).address || {};
    out.comprador = (_primero(cli.firstName) + ' ' + _primero(cli.lastName)).trim() +
      ' · doc ' + _primero(cli.document) + ' · tel ' + _primero(cli.phone);
    out.domicilio = _primero(ad.street) + ' ' + _primero(ad.number) + ', ' +
      _primero(ad.city) + ', ' + _primero(ad.state) + ' CP ' + _primero(ad.postalCode);
    out.total_detalle = (Number(d.value) || 0) / c.divisor;
    out.skus = (d.items || []).map(function (it) {
      var ref = String(it.refId || '');
      var t = idx.porRef[ref] || idx.porSkuId[String(it.id || '')] || (rels[ref] ? ref : '');
      return ref + (t ? (t === ref ? ' (= SKU Tango)' : ' → Tango ' + t) : ' ⚠ sin relación');
    }).join(' · ');
  }
  return out;
}

/* ═══════════════ CORRIDA AUTOMÁTICA DE ÓRDENES ═══════════════
 * Recorre los canales habilitados, trae los pedidos nuevos y los manda a Tango
 * sin que nadie toque nada. Es el mismo camino que usa el botón de la pantalla,
 * así que lo que ves ahí es exactamente lo que hace el trigger.
 *
 * Las tres protecciones que hacen que se pueda dejar desatendido:
 *
 *   1. OrdenesEnviadas → un pedido ya mandado nunca se reenvía.
 *   2. Lista de ignorados → los pedidos que VTEX no mueve de estado no vuelven.
 *   3. Tope por corrida (orders_auto_max) → si de golpe aparecen muchísimos
 *      pedidos, NO manda nada y avisa. Un número raro casi siempre significa
 *      que algo cambió del otro lado, y en ese caso es mejor frenar que
 *      escribir 300 pedidos en Tango.
 *
 * Además reparte el tiempo entre canales para no chocar con el límite de 6
 * minutos de Apps Script: lo que no llegue a entrar queda para la próxima.
 * ══════════════════════════════════════════════════════════════════════════ */

function runOrdersImport(disparadaPor) {
  var lock = LockService.getScriptLock();
  // Esperamos un rato: si justo está corriendo la sincronización de stock,
  // preferimos aguardar antes que saltear la corrida.
  if (!lock.tryLock(60000)) {
    log_(disparadaPor, 'ordenes', 'Corrida automática omitida', 'warning',
         'Había otra tarea en curso');
    return { resultado: 'omitida', mensaje: 'Ya hay otra tarea en curso' };
  }

  var t0 = Date.now();
  var inicio = _now();
  var cfg = _configMap();
  var canales = String(_cfgVal(cfg, 'orders_auto_canales'))
    .split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(String);
  var maxAuto = parseInt(_cfgVal(cfg, 'orders_auto_max'), 10) || 80;

  var res = {
    resultado: 'ok', inicio: inicio, por_canal: {},
    enviadas: [], rechazadas: [], excluidas: [], sin_relacion: [],
    frenada: false, errores: []
  };

  try {
    var vt = tangoVerify();
    if (!vt[0]) throw new Error('Token de Tango inválido: ' + vt[1]);

    for (var i = 0; i < canales.length; i++) {
      var canal = canales[i];
      // Repartimos lo que queda del presupuesto de tiempo entre los canales que
      // faltan, guardando 90 segundos para el envío a Tango.
      var restanteMs = (4.5 * 60 * 1000) - (Date.now() - t0);
      if (restanteMs < 30000) {
        res.errores.push('Se acabó el tiempo antes de procesar ' + canal +
                         '; entra en la próxima corrida');
        break;
      }
      var deadline = Date.now() + Math.floor(restanteMs / (canales.length - i));

      var prev;
      try {
        prev = apiVtexOrdersPreview({ email: disparadaPor }, { canal: canal, deadline: deadline });
      } catch (e) {
        res.errores.push(_canal(canal).nombre + ': ' + e.message);
        log_(disparadaPor, 'ordenes', 'Corrida automática: falló ' + canal, 'error', e.message);
        continue;
      }

      var det = {
        nombre: prev.nombre, leidos: prev.listados,
        nuevas: prev.nuevas.length, saltadas: prev.saltadas.length,
        ignorados: (prev.ignorados || []).length,
        excluidas: prev.excluidas.length, fallidas: prev.fallidas.length,
        enviadas: 0, rechazadas: 0, truncada: prev.truncada, frenada: false
      };

      // Los SKU sin relación necesitan que alguien los cargue a mano: van al aviso.
      prev.excluidas.forEach(function (x) {
        res.excluidas.push({ canal: canal, orden: x.orden, skus: x.skus_sin_relacion });
        x.skus_sin_relacion.forEach(function (sk) {
          if (res.sin_relacion.indexOf(sk) === -1) res.sin_relacion.push(sk);
        });
      });
      prev.fallidas.forEach(function (x) {
        res.errores.push(_canal(canal).nombre + ' · ' + x.orden + ': ' + x.error);
      });

      // ── El tope de seguridad ──
      if (prev.nuevas.length > maxAuto) {
        det.frenada = true;
        res.frenada = true;
        res.errores.push(_canal(canal).nombre + ': aparecieron ' + prev.nuevas.length +
          ' pedidos nuevos, más que el tope de ' + maxAuto +
          '. No se envió nada: revisalo a mano desde la pantalla de Ingreso de Órdenes.');
        log_(disparadaPor, 'ordenes', 'Corrida automática frenada por el tope', 'warning',
             canal + ' nuevas=' + prev.nuevas.length + ' tope=' + maxAuto);
        res.por_canal[canal] = det;
        continue;
      }

      if (prev.orders.length) {
        try {
          var env = _sendOrders(prev.orders, { email: disparadaPor },
                                'Automático · ' + prev.nombre, null, prev.registros);
          det.enviadas = env.enviadas.length;
          det.rechazadas = env.rechazadas.length;
          env.enviadas.forEach(function (id) { res.enviadas.push({ canal: canal, orden: id }); });
          env.rechazadas.forEach(function (r) {
            res.rechazadas.push({ canal: canal, orden: r.orden, error: r.error });
          });
        } catch (e) {
          res.errores.push(_canal(canal).nombre + ' al enviar a Tango: ' + e.message);
        }
      }
      res.por_canal[canal] = det;
    }

    if (res.rechazadas.length || res.errores.length) res.resultado = 'con observaciones';

    // Una fila por corrida en el historial, igual que una importación manual.
    var totalLeidos = 0, totalNuevas = 0;
    Object.keys(res.por_canal).forEach(function (k) {
      totalLeidos += res.por_canal[k].leidos || 0;
      totalNuevas += res.por_canal[k].nuevas || 0;
    });
    _appendRow(SH.ORDERS, [_now(), disparadaPor, 'Automático (' + canales.join('+') + ')',
                           totalLeidos, totalNuevas, totalNuevas,
                           res.enviadas.length, res.rechazadas.length,
                           JSON.stringify({ por_canal: res.por_canal,
                                            enviadas: res.enviadas.map(function (x) { return x.orden; }),
                                            rechazadas: res.rechazadas,
                                            excluidas: res.excluidas,
                                            errores: res.errores })]);

    log_(disparadaPor, 'ordenes', 'Corrida automática de órdenes',
         res.resultado === 'ok' ? 'ok' : 'warning',
         'enviadas=' + res.enviadas.length + ' rechazadas=' + res.rechazadas.length +
         ' excluidas=' + res.excluidas.length + ' errores=' + res.errores.length,
         Date.now() - t0);

    _avisarCorrida(cfg, res);
    return res;

  } catch (e) {
    res.resultado = 'falló';
    res.errores.push(e.message);
    log_(disparadaPor, 'ordenes', 'Corrida automática abortada', 'error', e.message,
         Date.now() - t0);
    _avisarCorrida(cfg, res);
    return res;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Aviso por mail. Por defecto solo escribe cuando hay algo para mirar
 * (rechazos, SKU sin relación, errores, o la corrida frenada por el tope):
 * un mail diario que dice "todo bien" se deja de leer a la semana.
 */
function _avisarCorrida(cfg, res) {
  var destino = String(_cfgVal(cfg, 'orders_auto_email')).trim();
  if (!destino) return;

  var hayQueMirar = res.rechazadas.length || res.excluidas.length ||
                    res.errores.length || res.frenada || res.resultado === 'falló';
  if (!hayQueMirar && _cfgVal(cfg, 'orders_auto_email_siempre') !== '1') return;

  var l = [];
  l.push('Corrida automática de órdenes — ' + res.inicio);
  l.push('Resultado: ' + res.resultado);
  l.push('');
  Object.keys(res.por_canal).forEach(function (k) {
    var d = res.por_canal[k];
    l.push(d.nombre + ':');
    l.push('  leídos: ' + d.leidos + ' · nuevos: ' + d.nuevas +
           ' · ya enviados: ' + d.saltadas + ' · ignorados: ' + d.ignorados);
    l.push('  enviados a Tango: ' + d.enviadas + ' · rechazados: ' + d.rechazadas);
    if (d.frenada) l.push('  ⚠ FRENADA por el tope de seguridad: no se envió nada.');
    if (d.truncada) l.push('  · se cortó por tiempo; el resto entra en la próxima corrida');
    l.push('');
  });

  if (res.sin_relacion.length) {
    l.push('SKU sin relación (hay que cargarlos en Relación de SKUs):');
    l.push('  ' + res.sin_relacion.join(', '));
    l.push('  Órdenes afectadas, que NO se enviaron:');
    res.excluidas.forEach(function (x) { l.push('   · ' + x.orden + ' → ' + x.skus.join(', ')); });
    l.push('');
  }
  if (res.rechazadas.length) {
    l.push('Rechazadas por Tango:');
    res.rechazadas.forEach(function (x) { l.push('   · ' + x.orden + ': ' + x.error); });
    l.push('');
  }
  if (res.errores.length) {
    l.push('Errores:');
    res.errores.forEach(function (x) { l.push('   · ' + x); });
    l.push('');
  }
  l.push('Enviadas: ' + res.enviadas.length);

  try {
    MailApp.sendEmail(destino,
      '[Tango ↔ Marketplaces] Órdenes: ' + res.enviadas.length + ' enviadas' +
      (hayQueMirar ? ' — hay algo para revisar' : ''),
      l.join('\n'));
  } catch (e) {
    log_('sistema', 'ordenes', 'No se pudo mandar el aviso por mail', 'warning', e.message);
  }
}

/** Estado de la automatización, para mostrarlo en la pantalla. */
function apiOrdersAutoStatus() {
  var cfg = _configMap();
  var hist = _readRows(SH.ORDERS, 100).filter(function (r) {
    return String(r.archivo || '').indexOf('Automático') === 0;
  });
  var habilitada = _cfgVal(cfg, 'orders_auto_enabled') === '1';
  var horas = _cfgVal(cfg, 'orders_auto_hours');

  // Contamos los triggers reales: es la única prueba de que quedó agendado.
  var agendados = 0;
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'ordenesProgramadas') agendados++;
    });
  } catch (e) { agendados = -1; }

  return {
    habilitada: habilitada,
    horas: horas,
    canales: String(_cfgVal(cfg, 'orders_auto_canales')).split(',')
      .map(function (x) { return x.trim(); }).filter(String),
    tope: _cfgVal(cfg, 'orders_auto_max'),
    email: _cfgVal(cfg, 'orders_auto_email'),
    agendados: agendados,
    proxima: habilitada ? _proximaCorrida(horas) : null,
    ultima: hist.length ? hist[hist.length - 1] : null
  };
}

/** Corre la importación automática a pedido, para probarla sin esperar la hora. */
function apiOrdersAutoRun(user) { return runOrdersImport(user.email); }

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
  return _buscarColumna(fila, alias);
}

/** Busca la columna del importe total de la factura. */
function _columnaImporte(fila) {
  var alias = ['importe', 'imp_total', 'importe_total', 'total', 'total_comp',
               'imp_neto', 'neto', 'monto', 'imp_tot', 'total_factura'];
  return _buscarColumna(fila, alias);
}

function _buscarColumna(fila, alias) {
  var claves = Object.keys(fila || {});
  for (var i = 0; i < claves.length; i++) {
    var norm = String(claves[i]).toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (alias.indexOf(norm) !== -1) return claves[i];
  }
  return '';
}

/** Solo los dígitos, para comparar documentos sin importar puntos ni guiones. */
function _soloDigitos(v) { return String(v === null || v === undefined ? '' : v).replace(/\D/g, ''); }

/** Texto o número → número. Tolera "$ 1.234,56" y "1234.56". */
function _aNumero(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  var s = String(v).replace(/[^0-9,.\-]/g, '');
  if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) {
    // formato argentino: 1.234,56
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.indexOf(',') !== -1) {
    s = s.replace(',', '.');
  }
  var n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

/** Las órdenes que se mandaron a Tango y todavía no tienen factura cargada. */
function apiInvoicesPendientes(canal) {
  var rows = _readRows(SH.SENT, 2000);
  var pend = [], sinDatos = 0;
  rows.forEach(function (r) {
    var estado = String(r.estado_facturacion || '').toLowerCase();
    if (estado === 'facturada') return;
    var ch = String(r.canal || 'fravega').toLowerCase();
    if (canal && ch !== canal) return;
    var cliente = String(r.cliente || '').trim();
    var doc = _soloDigitos(r.documento);
    if (!cliente && !doc) { sinDatos++; return; }   // filas viejas, de antes de la API
    pend.push({ orden: String(r.order_id), suborden: String(r.suborder_id || ''),
                cliente: cliente, documento: doc,
                fecha_compra: String(r.fecha_compra || ''),
                total: r.total, items: String(r.items || ''),
                origen: String(r.origen || ''), canal: ch });
  });
  return { pendientes: pend.reverse(), sin_datos: sinDatos, total: pend.length };
}

/* ── El cruce contra el reporte de Tango ──────────────────────────────────
 * Se busca en este orden, y la primera que da se usa:
 *   1. documento + importe   ← el más fuerte, y el que separa canales solo
 *   2. documento
 *   3. nombre + importe
 *   4. nombre
 * El importe entra en juego porque un mismo cliente puede haber comprado en
 * los dos marketplaces: el documento solo no alcanzaría para saber cuál de
 * las dos facturas le corresponde a cada orden. */
function _matchearFacturas(facturasRows, canal) {
  ['RAZON_SOCI', 'N_COMP', 'FECHA_EMI'].forEach(function (c) {
    if (!(c in facturasRows[0])) throw new Error("El reporte no tiene la columna '" + c + "'");
  });

  var usarImporte = getConfig('invoices_match_importe') === '1';
  var tolerancia = parseFloat(getConfig('invoices_tolerancia_importe') || '1');
  if (isNaN(tolerancia) || tolerancia < 0) tolerancia = 1;

  var colDoc = _columnaDocumento(facturasRows[0]);
  var colImp = usarImporte ? _columnaImporte(facturasRows[0]) : '';

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
    f.__imp = colImp ? _aNumero(f[colImp]) : NaN;
    if (colDoc) {
      var d = _soloDigitos(f[colDoc]);
      if (d) (porDoc[d] = porDoc[d] || []).push(f);
    }
    (porNombre[_normKey(f['RAZON_SOCI'])] = porNombre[_normKey(f['RAZON_SOCI'])] || []).push(f);
  });

  function tomar(lista, importe) {
    if (!lista) return null;
    for (var i = 0; i < lista.length; i++) {
      var f = lista[i];
      if (usadas[f.__i]) continue;
      if (importe !== null) {
        if (isNaN(f.__imp) || isNaN(importe)) continue;
        if (Math.abs(f.__imp - importe) > tolerancia) continue;
      }
      usadas[f.__i] = true;
      return f;
    }
    return null;
  }

  var asignaciones = {}, sinFactura = [];
  var conteo = { doc_importe: 0, doc: 0, nombre_importe: 0, nombre: 0 };
  var ts = _now();
  var cambios = false;

  for (var r = 0; r < datos.length; r++) {
    var fila = datos[r];
    if (String(fila[col.estado_facturacion] || '').toLowerCase() === 'facturada') continue;

    var ch = String(col.canal !== undefined ? (fila[col.canal] || 'fravega') : 'fravega').toLowerCase();
    if (canal && ch !== canal) continue;

    var orden = String(fila[col.order_id] || '').trim();
    if (!orden) continue;
    var cliente = String(fila[col.cliente] || '').trim();
    var doc = _soloDigitos(fila[col.documento]);
    if (!cliente && !doc) continue;   // fila vieja sin datos: no se puede matchear
    var importe = _aNumero(fila[col.total]);
    var nk = cliente ? _normKey(cliente) : '';

    var f = null, via = '';
    if (doc && colImp && !isNaN(importe)) { f = tomar(porDoc[doc], importe); if (f) { via = 'doc_importe'; } }
    if (!f && doc) { f = tomar(porDoc[doc], null); if (f) via = 'doc'; }
    if (!f && nk && colImp && !isNaN(importe)) { f = tomar(porNombre[nk], importe); if (f) via = 'nombre_importe'; }
    if (!f && nk) { f = tomar(porNombre[nk], null); if (f) via = 'nombre'; }

    if (!f) {
      sinFactura.push({ orden: orden, cliente: cliente, documento: doc,
                        total: isNaN(importe) ? '' : importe });
      continue;
    }
    conteo[via]++;

    var nroFactura = String(f['N_COMP']).replace(/[\s\-]/g, '');
    var fechaFactura = _fechaFmt(f['FECHA_EMI']);
    asignaciones[orden] = { nro_factura: nroFactura, fecha_factura: fechaFactura,
                            cliente: cliente, via: via };

    fila[col.estado_facturacion] = 'facturada';
    fila[col.nro_factura] = nroFactura;
    fila[col.fecha_factura] = fechaFactura;
    fila[col.facturada_en] = ts;
    cambios = true;
  }

  if (cambios) sheet.getRange(2, 1, datos.length, headers.length).setValues(datos);

  var sobrantes = [];
  facturas.forEach(function (f) {
    if (!usadas[f.__i]) {
      sobrantes.push({ cliente: String(f['RAZON_SOCI']), factura: String(f['N_COMP']),
                       importe: isNaN(f.__imp) ? '' : f.__imp });
    }
  });

  return {
    asignaciones: asignaciones, sin_factura: sinFactura, sobrantes: sobrantes,
    conteo: conteo,
    columna_documento: colDoc || '(el reporte no trae documento)',
    columna_importe: colImp || (usarImporte ? '(el reporte no trae importe)' : '(desactivado)')
  };
}

/**
 * FRÁVEGA — cruza el reporte de Tango contra el historial y genera el .xlsx.
 * No necesita el CSV de órdenes.
 */
function apiInvoicesFromHistory(user, facturasRows) {
  if (!facturasRows || !facturasRows.length) throw new Error('El reporte de facturación llegó vacío');

  var m = _matchearFacturas(facturasRows, 'fravega');
  var addPrefix = getConfig('invoices_add_prefix') === '1';
  var prefijo = getConfig('invoices_prefix') || 'FVG-';

  var filas = [];
  Object.keys(m.asignaciones).forEach(function (orden) {
    var a = m.asignaciones[orden];
    var salida = orden;
    if (addPrefix && salida.toUpperCase().indexOf(prefijo.toUpperCase()) !== 0) {
      salida = prefijo + salida;
    }
    filas.push([salida, a.nro_factura, a.fecha_factura]);
  });

  var xls = _generarXlsxFacturas(filas);

  _appendRow(SH.INVOICES, [_now(), user.email, xls.archivo, filas.length,
                           m.sin_factura.length, m.sobrantes.length,
                           JSON.stringify({ sin_factura: m.sin_factura,
                                            sobrantes: m.sobrantes, conteo: m.conteo })]);
  log_(user.email, 'facturas', 'Exportación Frávega (desde el historial)', 'ok',
       'cargadas=' + filas.length + ' ' + JSON.stringify(m.conteo) +
       ' sin_factura=' + m.sin_factura.length + ' sobrantes=' + m.sobrantes.length);

  return { archivo: xls.archivo, cargadas: filas.length,
           sin_factura: m.sin_factura, sobrantes: m.sobrantes,
           conteo: m.conteo,
           columna_documento: m.columna_documento, columna_importe: m.columna_importe,
           base64: xls.base64 };
}

/**
 * ONCITY — completa la plantilla de Carga Masiva.
 * Recibe la plantilla EXPORTADA del panel de OnCity tal cual (como matriz de
 * filas, incluida la de encabezados) y el reporte de facturación de Tango.
 * Devuelve la MISMA matriz con la columna B (Nro. de Factura) completada; el
 * resto de las columnas se devuelven intactas, porque la fecha, el valor y la
 * transportadora ya vienen bien de OnCity y no hay que tocarlas.
 * La columna E (Url de la factura) se deja vacía, como acordamos.
 */
function apiOncityInvoices(user, p) {
  p = p || {};
  var plantilla = p.plantilla || [];
  var facturasRows = p.facturas || [];
  if (plantilla.length < 2) throw new Error('La plantilla de OnCity llegó vacía o sin filas de datos');
  if (!facturasRows.length) throw new Error('El reporte de facturación llegó vacío');

  var m = _matchearFacturas(facturasRows, 'oncity');

  var encabezados = plantilla[0];
  var COL_ORDEN = 0, COL_FACTURA = 1;
  var salida = [encabezados.slice()];
  var completadas = 0, sinMatch = [], yaTenian = 0;

  for (var i = 1; i < plantilla.length; i++) {
    var fila = (plantilla[i] || []).slice();
    while (fila.length < encabezados.length) fila.push('');
    var orden = String(fila[COL_ORDEN] || '').trim();
    if (!orden) continue;                       // fila vacía del final de la planilla

    if (String(fila[COL_FACTURA] || '').trim()) { yaTenian++; salida.push(fila); continue; }

    var a = m.asignaciones[orden];
    if (a) {
      fila[COL_FACTURA] = a.nro_factura;
      completadas++;
    } else {
      sinMatch.push(orden);
    }
    salida.push(fila);
  }

  var nombre = 'invoice_shipment_completo_' +
    Utilities.formatDate(new Date(), TZ_AR, 'yyyyMMdd_HHmmss') + '.xlsx';

  _appendRow(SH.INVOICES, [_now(), user.email, nombre, completadas,
                           sinMatch.length, m.sobrantes.length,
                           JSON.stringify({ sin_match_en_plantilla: sinMatch,
                                            sin_factura_en_historial: m.sin_factura,
                                            sobrantes: m.sobrantes, conteo: m.conteo })]);
  log_(user.email, 'facturas', 'Exportación OnCity (plantilla completada)', 'ok',
       'completadas=' + completadas + ' ' + JSON.stringify(m.conteo) +
       ' sin_match=' + sinMatch.length + ' sobrantes=' + m.sobrantes.length);

  return {
    archivo: nombre, filas: salida, completadas: completadas,
    ya_tenian: yaTenian, sin_match: sinMatch,
    sin_factura: m.sin_factura, sobrantes: m.sobrantes, conteo: m.conteo,
    columna_documento: m.columna_documento, columna_importe: m.columna_importe
  };
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

function getConfig(key) { return _cfgVal(_configMap(), key); }

/**
 * Valor de configuración con respaldo en DEFAULT_CONFIG.
 * Una clave nueva no está en la hoja hasta que se corre la migración, y si la
 * pantalla de Configuración la guarda vacía queda vacía para siempre. Con este
 * respaldo, una clave sin valor usa el default del código en vez de quedar en
 * blanco y desactivar una función sin decir nada.
 */
function _cfgVal(cfg, key) {
  var v = (cfg || {})[key];
  if (v !== undefined && String(v).trim() !== '') return String(v);
  var d = _defaultConfig(key);
  return d === undefined ? '' : String(d);
}

function setConfig(key, value) {
  var sheet = _sheet(SH.CONFIG);
  var idx = _colValues(sheet, 1).indexOf(key);
  if (idx === -1) sheet.appendRow([key, String(value), '']);
  else sheet.getRange(idx + 2, 2).setValue(String(value));
}

function apiSettingsGet() {
  var props = PropertiesService.getScriptProperties();
  // Completamos con los defaults del código las claves que la hoja no tiene o
  // tiene vacías: así el formulario muestra el valor real que está usando la
  // app, y al guardar queda escrito en la hoja en vez de perderse.
  var valores = _configMap();
  DEFAULT_CONFIG.forEach(function (r) {
    if (valores[r[0]] === undefined || String(valores[r[0]]).trim() === '') {
      valores[r[0]] = r[1];
    }
  });
  return {
    valores: valores,
    credenciales: {
      tango_token: !!props.getProperty('TANGO_ACCESS_TOKEN'),
      fravega_seller_id: !!props.getProperty('FRAVEGA_SELLER_ID'),
      fravega_api_key: !!props.getProperty('FRAVEGA_API_KEY'),
      fravega_api_token: !!props.getProperty('FRAVEGA_API_TOKEN'),
      google_client_id: !!props.getProperty('GOOGLE_CLIENT_ID'),
      vtex_app_key: !!props.getProperty('VTEX_APP_KEY'),
      vtex_app_token: !!props.getProperty('VTEX_APP_TOKEN'),
      fravega_vtex_key: !!props.getProperty('FRAVEGA_VTEX_APP_KEY'),
      fravega_vtex_token: !!props.getProperty('FRAVEGA_VTEX_APP_TOKEN')
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
  var recrear = ['scheduler_hours', 'scheduler_enabled',
                 'orders_auto_hours', 'orders_auto_enabled'];
  if (recrear.some(function (k) { return k in (valores || {}); })) configurarTriggers();
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

/* Las tres funciones de abajo aceptan un canal opcional. Si no se pasa nada
 * usan OnCity, que es como venían funcionando para el stock: así todo el
 * código que ya existía sigue andando sin tocarlo. */

function _vtexBase(canal) {
  var c = _canal(canal || 'oncity');
  var acc = _prop(c.props.account);
  if (!acc) throw new Error('Falta ' + c.props.account + ' en Script Properties');
  return 'https://' + acc + '.' + VTEX_ENV + '.com.br';
}

function _vtexHeaders(canal) {
  var c = _canal(canal || 'oncity');
  return {
    'X-VTEX-API-AppKey': _prop(c.props.key),
    'X-VTEX-API-AppToken': _prop(c.props.token),
    'Accept': 'application/json'
  };
}

function _vtexFetch(path, opts, canal) {
  opts = opts || {};
  opts.headers = _vtexHeaders(canal);
  opts.muteHttpExceptions = true;
  opts.followRedirects = true;
  return UrlFetchApp.fetch(_vtexBase(canal) + path, opts);
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
          reg.items || '', reg.origen || 'csv', 'pendiente', '', '', '',
          reg.canal || 'fravega'];
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

  // 3. Credenciales de VTEX (las dos cuentas) → Script Properties
  var props = PropertiesService.getScriptProperties();
  ['FRAVEGA_VTEX_ACCOUNT', 'FRAVEGA_VTEX_APP_KEY', 'FRAVEGA_VTEX_APP_TOKEN',
   'VTEX_ACCOUNT', 'VTEX_APP_KEY', 'VTEX_APP_TOKEN'].forEach(function (k) {
    if (INITIAL_CREDENTIALS[k]) props.setProperty(k, INITIAL_CREDENTIALS[k]);
  });

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
