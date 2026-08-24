'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_VERSION = '2.11.0';
const DB_VERSION = '2.11.0';
const { PaymentJsonDatabase } = require('./payment-engine/db-json');
const { RazorpayClient, RazorpayApiError } = require('./payment-engine/razorpay');
const { PaymentService, ValidationError } = require('./payment-engine/service');
const { createLogger } = require('./payment-engine/logger');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow;
const dataDir = path.join(app.getPath('userData'), 'incentify-billing');
const dataFile = path.join(dataDir, 'data.json');
const logDir = path.join(dataDir, 'logs');
const startupLogFile = path.join(logDir, 'startup.log');

function startupLog(message, details = '') {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const suffix = details instanceof Error ? `\n${details.stack || details.message}` : details ? ` ${typeof details === 'string' ? details : JSON.stringify(details)}` : '';
    fs.appendFileSync(startupLogFile, `[${new Date().toISOString()}] ${message}${suffix}\n`, 'utf8');
  } catch (_) {
    // Startup logging must never prevent the application from opening.
  }
}

function showFatalStartupError(title, error) {
  startupLog(title, error);
  try {
    dialog.showErrorBox(title, `${error?.message || error}\n\nDiagnostic log:\n${startupLogFile}`);
  } catch (_) {}
}

process.on('uncaughtException', error => showFatalStartupError('INCENTIFY Billing startup error', error));
process.on('unhandledRejection', error => startupLog('Unhandled promise rejection', error instanceof Error ? error : String(error)));

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function defaultData() {
  return {
    _ver: DB_VERSION,
    bills: [], invoices: [], customers: [], activityLog: [], expenses: [], earnings: [],
    paymentRequests: [], paymentTransactions: [], paymentSyncLog: [], paymentWebhookEvents: [], paymentAuditLogs: [],
    meta: { lastInvoiceNum: 0 }, settings: {}
  };
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupLegacyData(raw, parsed) {
  const oldVersion = String(parsed?._ver || 'legacy').replace(/[^A-Za-z0-9._-]/g, '_');
  if (oldVersion === DB_VERSION) return;
  ensureDataDir();
  const marker = path.join(dataDir, `.migrated-to-${DB_VERSION}`);
  if (fs.existsSync(marker)) return;
  const backup = path.join(dataDir, `data.backup-v${oldVersion}-${safeTimestamp()}.json`);
  try {
    fs.writeFileSync(backup, raw, 'utf8');
    fs.writeFileSync(marker, `Backup created: ${backup}\n`, 'utf8');
  } catch (error) {
    console.error('Could not create migration backup', error);
  }
}

let dataCache = null;
let pendingDiskWrite = null;
let diskWriteTimer = null;
let appIsQuitting = false;

function normalizeData(data) {
  return { ...defaultData(), ...(data || {}), _ver: DB_VERSION, meta: { lastInvoiceNum: 0, ...((data || {}).meta || {}) } };
}

function loadData() {
  if (dataCache) return dataCache;
  ensureDataDir();
  if (!fs.existsSync(dataFile)) {
    dataCache = defaultData();
    return dataCache;
  }
  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    backupLegacyData(raw, parsed);
    dataCache = normalizeData(parsed);
    return dataCache;
  } catch (error) {
    console.error('Data load failed', error);
    startupLog('Data load failed; using a safe empty database', error);
    dataCache = defaultData();
    return dataCache;
  }
}

