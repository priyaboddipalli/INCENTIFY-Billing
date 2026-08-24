'use strict';

class RazorpayApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'RazorpayApiError';
    this.status = status || 502;
    this.details = details || null;
  }
}

class RazorpayClient {
  constructor(config) {
    this.keyId = config.keyId;
    this.keySecret = config.keySecret;
    this.apiBaseUrl = config.apiBaseUrl;
    this.timeoutMs = config.timeoutMs || 15000;
  }

  async request(method, endpoint, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`, 'utf8').toString('base64');
    try {
      const response = await fetch(`${this.apiBaseUrl}${endpoint}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) {
        const description = data?.error?.description || data?.error?.reason || `Razorpay API returned HTTP ${response.status}.`;
        throw new RazorpayApiError(description, response.status, data?.error || data);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new RazorpayApiError('Razorpay API request timed out.', 504);
      if (error instanceof RazorpayApiError) throw error;
      throw new RazorpayApiError(`Unable to reach Razorpay API: ${error.message}`, 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  createPaymentLink(payload) { return this.request('POST', '/payment_links', payload); }
  fetchPaymentLink(id) { return this.request('GET', `/payment_links/${encodeURIComponent(id)}`); }
  cancelPaymentLink(id) { return this.request('POST', `/payment_links/${encodeURIComponent(id)}/cancel`); }
  fetchPaymentLinks(count = 1) { return this.request('GET', `/payment_links?count=${Math.min(Math.max(count, 1), 100)}`); }
}

module.exports = { RazorpayClient, RazorpayApiError };
