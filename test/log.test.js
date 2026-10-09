import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, preview } from '../src/log.js';

const sink = () => {
  const out = [];
  const rec = (stream) => (...a) => out.push(`${stream}: ${a.join(' ')}`);
  return { out, log: rec('stdout'), warn: rec('stderr'), error: rec('stderr') };
};
const at = () => new Date(2026, 9, 8, 9, 5, 7, 42);

test('createLogger prefixes a timestamp and level, and filters below the minimum level', () => {
  const s = sink();
  const log = createLogger({ level: 'info', sink: s, now: at });
  log.debug('hidden');
  log.info('[bot] hello');
  log.warn('careful');
  log.error('broken');
  assert.deepEqual(s.out, ['stdout: 09:05:07.042 INFO  [bot] hello', 'stderr: 09:05:07.042 WARN  careful', 'stderr: 09:05:07.042 ERROR broken']);
});

test('debug level shows everything; unknown level falls back to info', () => {
  const s = sink();
  createLogger({ level: 'debug', sink: s, now: at }).debug('x');
  createLogger({ level: 'nonsense', sink: s, now: at }).debug('y');
  assert.deepEqual(s.out, ['stdout: 09:05:07.042 DEBUG x']);
});

test('preview flattens and shortens', () => {
  assert.equal(preview('a\n\n  b'), 'a b');
  assert.equal(preview('x'.repeat(10), 5), 'xxxx…');
  assert.equal(preview(null), '');
});
