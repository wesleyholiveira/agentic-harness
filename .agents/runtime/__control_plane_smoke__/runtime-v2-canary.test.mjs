import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeV2Canary } from './runtime-v2-canary.mjs';

test('runtimeV2Canary preserves each input in the ordered ok/value result', () => {
  assert.equal(typeof runtimeV2Canary, 'function');
  assert.equal(runtimeV2Canary.length, 1);

  for (const value of [undefined, null, false, 0, 'sample', {}, [], Symbol('sample')]) {
    const result = runtimeV2Canary(value);

    assert.equal(result.ok, true);
    assert.strictEqual(result.value, value);
    assert.deepEqual(Object.keys(result), ['ok', 'value']);
  }
});
