import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, TimeoutError } from './with-timeout';

describe('Cycle watchdog (withTimeout)', () => {
  test('withTimeout rejects a never-settling promise past the deadline', async () => {
    const hung = new Promise<void>(() => {}); // models a wedged cycle — never settles
    await assert.rejects(withTimeout(hung, 50, 'slow cycle'), TimeoutError);
  });

  test('withTimeout passes a value through when it settles in time', async () => {
    const v = await withTimeout(Promise.resolve(42), 1000, 'fast cycle');
    assert.equal(v, 42);
  });

  test("withTimeout propagates the wrapped promise's own rejection unchanged", async () => {
    const boom = Promise.reject(new Error('upstream 500'));
    await assert.rejects(withTimeout(boom, 1000, 'slow cycle'), (e: Error) => !(e instanceof TimeoutError) && e.message === 'upstream 500');
  });
});
