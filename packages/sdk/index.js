/**
 * PrintAgent.js — @jp-pos/print-agent-sdk
 * ─────────────────────────────────────────────────────────────────────────────
 * The official client SDK for interacting with the local or remote Print Agent service.
 */

'use strict';

const EventEmitter = require('events');

class PrintAgent extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} [options.endpoint='http://127.0.0.1:9200'] - Agent HTTP base URL
   * @param {string} options.token - Authorization Bearer token
   * @param {number} [options.timeout=10000] - Request timeout (ms)
   */
  constructor(options = {}) {
    super();
    this.endpoint = (options.endpoint || 'http://127.0.0.1:9200').replace(/\/$/, '');
    this.token = options.token;
    this.timeout = options.timeout || 10000;
    this.connected = false;

    // Sub-namespaces
    this.printers = {
      list: () => this._request('GET', '/v1/printers'),
      get: (id) => this._request('GET', `/v1/printers/${encodeURIComponent(id)}`),
    };

    this.jobs = {
      get: (id) => this._request('GET', `/v1/jobs/${encodeURIComponent(id)}`),
      cancel: (id) => this._request('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`),
      retry: (id) => this._request('POST', `/v1/jobs/${encodeURIComponent(id)}/retry`),
    };
  }

  /** Connect & verify agent readiness */
  async connect() {
    try {
      const health = await this.health();
      if (health.status === 'ok') {
        this.connected = true;
        this.emit('connected', health);
        return true;
      }
      throw new Error(`Agent health check failed: status=${health.status}`);
    } catch (err) {
      this.connected = false;
      this.emit('disconnected', err);
      throw err;
    }
  }

  /** Check service health status */
  async health() {
    return this._request('GET', '/v1/health', null, false);
  }

  /**
   * Submit a print job to the agent.
   *
   * @param {Object} params
   * @param {string} params.printerId - Registered printer alias
   * @param {'tspl'|'escpos'|'raw'} [params.format='tspl'] - Format
   * @param {string|Buffer} params.data - Print payload
   * @param {string} [params.idempotencyKey] - Unique key
   * @returns {Promise<Object>} Print job submission response
   */
  async print({ printerId, format = 'tspl', data, idempotencyKey }) {
    if (!printerId) throw new Error('printerId is required.');
    if (!data) throw new Error('data payload is required.');

    const headers = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    try {
      const res = await this._request('POST', '/v1/jobs', {
        printerId,
        format,
        payload: data,
        idempotencyKey,
      }, true, headers);

      this.emit('job:submitted', res);
      return res;
    } catch (err) {
      this.emit('job:failed', err);
      throw err;
    }
  }

  /** Disconnect agent SDK session */
  async disconnect() {
    this.connected = false;
    this.emit('disconnected');
  }

  /** Internal HTTP request helper */
  async _request(method, path, body = null, requireAuth = true, extraHeaders = {}) {
    const url = `${this.endpoint}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };

    if (requireAuth && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const options = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    options.signal = controller.signal;

    try {
      const res = await fetch(url, options);
      clearTimeout(timeoutId);

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(json.error || `HTTP error ${res.status}: ${res.statusText}`);
        err.status = res.status;
        err.code = json.code || 'HTTP_ERROR';
        throw err;
      }
      return json;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        const tErr = new Error(`Request timed out after ${this.timeout}ms`);
        tErr.code = 'TIMEOUT';
        throw tErr;
      }
      throw err;
    }
  }
}

module.exports = { PrintAgent };
