'use strict';

const crypto = require('node:crypto');

const SUPPORTED_WEBHOOK_EVENTS = new Set([
  'payment_link.paid',
  'payment_link.partially_paid',
  'payment_link.cancelled',
  'payment_link.expired'
]);

class ValidationError extends Error {
  constructor(message, fields = null) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.fields = fields;
  }
}

function cleanText(value, max = 250) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function cleanEmail(value) {
  const email = cleanText(value, 254);
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Customer email is invalid.', { customer_email: 'invalid' });
  return email;
}

function cleanContact(value) {
  const contact = cleanText(value, 20).replace(/[\s()-]/g, '');
  if (!contact) return '';
  if (!/^\+?[0-9]{8,15}$/.test(contact)) throw new ValidationError('Customer contact number is invalid.', { customer_contact: 'invalid' });
  return contact;
}

function unixTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Number.isInteger(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError('expire_by must be a valid ISO date or Unix timestamp.');
  return Math.floor(date.getTime() / 1000);
}

function uniqueReference(invoiceNumber, db) {
  const base = cleanText(invoiceNumber || 'INV', 28).replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'INV';
  for (let i = 0; i < 10; i += 1) {
    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const ref = `${base.slice(0, 31)}-${suffix}`.slice(0, 40);
    if (!db.getPaymentRequestByReference(ref)) return ref;
  }
  throw new Error('Could not generate a unique Razorpay reference ID.');
}

function validateCreateInput(body, db) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('A JSON object is required.');

  const amount = Number(body.amount_paise);
  if (!Number.isSafeInteger(amount) || amount < 100) {
    throw new ValidationError('amount_paise must be an integer of at least 100 paise (₹1.00).', { amount_paise: 'invalid' });
  }

  const invoiceId = cleanText(body.client_invoice_id, 120);
  const invoiceNumber = cleanText(body.invoice_number, 120);
  if (!invoiceId) throw new ValidationError('client_invoice_id is required.', { client_invoice_id: 'required' });
  if (!invoiceNumber) throw new ValidationError('invoice_number is required.', { invoice_number: 'required' });

  const acceptPartial = Boolean(body.accept_partial);
  let firstMin = body.first_min_partial_amount_paise === undefined || body.first_min_partial_amount_paise === null
    ? null
    : Number(body.first_min_partial_amount_paise);
  if (acceptPartial) {
    if (firstMin === null) firstMin = Math.min(amount, Math.max(100, Math.floor(amount * 0.25)));
    if (!Number.isSafeInteger(firstMin) || firstMin < 100 || firstMin > amount) {
      throw new ValidationError('first_min_partial_amount_paise must be between ₹1.00 and the requested amount.');
    }
  } else {
    firstMin = null;
  }

  const expireBy = unixTimestamp(body.expire_by);
  const now = Math.floor(Date.now() / 1000);
  if (expireBy && expireBy <= now + 300) throw new ValidationError('expire_by must be at least 5 minutes in the future.');
  if (expireBy && expireBy > now + (183 * 24 * 60 * 60)) throw new ValidationError('expire_by cannot be more than six months in the future.');

  const customer = body.customer && typeof body.customer === 'object' ? {
    name: cleanText(body.customer.name, 120),
    email: cleanEmail(body.customer.email),
    contact: cleanContact(body.customer.contact)
  } : { name: '', email: '', contact: '' };

  const notify = body.notify && typeof body.notify === 'object' ? {
    sms: Boolean(body.notify.sms && customer.contact),
    email: Boolean(body.notify.email && customer.email)
  } : { sms: false, email: false };

  let referenceId = cleanText(body.reference_id, 40);
  if (referenceId && db.getPaymentRequestByReference(referenceId)) throw new ValidationError('reference_id is already in use.');
  if (!referenceId) referenceId = uniqueReference(invoiceNumber, db);

  const description = cleanText(body.description || `Payment against Invoice ${invoiceNumber} issued by INCENTIFY Private Limited`, 255);
  const notes = {
    ...(body.notes && typeof body.notes === 'object' ? body.notes : {}),
    client_invoice_id: invoiceId,
    invoice_number: invoiceNumber,
    customer_id: cleanText(body.customer_id, 120)
  };
  for (const [key, value] of Object.entries(notes)) {
    delete notes[key];
    const cleanKey = cleanText(key, 64).replace(/[^A-Za-z0-9_-]/g, '_');
    if (cleanKey) notes[cleanKey] = cleanText(value, 250);
  }

  return {
    client_invoice_id: invoiceId,
    invoice_number: invoiceNumber,
    customer_id: cleanText(body.customer_id, 120) || null,
    amount_paise: amount,
    currency: cleanText(body.currency || 'INR', 3).toUpperCase(),
    accept_partial: acceptPartial,
    first_min_partial_amount_paise: firstMin,
    expire_by: expireBy,
    description,
    reference_id: referenceId,
    customer,
    notify,
    reminder_enable: Boolean(body.reminder_enable),
    notes
  };
}

