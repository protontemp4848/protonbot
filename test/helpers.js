export const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

/** Logger that records lines as "level message" for assertions. */
export const recordingLog = () => {
  const lines = [];
  const at = (level) => (...a) => lines.push(`${level} ${a.join(' ')}`);
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
};

/** In-memory stand-in for the WebSocket global. */
export class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.#fire('open', {});
    });
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.#fire('close', {});
  }
  serverSends(line) {
    this.#fire('message', { data: line + '\r\n' });
  }
  #fire(type, e) {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
