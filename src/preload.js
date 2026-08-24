'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  loadData: () => ipcRenderer.invoke('data-load'),
  saveData: data => ipcRenderer.invoke('data-save', data),
  exportPDF: invoiceNumber => ipcRenderer.invoke('export-pdf', invoiceNumber),
  exportPaymentReceipt: receipt => ipcRenderer.invoke('export-payment-receipt', receipt),
  exportExcel: payload => ipcRenderer.invoke('export-excel', payload),
  exportFinanceReport: payload => ipcRenderer.invoke('export-finance-report', payload),
  checkNotifications: () => ipcRenderer.send('check-notifications'),
  loadGatewayConfig: () => ipcRenderer.invoke('gateway-load-config'),
  saveGatewayConfig: config => ipcRenderer.invoke('gateway-save-config', config),
  autoConfigureGateway: () => ipcRenderer.invoke('gateway-auto-configure'),
  gatewayRequest: request => ipcRenderer.invoke('gateway-request', request),
  openExternal: url => ipcRenderer.invoke('open-external', url),
  copyText: text => ipcRenderer.invoke('copy-text', text)
});