function writeDataSnapshotSync(snapshot) {
  ensureDataDir();
  const tempFile = `${dataFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.copyFileSync(tempFile, dataFile);
  fs.unlinkSync(tempFile);
}

function flushPendingDataSync() {
  if (diskWriteTimer) {
    clearTimeout(diskWriteTimer);
    diskWriteTimer = null;
  }
  if (!pendingDiskWrite) return;
  const snapshot = pendingDiskWrite;
  pendingDiskWrite = null;
  try { writeDataSnapshotSync(snapshot); }
  catch (error) { startupLog('Database flush failed', error); }
}

function scheduleDiskWrite() {
  if (appIsQuitting) {
    flushPendingDataSync();
    return;
  }
  if (diskWriteTimer) clearTimeout(diskWriteTimer);
  diskWriteTimer = setTimeout(() => {
    diskWriteTimer = null;
    const snapshot = pendingDiskWrite;
    pendingDiskWrite = null;
    if (!snapshot) return;
    try { writeDataSnapshotSync(snapshot); }
    catch (error) {
      startupLog('Deferred database save failed', error);
      pendingDiskWrite = snapshot;
    }
  }, 180);
}

function saveData(data, options = {}) {
  dataCache = normalizeData(data);
  pendingDiskWrite = dataCache;
  if (options.immediate) flushPendingDataSync();
  else scheduleDiskWrite();
  return dataCache;
}

let integratedGateway = null;
const gatewaySecretsFile = path.join(dataDir, 'integrated-gateway-secrets.json');

function encryptValue(value) {
  if (!value) return { encrypted: '', plain: '' };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { encrypted: safeStorage.encryptString(String(value)).toString('base64'), plain: '' };
    }
  } catch (error) {
    console.error('Windows secret encryption failed', error);
  }
  return { encrypted: '', plain: String(value) };
}

function decryptValue(encrypted, plain) {
  if (encrypted) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      }
    } catch (error) {
      console.error('Windows secret decryption failed', error);
    }
  }
  return plain || '';
}

function readGatewayBootstrap() {
  const bootstrapPath = path.join(__dirname, 'payment-engine', 'gateway-bootstrap.json');
  if (!fs.existsSync(bootstrapPath)) throw new Error('Integrated Razorpay configuration is missing from this application build.');
  return JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
}

function loadIntegratedGatewaySecrets() {
  ensureDataDir();
  if (fs.existsSync(gatewaySecretsFile)) {
    try {
      const stored = JSON.parse(fs.readFileSync(gatewaySecretsFile, 'utf8'));
      const result = {
        keyId: stored.keyId || '',
        keySecret: decryptValue(stored.keySecretEncrypted, stored.keySecretPlain),
        webhookSecret: decryptValue(stored.webhookSecretEncrypted, stored.webhookSecretPlain),
        apiBaseUrl: stored.apiBaseUrl || 'https://api.razorpay.com/v1',
        timeoutMs: Number(stored.timeoutMs || 15000),
        mode: stored.mode || (String(stored.keyId || '').startsWith('rzp_live_') ? 'live' : 'test')
      };
      if (result.keyId && result.keySecret) return result;
    } catch (error) {
      console.error('Stored Razorpay configuration could not be loaded', error);
    }
  }

  const bootstrap = readGatewayBootstrap();
  const protectedKey = encryptValue(bootstrap.keySecret);
  const protectedWebhook = encryptValue(bootstrap.webhookSecret);
  const stored = {
    keyId: bootstrap.keyId,
    keySecretEncrypted: protectedKey.encrypted,
    keySecretPlain: protectedKey.plain,
    webhookSecretEncrypted: protectedWebhook.encrypted,
    webhookSecretPlain: protectedWebhook.plain,
    apiBaseUrl: bootstrap.apiBaseUrl || 'https://api.razorpay.com/v1',
    timeoutMs: Number(bootstrap.timeoutMs || 15000),
    mode: bootstrap.mode || (String(bootstrap.keyId || '').startsWith('rzp_live_') ? 'live' : 'test'),
    importedAt: new Date().toISOString()
  };
  fs.writeFileSync(gatewaySecretsFile, JSON.stringify(stored, null, 2), 'utf8');
  return {
    keyId: stored.keyId,
    keySecret: bootstrap.keySecret,
    webhookSecret: bootstrap.webhookSecret,
    apiBaseUrl: stored.apiBaseUrl,
    timeoutMs: stored.timeoutMs,
    mode: stored.mode
  };
}


function validateGatewaySettings(input, previous) {
  const mode = String(input?.mode || previous?.mode || 'test').toLowerCase() === 'live' ? 'live' : 'test';
  const keyId = String(input?.keyId || previous?.keyId || '').trim();
  const keySecret = String(input?.keySecret || '').trim() || previous?.keySecret || '';
  const webhookSecret = String(input?.webhookSecret || '').trim() || previous?.webhookSecret || '';
  const apiBaseUrl = 'https://api.razorpay.com/v1';
  const timeoutMs = Math.min(60000, Math.max(5000, Number(input?.timeoutMs || previous?.timeoutMs || 15000)));
  if (!keyId) throw new Error('Razorpay Key ID is required.');
  if (!keySecret) throw new Error('Razorpay Key Secret is required.');
  const expectedPrefix = mode === 'live' ? 'rzp_live_' : 'rzp_test_';
  if (!keyId.startsWith(expectedPrefix)) throw new Error(`The ${mode.toUpperCase()} Mode Key ID must begin with ${expectedPrefix}.`);
  return { keyId, keySecret, webhookSecret, apiBaseUrl, timeoutMs, mode };
}

function saveIntegratedGatewaySecrets(input = {}) {
  const previous = loadIntegratedGatewaySecrets();
  const config = validateGatewaySettings(input, previous);
  const protectedKey = encryptValue(config.keySecret);
  const protectedWebhook = encryptValue(config.webhookSecret);
  const stored = {
    keyId: config.keyId,
    keySecretEncrypted: protectedKey.encrypted,
    keySecretPlain: protectedKey.plain,
    webhookSecretEncrypted: protectedWebhook.encrypted,
    webhookSecretPlain: protectedWebhook.plain,
    apiBaseUrl: config.apiBaseUrl,
    timeoutMs: config.timeoutMs,
    mode: config.mode,
    updatedAt: new Date().toISOString()
  };
  ensureDataDir();
  fs.writeFileSync(gatewaySecretsFile, JSON.stringify(stored, null, 2), 'utf8');
  integratedGateway = null;
  startupLog('Razorpay configuration updated', { mode: config.mode, key_id: maskedKey(config.keyId), timeout_ms: config.timeoutMs });
  return config;
}

function publicGatewayConfig(config) {
  return {
    integrated: true,
    mode: config.mode,
    keyId: config.keyId,
    maskedKeyId: maskedKey(config.keyId),
    hasKeySecret: Boolean(config.keySecret),
    hasWebhookSecret: Boolean(config.webhookSecret),
    apiBaseUrl: config.apiBaseUrl,
    timeoutMs: config.timeoutMs,
    source: `Integrated Razorpay ${String(config.mode || 'test').toUpperCase()} Mode`
  };
}

function getIntegratedGateway() {
  if (integratedGateway) return integratedGateway;
  const secrets = loadIntegratedGatewaySecrets();
  if (!secrets.keyId || !secrets.keySecret) throw new Error('Razorpay credentials are not configured in this integrated build.');
  const db = new PaymentJsonDatabase({ loadData, saveData });
  const razorpay = new RazorpayClient({
    keyId: secrets.keyId,
    keySecret: secrets.keySecret,
    apiBaseUrl: secrets.apiBaseUrl,
    timeoutMs: secrets.timeoutMs
  });
  const logger = createLogger(path.join(dataDir, 'integrated-payment-engine.log'));
  const service = new PaymentService({ db, razorpay, logger });
  integratedGateway = { db, razorpay, service, logger, mode: secrets.mode, keyId: secrets.keyId };
  logger.info('Integrated Razorpay payment engine initialised', { mode: secrets.mode, key_id: `${secrets.keyId.slice(0, 8)}...${secrets.keyId.slice(-4)}` });
  return integratedGateway;
}

function maskedKey(value) {
  if (!value) return '';
  return `${value.slice(0, 8)}••••${value.slice(-4)}`;
}

async function syncActivePaymentLinks(engine, maxLinks = 25) {
  const active = engine.db.listPaymentRequests({ limit: Math.max(1, Math.min(100, maxLinks)) })
    .filter(item => ['created', 'partially_paid'].includes(item.status))
    .slice(0, maxLinks);
  const batchSize = 3;
  for (let index = 0; index < active.length; index += batchSize) {
    const batch = active.slice(index, index + batchSize);
    const fetched = await Promise.allSettled(batch.map(item => engine.razorpay.fetchPaymentLink(item.razorpay_payment_link_id)));
    engine.db.transaction(() => {
      fetched.forEach((result, itemIndex) => {
        if (result.status !== 'fulfilled') {
          engine.logger?.warn('Payment Link background sync failed', { razorpay_id: batch[itemIndex].razorpay_payment_link_id, error: result.reason?.message || String(result.reason) });
          return;
        }
        const entity = result.value;
        const request = engine.db.upsertPaymentRequestFromRazorpay(entity);
        if (Array.isArray(entity.payments)) {
          for (const payment of entity.payments) engine.db.upsertPaymentTransaction(payment, request.id);
        }
        engine.db.audit('payment_link_synced', 'payment_request', request.id, { razorpay_id: entity.id, status: entity.status, source: 'background_batch' });
      });
    });
    await new Promise(resolve => setImmediate(resolve));
  }
  return active.length;
}

async function gatewayRequest({ method = 'GET', apiPath = '/health', body = null }) {
  const engine = getIntegratedGateway();
  const verb = String(method || 'GET').toUpperCase();
  const url = new URL(apiPath, 'http://integrated.incentify.local');
  const pathname = url.pathname;

  if (verb === 'GET' && pathname === '/health') {
    return { status: 200, data: { success: true, service: 'incentify-integrated-payment-engine', version: APP_VERSION, environment: 'desktop-integrated', razorpay_mode: engine.mode, time: new Date().toISOString() } };
  }
  if (verb === 'GET' && pathname === '/api/v1/gateway/status') {
    const remote = await engine.service.gatewayStatus();
    return { status: 200, data: { success: true, gateway: 'razorpay', mode: engine.mode, key_id: maskedKey(engine.keyId), integrated: true, ...remote } };
  }
  if (verb === 'POST' && pathname === '/api/v1/payment-links') {
    const result = await engine.service.createPaymentLink(body || {});
    return { status: 201, data: { success: true, ...result } };
  }
  if (verb === 'GET' && pathname === '/api/v1/payment-links') {
    if (url.searchParams.get('sync') === '1') await syncActivePaymentLinks(engine, Number(url.searchParams.get('sync_limit') || 25));
    const items = engine.db.listPaymentRequests({
      invoiceId: url.searchParams.get('invoice_id') || undefined,
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') || undefined,
      offset: url.searchParams.get('offset') || undefined
    });
    return { status: 200, data: { success: true, count: items.length, items } };
  }
  const syncMatch = pathname.match(/^\/api\/v1\/payment-links\/([^/]+)\/sync$/);
  if (syncMatch && verb === 'POST') {
    const result = await engine.service.fetchAndSyncPaymentLink(decodeURIComponent(syncMatch[1]));
    return { status: 200, data: { success: true, ...result } };
  }
  const cancelMatch = pathname.match(/^\/api\/v1\/payment-links\/([^/]+)\/cancel$/);
  if (cancelMatch && verb === 'POST') {
    const result = await engine.service.cancelPaymentLink(decodeURIComponent(cancelMatch[1]));
    return { status: 200, data: { success: true, ...result } };
  }
  const linkMatch = pathname.match(/^\/api\/v1\/payment-links\/([^/]+)$/);
  if (linkMatch && verb === 'GET') {
    const razorpayId = decodeURIComponent(linkMatch[1]);
    if (url.searchParams.get('sync') === '1') {
      const result = await engine.service.fetchAndSyncPaymentLink(razorpayId);
      return { status: 200, data: { success: true, ...result } };
    }
    const item = engine.db.getPaymentRequestByRazorpayId(razorpayId);
    if (!item) {
      const error = new Error('Payment Link was not found locally.');
      error.status = 404;
      throw error;
    }
    return { status: 200, data: { success: true, payment_request: item } };
  }
  if (verb === 'GET' && pathname === '/api/v1/transactions') {
    const items = engine.db.listTransactions({
      invoiceId: url.searchParams.get('invoice_id') || undefined,
      limit: url.searchParams.get('limit') || undefined,
      offset: url.searchParams.get('offset') || undefined
    });
    return { status: 200, data: { success: true, count: items.length, items } };
  }
  if (verb === 'GET' && pathname === '/api/v1/summary') {
    return { status: 200, data: { success: true, summary: engine.db.dashboardSummary() } };
  }
  const invoiceMatch = pathname.match(/^\/api\/v1\/invoices\/([^/]+)\/payment-summary$/);
  if (invoiceMatch && verb === 'GET') {
    return { status: 200, data: { success: true, summary: engine.db.invoiceSummary(decodeURIComponent(invoiceMatch[1])) } };
  }
  const error = new Error('Unsupported integrated payment route.');
  error.status = 404;
  throw error;
}

function resolveGatewayConfig() {
  try {
    return publicGatewayConfig(loadIntegratedGatewaySecrets());
  } catch (error) {
    return { integrated: true, mode: 'unknown', keyId: '', maskedKeyId: '', hasKeySecret: false, hasWebhookSecret: false, apiBaseUrl: 'https://api.razorpay.com/v1', timeoutMs: 15000, source: error.message };
  }
}

function saveGatewayConfig(config) { return publicGatewayConfig(saveIntegratedGatewaySecrets(config || {})); }
function discoverGatewayEnv() { return resolveGatewayConfig(); }

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function receiptHtml(receipt) {
  const business = receipt.business || {};
  const logo = String(business.logo || '').startsWith('data:image') ? `<img class="logo" src="${business.logo}">` : '';
  const signature = String(business.signature || '').startsWith('data:image') ? `<img class="signature" src="${business.signature}">` : '';
  const rows = [
    ['Receipt Number', receipt.receiptNumber], ['Invoice Number', receipt.invoiceNumber], ['Customer', receipt.customerName],
    ['Payment Date', receipt.paymentDate], ['Payment Method', receipt.paymentMethod], ['Amount Received', receipt.amountReceived],
    ['Razorpay Payment ID', receipt.paymentId], ['Payment Link ID', receipt.paymentLinkId], ['Remaining Balance', receipt.remainingBalance]
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:22mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#182a3a;margin:0;font-size:12px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #083866;padding-bottom:15px}.logo{max-width:90px;max-height:70px;object-fit:contain}
    h1{margin:0;color:#083866;font-size:28px}.legal{font-weight:700;margin-top:7px}.address{white-space:pre-line;color:#66798b;font-size:10px;margin-top:5px;line-height:1.45}
    .paid{display:inline-block;margin:22px 0 12px;background:#e8f5ee;color:#083866;font-weight:700;padding:7px 14px;border-radius:20px}
    table{width:100%;border-collapse:collapse;margin-top:8px}td{padding:10px 8px;border-bottom:1px solid #e1e9f0}td:first-child{width:38%;color:#687b8d;font-weight:600}td:last-child{font-weight:600}
    .amount{font-size:19px;color:#083866}.footer{display:flex;justify-content:space-between;align-items:flex-end;margin-top:42px;border-top:1px solid #d8e2eb;padding-top:18px}.signature{max-width:135px;max-height:55px;object-fit:contain}.sign{text-align:right;max-width:310px}.small{font-size:9px;color:#6f8191;line-height:1.45}.support{margin-top:25px;padding:12px;background:#f3f7fa;border-left:4px solid #083866}
  </style></head><body>
    <div class="header"><div><h1>Payment Receipt</h1><div class="legal">${htmlEscape(business.legalName || 'INCENTIFY Private Limited')}</div><div class="address">${htmlEscape(business.address || '')}</div></div>${logo}</div>
    <div class="paid">PAYMENT RECEIVED</div>
    <table>${rows.map(([label,value]) => `<tr><td>${htmlEscape(label)}</td><td class="${label === 'Amount Received' ? 'amount' : ''}">${htmlEscape(value)}</td></tr>`).join('')}</table>
    <div class="support"><strong>Payment support:</strong> ${htmlEscape(business.supportEmail || '')}${business.supportEmail && business.supportPhone ? ' · ' : ''}${htmlEscape(business.supportPhone || '')}</div>
    <div class="footer"><div class="small">This receipt confirms a payment recorded against the referenced invoice.<br>Generated by INCENTIFY Billing v${APP_VERSION}.</div><div class="sign">${signature}<div><strong>${htmlEscape(business.signatoryName || '')}</strong></div><div class="small">${htmlEscape(business.signatoryTitle || 'AUTHORIZED SIGNATORY')}, ${htmlEscape(business.legalName || '')}</div></div></div>
  </body></html>`;
}