function razorpayPayload(input) {
  const payload = {
    amount: input.amount_paise,
    currency: input.currency,
    accept_partial: input.accept_partial,
    reference_id: input.reference_id,
    description: input.description,
    customer: {},
    notify: input.notify,
    reminder_enable: input.reminder_enable,
    notes: input.notes
  };
  if (input.customer.name) payload.customer.name = input.customer.name;
  if (input.customer.email) payload.customer.email = input.customer.email;
  if (input.customer.contact) payload.customer.contact = input.customer.contact;
  if (!Object.keys(payload.customer).length) delete payload.customer;
  if (input.expire_by) payload.expire_by = input.expire_by;
  if (input.accept_partial && input.first_min_partial_amount_paise) {
    payload.first_min_partial_amount = input.first_min_partial_amount_paise;
  }
  return payload;
}

class PaymentService {
  constructor({ db, razorpay, logger }) {
    this.db = db;
    this.razorpay = razorpay;
    this.logger = logger;
  }

  async gatewayStatus() {
    const started = Date.now();
    const result = await this.razorpay.fetchPaymentLinks(1);
    return {
      connected: true,
      latency_ms: Date.now() - started,
      razorpay_entity: result.entity || 'collection',
      visible_items: Array.isArray(result.items) ? result.items.length : 0
    };
  }

  async createPaymentLink(body) {
    const input = validateCreateInput(body, this.db);
    const entity = await this.razorpay.createPaymentLink(razorpayPayload(input));
    const saved = this.db.insertPaymentRequest(input, entity);
    return { payment_request: saved, razorpay: entity };
  }

  async fetchAndSyncPaymentLink(razorpayId) {
    const entity = await this.razorpay.fetchPaymentLink(razorpayId);
    const saved = this.db.transaction(() => {
      const request = this.db.upsertPaymentRequestFromRazorpay(entity);
      if (Array.isArray(entity.payments)) {
        for (const payment of entity.payments) this.db.upsertPaymentTransaction(payment, request.id);
      }
      this.db.audit('payment_link_synced', 'payment_request', request.id, { razorpay_id: razorpayId, status: entity.status });
      return request;
    });
    return { payment_request: saved, razorpay: entity };
  }

  async cancelPaymentLink(razorpayId) {
    const entity = await this.razorpay.cancelPaymentLink(razorpayId);
    const saved = this.db.transaction(() => {
      const request = this.db.upsertPaymentRequestFromRazorpay(entity);
      this.db.audit('payment_link_cancelled', 'payment_request', request.id, { razorpay_id: razorpayId });
      return request;
    });
    return { payment_request: saved, razorpay: entity };
  }

  processWebhook(eventId, event) {
    const eventType = event?.event || 'unknown';
    const inserted = this.db.insertWebhookEvent(eventId, eventType, event, true);
    if (!inserted) return { duplicate: true, event_id: eventId };

    if (!SUPPORTED_WEBHOOK_EVENTS.has(eventType)) {
      this.db.markWebhookProcessed(eventId);
      return { accepted: true, ignored: true, event: eventType };
    }

    try {
      const result = this.db.transaction(() => {
        const paymentLink = event?.payload?.payment_link?.entity;
        if (!paymentLink?.id) throw new Error('Webhook payload does not contain payment_link.entity.id.');
        const request = this.db.upsertPaymentRequestFromRazorpay(paymentLink);
        const payment = event?.payload?.payment?.entity;
        const transaction = payment ? this.db.upsertPaymentTransaction(payment, request.id) : null;
        this.db.audit('webhook_processed', 'payment_request', request.id, {
          event_id: eventId,
          event: eventType,
          status: request.status,
          payment_id: transaction?.razorpay_payment_id || null
        });
        return { request, transaction };
      });
      this.db.markWebhookProcessed(eventId);
      return {
        accepted: true,
        event: eventType,
        payment_link_id: result.request.razorpay_payment_link_id,
        status: result.request.status,
        payment_id: result.transaction?.razorpay_payment_id || null
      };
    } catch (error) {
      this.db.markWebhookProcessed(eventId, error.message);
      this.logger?.error('Webhook processing failed', { eventId, eventType, error: error.message });
      throw error;
    }
  }
}

module.exports = { PaymentService, ValidationError, validateCreateInput, razorpayPayload, SUPPORTED_WEBHOOK_EVENTS };
