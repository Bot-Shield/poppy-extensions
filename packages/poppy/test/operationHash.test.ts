/**
 * The shared operation hash, checked against the 17 published vectors for PAP #71/#74
 * (test/fixtures/operation-hash-vectors.json, source named inside it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { operationHash, operationHashInput } from '../src/operationHash.ts';

const { cases } = JSON.parse(readFileSync(new URL('./fixtures/operation-hash-vectors.json', import.meta.url), 'utf8'));

for (const c of cases) {
  test(`vector ${c.id} (${c.expect})`, async () => {
    if (c.expect === 'reject' || c.expect === 'decision') {
      assert.throws(() => operationHashInput(c.operation));
      return;
    }
    assert.equal(operationHashInput(c.operation), c.hash_input);
    assert.equal(await operationHash(c.operation), c.operation_hash);
  });
}

test('the same-* cases all name one hash', async () => {
  const same = cases.filter((c: any) => c.id.startsWith('same-'));
  const hashes = new Set(await Promise.all(same.map((c: any) => operationHash(c.operation))));
  assert.equal(hashes.size, 1);
});