async function createWindow() {
  startupLog('Creating main window', { version: APP_VERSION, platform: process.platform, arch: process.arch });
  mainWindow = new BrowserWindow({
    width: 1480, height: 900, minWidth: 1000, minHeight: 650, frame: false,
    titleBarStyle: 'hidden', backgroundColor: '#062a4b', show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: true,
      spellcheck: false
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico')
  });

  mainWindow.webContents.on('did-finish-load', () => startupLog('Renderer finished loading'));
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    const error = new Error(`Renderer failed to load (${code}): ${description} — ${url}`);
    showFatalStartupError('INCENTIFY Billing could not load', error);
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    showFatalStartupError('INCENTIFY Billing renderer stopped', new Error(JSON.stringify(details)));
  });
  mainWindow.on('unresponsive', () => startupLog('Main window became unresponsive'));
  mainWindow.on('responsive', () => startupLog('Main window became responsive again'));
  mainWindow.on('closed', () => { mainWindow = null; });

  await mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.show();
  mainWindow.focus();
  checkDueBills();
  startupLog('Main window displayed');
}

if (process.argv.includes('--safe-mode')) {
  app.disableHardwareAcceleration();
  startupLog('Safe mode enabled: hardware acceleration disabled');
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.incentify.billing');
  startupLog('Electron app ready');
  await createWindow();
  setInterval(checkDueBills, 60 * 60 * 1000);
}).catch(error => {
  showFatalStartupError('INCENTIFY Billing failed to start', error);
  app.quit();
});
app.on('before-quit', () => { appIsQuitting = true; flushPendingDataSync(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('second-instance', async () => {
  try {
    if (!mainWindow && app.isReady()) await createWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (error) {
    showFatalStartupError('INCENTIFY Billing could not restore its window', error);
  }
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => { if (!mainWindow) return; mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.handle('data-load', () => loadData());
ipcMain.handle('data-save', (_, data) => { saveData(data); return true; });

ipcMain.handle('gateway-load-config', () => resolveGatewayConfig());
ipcMain.handle('gateway-save-config', (_, config) => saveGatewayConfig(config || {}));
ipcMain.handle('gateway-auto-configure', () => ({ success: true, ...resolveGatewayConfig() }));
ipcMain.handle('gateway-request' , async (_, request) => {
  try {
    const response = await gatewayRequest(request || {});
    return { success: true, status: response.status, data: response.data };
  } catch (error) {
    return { success: false, status: error.status || 0, error: error.message, details: error.details || null };
  }
});
ipcMain.handle('open-external', async (_, url) => {
  const parsed = new URL(String(url));
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new Error('Unsupported external URL.');
  await shell.openExternal(parsed.toString());
  return true;
});
ipcMain.handle('copy-text', (_, text) => { clipboard.writeText(String(text || '')); return true; });

ipcMain.handle('export-pdf', async (_, invoiceNumber) => {
  const savePath = dialog.showSaveDialogSync(mainWindow, {
    title: 'Save Invoice as PDF',
    defaultPath: path.join(os.homedir(), 'Desktop', `Invoice_${invoiceNumber || 'INCENTIFY'}.pdf`),
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });
  if (!savePath) return { success: false, reason: 'cancelled' };
  try {
    const pdfData = await mainWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4', marginsType: 1, printSelectionOnly: false, landscape: false });
    fs.writeFileSync(savePath, pdfData);
    shell.showItemInFolder(savePath);
    return { success: true, path: savePath };
  } catch (error) { return { success: false, reason: error.message }; }
});

ipcMain.handle('export-payment-receipt', async (_, receipt) => {
  const receiptNumber = String(receipt?.receiptNumber || receipt?.invoiceNumber || 'INCENTIFY').replace(/[^A-Za-z0-9_-]/g, '_');
  const savePath = dialog.showSaveDialogSync(mainWindow, {
    title: 'Save Payment Receipt as PDF',
    defaultPath: path.join(os.homedir(), 'Desktop', `Payment_Receipt_${receiptNumber}.pdf`),
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });
  if (!savePath) return { success: false, reason: 'cancelled' };
  ensureDataDir();
  const tempPath = path.join(dataDir, `receipt-${Date.now()}.html`);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    fs.writeFileSync(tempPath, receiptHtml(receipt || {}), 'utf8');
    await win.loadFile(tempPath);
    const pdfData = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', marginsType: 1 });
    fs.writeFileSync(savePath, pdfData);
    shell.showItemInFolder(savePath);
    return { success: true, path: savePath };
  } catch (error) { return { success: false, reason: error.message }; }
  finally {
    if (!win.isDestroyed()) win.destroy();
    try { fs.unlinkSync(tempPath); } catch {}
  }
});

ipcMain.handle('export-excel', async (_, { bills = [], invoices = [], expenses = [], earnings = [], balanceSheetEntries = [], paymentRequests = [], paymentTransactions = [], balanceSheet = null, settings = {}, generatedAt = null }) => {
  const savePath = dialog.showSaveDialogSync(mainWindow, {
    title: 'Export Financial Workbook',
    defaultPath: path.join(os.homedir(), 'Desktop', 'INCENTIFY_Financial_Reports.xlsx'),
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
  });
  if (!savePath) return { success: false, reason: 'cancelled' };
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const addSheet = (name, rows, widths=[]) => { const ws=XLSX.utils.aoa_to_sheet(rows); if(widths.length)ws['!cols']=widths.map(w=>({wch:w})); XLSX.utils.book_append_sheet(wb,ws,name); };
    const totalEarn = earnings.reduce((s,e)=>s+Number(e.amount||0),0), totalExp=expenses.reduce((s,e)=>s+Number(e.amount||0),0), netPL=totalEarn-totalExp;
    const bs=balanceSheet||{};
    addSheet('Financial Summary', [
      [settings.legalName || settings.brandName || 'INCENTIFY',''],['Generated On',generatedAt||new Date().toISOString()],['',''],
      ['Total Earnings',totalEarn],['Total Expenses',totalExp],['Net Profit / (Loss)',netPL],['',''],
      ['Total Assets',Number(bs.totalAssets||0)],['Total Liabilities',Number(bs.totalLiabilities||0)],['Total Equity',Number(bs.totalEquity||0)],['Liabilities + Equity',Number(bs.totalLiabilitiesAndEquity||0)],['Balance Difference',Number(bs.difference||0)]
    ],[30,22]);
    addSheet('Earnings', [['Reference #','Description','Source','Date','Amount (₹)','Type','Invoice ID'], ...earnings.map(e=>[e.number,e.description,e.source||'',e.date,e.amount||0,e.type||'manual',e.invoiceId||''])],[18,34,24,14,15,14,22]);
    addSheet('Expenses', [['Voucher #','Description','Category','Paid To','Date','Amount (₹)','Related Invoice'], ...expenses.map(e=>[e.number,e.description||'',e.category,e.paidTo,e.date,e.amount||0,e.invoiceId||''])],[18,34,18,24,14,15,22]);
    addSheet('P&L', [['Profit & Loss Statement','Amount (₹)'],['Revenue / Earnings',totalEarn],['Expenses',-totalExp],['Net Profit / (Loss)',netPL]],[34,18]);
    if(bs){
      addSheet('Balance Sheet', [
        ['ASSETS','Amount (₹)'],['Cash & Bank',bs.assets?.cashBank||0],['Accounts Receivable',bs.assets?.receivables||0],['Other Current Assets',bs.assets?.otherCurrent||0],['Fixed Assets',bs.assets?.fixedAssets||0],['Total Assets',bs.totalAssets||0],['',''],
        ['LIABILITIES',''],['Accounts Payable',bs.liabilities?.payables||0],['Tax & Statutory Liabilities',bs.liabilities?.tax||0],['Loans & Borrowings',bs.liabilities?.loans||0],['Other Liabilities',bs.liabilities?.other||0],['Total Liabilities',bs.totalLiabilities||0],['',''],
        ['EQUITY',''],['Share Capital',bs.equity?.shareCapital||0],['Reserves & Other Equity',bs.equity?.otherEquity||0],['Retained Earnings / Accumulated P&L',bs.equity?.retainedEarnings||0],['Total Equity',bs.totalEquity||0],['Liabilities + Equity',bs.totalLiabilitiesAndEquity||0],['Balance Difference',bs.difference||0]
      ],[38,18]);
    }
    addSheet('Balance Accounts', [['Account','Group','Balance Date','Amount (₹)','Notes'], ...balanceSheetEntries.map(e=>[e.accountName,e.group,e.date,e.amount||0,e.notes||''])],[28,24,14,15,34]);
    addSheet('Bills & Payments', [['Payee/Vendor','Category','Amount (₹)','Due Date','Status','Notes'], ...bills.map(b=>[b.payee,b.category,b.amount,b.due,b.status,b.notes||''])],[25,18,14,14,12,32]);
    addSheet('Invoices', [['Invoice #','Customer','Product/Service','Issue Date','Due Date','Amount (₹)','Paid (₹)','Balance (₹)','Status'], ...invoices.map(i=>[i.number,i.customer,i.product||'',i.issued,i.due,i.grand||0,i.amountPaid||0,i.balanceDue??i.grand??0,i.paymentState||i.status||'unpaid'])],[18,25,22,14,14,14,14,14,18]);
    if(paymentRequests.length)addSheet('Razorpay Links', [['Invoice #','Customer','Requested (₹)','Paid (₹)','Balance (₹)','Status','Payment Link ID','URL','Created','Paid At'], ...paymentRequests.map(r=>[r.invoice_number,r.customer_name,(r.amount||0)/100,(r.amount_paid||0)/100,(r.balance_due||0)/100,r.status,r.razorpay_payment_link_id,r.short_url,r.created_at,r.paid_at])],[18,24,14,14,14,18,26,32,22,22]);
    if(paymentTransactions.length)addSheet('Razorpay Transactions', [['Payment ID','Payment Link Request','Amount (₹)','Status','Method','Email','Contact','Fee (₹)','Tax (₹)','Created'], ...paymentTransactions.map(t=>[t.razorpay_payment_id,t.payment_request_id,(t.amount||0)/100,t.status,t.method,t.email,t.contact,(t.fee||0)/100,(t.tax||0)/100,t.created_at])],[24,24,14,14,14,26,18,12,12,22]);
    XLSX.writeFile(wb, savePath); shell.showItemInFolder(savePath); return { success: true, path: savePath };
  } catch (error) { return { success: false, reason: error.message }; }
});

function escReport(v=''){return String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));}
function moneyReport(n){return Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});}
function financeReportHtml(payload={}){
  const settings=payload.settings||{},bs=payload.balanceSheet||{},earnings=payload.earnings||[],expenses=payload.expenses||[];
  const totalEarn=earnings.reduce((s,e)=>s+Number(e.amount||0),0), totalExp=expenses.reduce((s,e)=>s+Number(e.amount||0),0), net=totalEarn-totalExp;
  const row=(l,v)=>`<tr><td>${escReport(l)}</td><td>₹${moneyReport(v)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#182a3a;padding:28px}h1{color:#083866;margin:0 0 4px}h2{font-size:18px;color:#083866;border-bottom:2px solid #dbe7f1;padding-bottom:6px;margin-top:28px}.meta{font-size:11px;color:#687b8d;margin-bottom:18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}table{width:100%;border-collapse:collapse}td,th{padding:7px 8px;border-bottom:1px solid #e4ebf2;font-size:11px}td:last-child{text-align:right}.total td{font-weight:700;border-top:2px solid #91a9bf}.foot{margin-top:28px;font-size:9px;color:#728596}</style></head><body><h1>${escReport(settings.legalName||settings.brandName||'INCENTIFY')}</h1><div class="meta">Financial Report · Generated ${escReport(payload.generatedAt||new Date().toISOString())}${settings.gstin?` · GSTIN ${escReport(settings.gstin)}`:''}${settings.cin?` · CIN ${escReport(settings.cin)}`:''}</div><h2>Profit & Loss Statement</h2><table>${row('Revenue / Earnings',totalEarn)}${row('Expenses',-totalExp)}<tr class="total"><td>Net ${net>=0?'Profit':'Loss'}</td><td>₹${moneyReport(Math.abs(net))}</td></tr></table><h2>Balance Sheet</h2><div class="grid"><div><strong>Assets</strong><table>${row('Cash & Bank',bs.assets?.cashBank)}${row('Accounts Receivable',bs.assets?.receivables)}${row('Other Current Assets',bs.assets?.otherCurrent)}${row('Fixed Assets',bs.assets?.fixedAssets)}<tr class="total">${row('Total Assets',bs.totalAssets).replace('<tr>','').replace('</tr>','')}</tr></table></div><div><strong>Liabilities & Equity</strong><table>${row('Accounts Payable',bs.liabilities?.payables)}${row('Tax & Statutory Liabilities',bs.liabilities?.tax)}${row('Loans & Borrowings',bs.liabilities?.loans)}${row('Other Liabilities',bs.liabilities?.other)}${row('Share Capital',bs.equity?.shareCapital)}${row('Reserves & Other Equity',bs.equity?.otherEquity)}${row('Retained Earnings / Accumulated P&L',bs.equity?.retainedEarnings)}<tr class="total">${row('Liabilities + Equity',bs.totalLiabilitiesAndEquity).replace('<tr>','').replace('</tr>','')}</tr></table></div></div><div class="foot">Balance difference: ₹${moneyReport(bs.difference||0)}. Accounts Receivable, Accounts Payable, and Retained Earnings are derived from the live billing ledger; other balance-sheet accounts are user-maintained balances.</div></body></html>`;
}
ipcMain.handle('export-finance-report', async (_, payload={}) => {
  const savePath=dialog.showSaveDialogSync(mainWindow,{title:'Export Finance Report PDF',defaultPath:path.join(os.homedir(),'Desktop','INCENTIFY_Finance_Report.pdf'),filters:[{name:'PDF Files',extensions:['pdf']}]});
  if(!savePath)return {success:false,reason:'cancelled'};
  ensureDataDir();const tempPath=path.join(dataDir,`finance-report-${Date.now()}.html`);const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  try{fs.writeFileSync(tempPath,financeReportHtml(payload),'utf8');await win.loadFile(tempPath);const pdf=await win.webContents.printToPDF({printBackground:true,pageSize:'A4',marginsType:1});fs.writeFileSync(savePath,pdf);shell.showItemInFolder(savePath);return {success:true,path:savePath};}
  catch(error){return {success:false,reason:error.message};}
  finally{if(!win.isDestroyed())win.destroy();try{fs.unlinkSync(tempPath);}catch{}}
});

function checkDueBills() {
  const data = loadData();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const urgent = [];
  for (const bill of (data.bills || [])) {
    if (bill.status === 'paid') continue;
    const due = new Date(bill.due);
    const diff = Math.ceil((due - today) / 86400000);
    if (diff <= 3) urgent.push({ ...bill, diff });
  }
  if (!urgent.length || !Notification.isSupported()) return;
  const overdue = urgent.filter(b => b.diff <= 0);
  const dueSoon = urgent.filter(b => b.diff > 0);
  if (overdue.length) new Notification({ title: 'INCENTIFY — Overdue Bills', body: `${overdue.length} bill(s) overdue. Total: ₹${overdue.reduce((s, b) => s + Number(b.amount || 0), 0).toLocaleString('en-IN')}`, icon: path.join(__dirname, '..', 'assets', 'icon.ico'), urgency: 'critical' }).show();
  if (dueSoon.length) new Notification({ title: 'INCENTIFY — Bills Due Soon', body: `${dueSoon.length} bill(s) are due within three days.`, icon: path.join(__dirname, '..', 'assets', 'icon.ico') }).show();
}
ipcMain.on('check-notifications', () => checkDueBills());
