const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Console logger with timestamps and a minimum level. Lines look like `12:34:56.789 INFO  [bot] ...`. */
export function createLogger({ level = 'info', sink = console, now = () => new Date() } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const stamp = () => {
    const d = now();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  const make = (name, out) => (LEVELS[name] < min ? () => {} : (...args) => out(stamp(), name.toUpperCase().padEnd(5), ...args));
  return {
    debug: make('debug', sink.log.bind(sink)),
    info: make('info', sink.log.bind(sink)),
    warn: make('warn', sink.warn.bind(sink)),
    error: make('error', sink.error.bind(sink)),
  };
}

/** Shorten text for a log line: one line, at most `max` chars. */
export const preview = (text, max = 120) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};
