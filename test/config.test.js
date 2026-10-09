import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const wikis = (env) => loadConfig({ XAI_API_KEY: 'k', ...env }).wikis;

test('WIKIS: defaults to nightreign, accepts lists and "none", rejects unknown ids', () => {
  assert.deepEqual(wikis({}), ['nightreign']);
  assert.deepEqual(wikis({ WIKIS: ' Nightreign , nightreign ' }), ['nightreign']);
  assert.deepEqual(wikis({ WIKIS: 'none' }), []);
  assert.deepEqual(wikis({ WIKIS: '' }), []);
  assert.throws(() => wikis({ WIKIS: 'nightreign,nope' }), /Unknown wiki "nope" in WIKIS \(known: nightreign\)/);
});

test('NIGHTREIGN_WIKI=0 still turns the Nightreign wiki off', () => {
  assert.deepEqual(wikis({ NIGHTREIGN_WIKI: '0' }), []);
  assert.deepEqual(wikis({ NIGHTREIGN_WIKI: 'false' }), []);
  assert.deepEqual(wikis({ NIGHTREIGN_WIKI: '1' }), ['nightreign']);
});
