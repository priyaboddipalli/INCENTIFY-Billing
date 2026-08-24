'use strict';

const crypto = require('node:crypto');

function nowIso() { return new Date().toISOString(); }
function makeId(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

class PaymentJsonDatabase {
  constructor({ loadData, saveData }) {
    this.loadData = loadData;
    this.saveData = saveData;
    this.state = null;
    this.transactionDepth = 0;
  }

  ensureCollections(state) {
    state.paymentRequests = Array.isArray(state.paymentRequests) ? state.paymentRequests : [];
    state.paymentTransactions = Array.isArray(state.paymentTransactions) ? state.paymentTransactions : [];
    state.paymentWebhookEvents = Array.isArray(state.paymentWebhookEvents) ? state.paymentWebhookEvents : [];
    state.paymentAuditLogs = Array.isArray(state.paymentAuditLogs) ? state.paymentAuditLogs : [];
    return state;
  }

  refresh() {
    if (this.transactionDepth > 0 && this.state) return this.state;
    this.state = this.ensureCollections(this.loadData());
    return this.state;
  }

  flush() {
    if (this.transactionDepth === 0 && this.state) this.saveData(this.state);
  }

  close() {}

  transaction(fn) {
    this.refresh();
    const backup = clone(this.state);
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) this.saveData(this.state);
      return result;
    } catch (error) {
      this.state = backup;
      this.transactionDepth -= 1;
      throw error;
    }
  }

  insertPaymentRequest(input, entity) {
    const state = this.refresh();
    const createdAt = nowIso();
    const row = {
      id: makeId('preq'),
      client_invoice_id: input.client_invoice_id || null,
      invoice_number: input.invoice_number || null,
      customer_id: input.customer_id || null,
      customer_name: input.customer?.name || null,
      customer_email: input.customer?.email || null,
      customer_contact: input.customer?.contact || null,
      reference_id: entity.reference_id,
      razorpay_payment_link_id: entity.id,
      razorpay_order_id: entity.order_id || null,
      short_url: entity.short_url || null,
      currency: entity.currency || input.currency || 'INR',
      amount: Number(entity.amount ?? input.amount_paise),
      amount_paid: Number(entity.amount_paid || 0),
      balance_due: Math.max(0, Number(entity.amount ?? input.amount_paise) - Number(entity.amount_paid || 0)),
      accept_partial: Boolean(entity.accept_partial),
      first_min_partial_amount: entity.first_min_partial_amount || null,
      status: entity.status || 'created',
      description: entity.description || input.description || null,
      expire_by: entity.expire_by || null,
      paid_at: entity.status === 'paid' ? (entity.updated_at || Math.floor(Date.now() / 1000)) : null,
      razorpay_created_at: entity.created_at || null,
      razorpay_updated_at: entity.updated_at || entity.created_at || null,
      notes: entity.notes || input.notes || null,
      raw_response: entity,
      created_at: createdAt,
      updated_at: createdAt
    };
    state.paymentRequests.unshift(row);
    this.audit('payment_link_created', 'payment_request', row.id, { reference_id: row.reference_id, razorpay_id: row.razorpay_payment_link_id });
    this.flush();
    return clone(row);
  }

  upsertPaymentRequestFromRazorpay(entity, fallback = {}) {
    if (!entity?.id) throw new Error('Razorpay Payment Link entity is missing id.');
    const state = this.refresh();
    const index = state.paymentRequests.findIndex(item => item.razorpay_payment_link_id === entity.id);
    const existing = index >= 0 ? state.paymentRequests[index] : null;
    const updatedAt = Number(entity.updated_at || entity.created_at || Math.floor(Date.now() / 1000));
    if (existing && existing.razorpay_updated_at && updatedAt < existing.razorpay_updated_at) return clone(existing);

    const amount = Number(entity.amount || existing?.amount || 0);
    const amountPaid = Number(entity.amount_paid || 0);
    const values = {
      id: existing?.id || makeId('preq'),
      client_invoice_id: existing?.client_invoice_id || fallback.client_invoice_id || entity.notes?.client_invoice_id || null,
      invoice_number: existing?.invoice_number || fallback.invoice_number || entity.notes?.invoice_number || entity.reference_id || null,
      customer_id: existing?.customer_id || fallback.customer_id || entity.notes?.customer_id || null,
      customer_name: entity.customer?.name || existing?.customer_name || null,
      customer_email: entity.customer?.email || existing?.customer_email || null,
      customer_contact: entity.customer?.contact || existing?.customer_contact || null,
      reference_id: entity.reference_id || existing?.reference_id || entity.id,
      razorpay_payment_link_id: entity.id,
      razorpay_order_id: entity.order_id || existing?.razorpay_order_id || null,
      short_url: entity.short_url || existing?.short_url || null,
      currency: entity.currency || existing?.currency || 'INR',
      amount,
      amount_paid: amountPaid,
      balance_due: Math.max(0, amount - amountPaid),
      accept_partial: Boolean(entity.accept_partial),
      first_min_partial_amount: entity.first_min_partial_amount || existing?.first_min_partial_amount || null,
      status: entity.status || existing?.status || 'created',
      description: entity.description || existing?.description || null,
      expire_by: entity.expire_by || existing?.expire_by || null,
      paid_at: entity.status === 'paid' ? (entity.updated_at || existing?.paid_at || Math.floor(Date.now() / 1000)) : existing?.paid_at || null,
      razorpay_created_at: entity.created_at || existing?.razorpay_created_at || null,
      razorpay_updated_at: updatedAt,
      notes: entity.notes || existing?.notes || null,
      raw_response: entity,
      created_at: existing?.created_at || nowIso(),
      updated_at: nowIso()
    };
    if (index >= 0) state.paymentRequests[index] = values;
    else state.paymentRequests.unshift(values);
    this.flush();
    return clone(values);
  }

  upsertPaymentTransaction(entity, requestId = null) {
    if (!entity?.id) return null;
    const state = this.refresh();
    const index = state.paymentTransactions.findIndex(item => item.razorpay_payment_id === entity.id);
    const existing = index >= 0 ? state.paymentTransactions[index] : null;
    const row = {
      id: existing?.id || makeId('ptxn'),
      payment_request_id: requestId || existing?.payment_request_id || null,
      razorpay_payment_id: entity.id,
      razorpay_order_id: entity.order_id || existing?.razorpay_order_id || null,
      amount: Number(entity.amount || 0),
      currency: entity.currency || 'INR',
      status: entity.status || null,
      method: entity.method || null,
      captured: Boolean(entity.captured),
      email: entity.email || null,
      contact: entity.contact || null,
      fee: entity.fee ?? null,
      tax: entity.tax ?? null,
      amount_refunded: Number(entity.amount_refunded || 0),
      created_at_razorpay: entity.created_at || null,
      raw_payload: entity,
      created_at: existing?.created_at || nowIso(),
      updated_at: nowIso()
    };
    if (index >= 0) state.paymentTransactions[index] = row;
    else state.paymentTransactions.unshift(row);
    this.flush();
    return clone(row);
  }

  getPaymentRequestById(id) {
    const state = this.refresh();
    const item = state.paymentRequests.find(row => row.id === id);
    return item ? clone(item) : null;
  }

  getPaymentRequestByRazorpayId(id) {
    const state = this.refresh();
    const item = state.paymentRequests.find(row => row.razorpay_payment_link_id === id);
    return item ? clone(item) : null;
  }

  getPaymentRequestByReference(referenceId) {
    const state = this.refresh();
    const item = state.paymentRequests.find(row => row.reference_id === referenceId);
    return item ? clone(item) : null;
  }

  listPaymentRequests({ invoiceId, status, limit = 100, offset = 0 } = {}) {
    const state = this.refresh();
    let rows = [...state.paymentRequests];
    if (invoiceId) rows = rows.filter(row => row.client_invoice_id === invoiceId);
    if (status) rows = rows.filter(row => row.status === status);
    rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return clone(rows.slice(safeOffset, safeOffset + safeLimit));
  }

  getTransactionByRazorpayId(id) {
    const state = this.refresh();
    const item = state.paymentTransactions.find(row => row.razorpay_payment_id === id);
    return item ? clone(item) : null;
  }

  listTransactions({ invoiceId, limit = 100, offset = 0 } = {}) {
    const state = this.refresh();
    let rows = [...state.paymentTransactions];
    if (invoiceId) {
      const requestIds = new Set(state.paymentRequests.filter(row => row.client_invoice_id === invoiceId).map(row => row.id));
      rows = rows.filter(row => requestIds.has(row.payment_request_id));
    }
    rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return clone(rows.slice(safeOffset, safeOffset + safeLimit));
  }

  invoiceSummary(invoiceId) {
    const state = this.refresh();
    const requests = state.paymentRequests.filter(row => row.client_invoice_id === invoiceId);
    if (!requests.length) return { client_invoice_id: invoiceId, requested_amount: 0, amount_paid: 0, balance_due: 0, status: 'not_requested' };
    const requestIds = new Set(requests.map(row => row.id));
    const transactions = state.paymentTransactions.filter(row => requestIds.has(row.payment_request_id));
    const requestedAmount = Math.max(...requests.map(row => Number(row.amount || 0)), 0);
    const linkAmountPaid = Math.max(...requests.map(row => Number(row.amount_paid || 0)), 0);
    const capturedTransactions = transactions.filter(row => ['paid', 'captured'].includes(String(row.status || '').toLowerCase())).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const balanceDue = Math.max(...requests.map(row => Number(row.balance_due || 0)), 0);
    const rank = Math.max(...requests.map(row => row.status === 'paid' ? 3 : row.status === 'partially_paid' ? 2 : row.status === 'created' ? 1 : 0), 0);
    return {
      client_invoice_id: invoiceId,
      invoice_number: requests[0].invoice_number,
      requested_amount: requestedAmount,
      amount_paid: Math.max(linkAmountPaid, capturedTransactions),
      balance_due: balanceDue,
      status: rank === 3 ? 'paid' : rank === 2 ? 'partially_paid' : rank === 1 ? 'payment_requested' : 'not_requested'
    };
  }

  dashboardSummary() {
    const state = this.refresh();
    const requests = state.paymentRequests;
    const transactions = state.paymentTransactions;
    return {
      total_links: requests.length,
      pending_links: requests.filter(row => row.status === 'created').length,
      partially_paid_links: requests.filter(row => row.status === 'partially_paid').length,
      paid_links: requests.filter(row => row.status === 'paid').length,
      expired_links: requests.filter(row => row.status === 'expired').length,
      cancelled_links: requests.filter(row => row.status === 'cancelled').length,
      amount_collected: requests.reduce((sum, row) => sum + Number(row.amount_paid || 0), 0),
      total_transactions: transactions.length,
      captured_amount: transactions.filter(row => row.captured).reduce((sum, row) => sum + Number(row.amount || 0), 0),
      refunded_amount: transactions.reduce((sum, row) => sum + Number(row.amount_refunded || 0), 0),
      fees: transactions.reduce((sum, row) => sum + Number(row.fee || 0), 0),
      fee_tax: transactions.reduce((sum, row) => sum + Number(row.tax || 0), 0),
      currency: 'INR'
    };
  }

  insertWebhookEvent(eventId, eventType, payload, signatureVerified) {
    const state = this.refresh();
    if (state.paymentWebhookEvents.some(row => row.event_id === eventId)) return false;
    state.paymentWebhookEvents.unshift({ event_id: eventId, event_type: eventType || null, signature_verified: Boolean(signatureVerified), payload, received_at: nowIso(), processed_at: null, processing_error: null });
    state.paymentWebhookEvents = state.paymentWebhookEvents.slice(0, 1000);
    this.flush();
    return true;
  }

  markWebhookProcessed(eventId, error = null) {
    const state = this.refresh();
    const row = state.paymentWebhookEvents.find(item => item.event_id === eventId);
    if (row) {
      row.processed_at = nowIso();
      row.processing_error = error ? String(error).slice(0, 2000) : null;
      this.flush();
    }
  }

  audit(action, entityType, entityId, detail) {
    const state = this.state || this.refresh();
    state.paymentAuditLogs.unshift({ id: makeId('audit'), action, entity_type: entityType || null, entity_id: entityId || null, detail, created_at: nowIso() });
    state.paymentAuditLogs = state.paymentAuditLogs.slice(0, 1000);
    this.flush();
  }
}

module.exports = { PaymentJsonDatabase };
