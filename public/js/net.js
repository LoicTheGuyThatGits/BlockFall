/**
 * WebSocket transport.
 *
 * Wraps the socket with auto-reconnect, a message queue for the offline
 * window, and latency tracking. Everything above this layer works with plain
 * objects and never touches a raw socket.
 */

import { MSG } from '../../src/core/protocol.js';

/**
 * Minimal event emitter.
 *
 * This deliberately does not extend EventTarget: the client can run in more
 * than one realm (the test harness boots several), and Node's EventTarget
 * refuses events created by another realm's CustomEvent.
 */
class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(type, fn) {
    let list = this._handlers.get(type);
    if (!list) {
      list = [];
      this._handlers.set(type, list);
    }
    list.push(fn);
    return this;
  }

  off(type, fn) {
    const list = this._handlers.get(type);
    if (!list) return this;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }

  emit(type, detail) {
    const list = this._handlers.get(type);
    if (list) {
      // Copy first so a handler can unsubscribe during dispatch.
      for (const fn of list.slice()) fn(detail);
    }
    const all = this._handlers.get('*');
    if (all) for (const fn of all.slice()) fn({ t: type, ...detail });
  }
}

export class Net extends Emitter {
  constructor(win = window) {
    super();
    this.win = win;
    this.ws = null;
    this.queue = [];
    this.connected = false;
    this.retry = 0;
    this.retryTimer = null;
    this.latency = 0;
    this.pingTimer = null;
    this.url = resolveUrl(this.win);
    this.manualClose = false;
  }

  connect() {
    const OPEN = 1;
    const CONNECTING = 0;
    if (this.ws && (this.ws.readyState === OPEN || this.ws.readyState === CONNECTING)) {
      return;
    }
    this.manualClose = false;
    this.emit('status', { state: 'connecting' });

    let ws;
    try {
      ws = new this.win.WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.emit('status', { state: 'connected' });
      // Flush anything queued while offline.
      const pending = this.queue.splice(0);
      for (const m of pending) this.send(m, true);
      this.startPing();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === MSG.PONG) {
        this.latency = Date.now() - (msg.c || Date.now());
        return;
      }
      // Emitter.emit also fans out to '*' listeners.
      this.emit(msg.t, msg);
    };

    ws.onclose = () => {
      this.connected = false;
      this.stopPing();
      this.emit('status', { state: 'disconnected' });
      if (!this.manualClose) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows, so reconnection is handled there.
    };
  }

  send(msg, skipQueue = false) {
    if (this.connected && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    if (!skipQueue) {
      this.queue.push(msg);
      if (this.queue.length > 200) this.queue.shift();
    }
    return false;
  }

  /** Rate-limited heartbeat to measure round-trip latency. */
  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ t: MSG.PING, c: Date.now() });
    }, 2000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  scheduleReconnect() {
    if (this.retryTimer) return;
    // Backoff up to 10s.
    const delay = Math.min(1000 * 2 ** this.retry, 10_000);
    this.retry++;
    this.emit('status', { state: 'reconnecting', in: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  close() {
    this.manualClose = true;
    this.stopPing();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }
    this.ws = null;
    this.connected = false;
  }

  }

/**
 * Work out the WebSocket URL. Same origin by default, so the app works with no
 * configuration at all. Point it at a different host by setting the
 * `blockfall.server` localStorage key to that origin.
 */
function resolveUrl(win) {
  let override = null;
  try {
    override = win.localStorage.getItem('blockfall.server');
  } catch {
    // Private browsing can throw on storage access; the default still works.
  }
  const secure = win.location.protocol === 'https:';
  const proto = secure ? 'wss:' : 'ws:';

  if (override) {
    const trimmed = override.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return /^wss?:\/\//.test(override) ? override : `${proto}//${trimmed}/ws`;
  }
  return `${proto}//${win.location.host}/ws`;
}