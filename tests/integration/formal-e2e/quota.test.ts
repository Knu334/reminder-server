import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, harnessConfig } from '../../support/stateful-store.ts';
import { syntheticPngBytes, testBudget, validCreate } from '../../support/fixtures.ts';

/**
 * Layer I: the default 1000 item / 128 MiB per-owner limits (never lowered) against a synthetic counter set just below the cap,
 * through the real service and adapter. The lowered-cap recovery cases remain separate evidence in tests/runtime/lowered-quotas.test.ts.
 */
const OWNER = 'owner-quota'; const ITEMS = 1000; const BYTES = 134_217_728; const IMAGE = 1_048_576;
const png = (bytes: number): string => Buffer.concat([syntheticPngBytes, Buffer.alloc(bytes - syntheticPngBytes.length)]).toString('base64');
const code = (error: unknown): string | undefined => (error as { code?: string }).code;

void test('the specified default limits are in force', () => {
  assert.equal(harnessConfig.limits.itemCount, ITEMS); assert.equal(harnessConfig.limits.imageBytes, BYTES); assert.equal(harnessConfig.limits.thumbnailBytes, IMAGE);
  assert.equal(BYTES, 128 * IMAGE);
});

void test('STORE-06/items-1000-boundary-i: the 1000th item succeeds and the 1001st is refused with OWNER_STORAGE_LIMIT_EXCEEDED', async () => {
  const h = createHarness(); h.seedStorage(OWNER, ITEMS - 1, 0);
  const last = await h.service.create(OWNER, validCreate({ id: 'last' }), testBudget()); assert.equal(h.snapshot().storage[0]?.itemCount, ITEMS);
  await assert.rejects(h.service.create(OWNER, validCreate({ id: 'over' }), testBudget()), { status: 413, code: 'OWNER_STORAGE_LIMIT_EXCEEDED' });
  const snap = h.snapshot(); assert.equal(snap.storage[0]?.itemCount, ITEMS); assert.equal(snap.reminders.length, 1);
  // Non-growth at the cap is still allowed.
  await h.service.patch(OWNER, 'last', last.etag, { title: 'edit at cap' }, testBudget()); assert.equal(h.snapshot().storage[0]?.itemCount, ITEMS);
});

void test('STORE-06/items-1000-concurrent-i: two creates from 999 give one success and one 413', async () => {
  const h = createHarness(); h.seedStorage(OWNER, ITEMS - 1, 0);
  const results = await Promise.allSettled(['a', 'b'].map(id => h.service.create(OWNER, validCreate({ id }), testBudget())));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult; assert.deepEqual({ status: (refused.reason as { status: number }).status, code: code(refused.reason) }, { status: 413, code: 'OWNER_STORAGE_LIMIT_EXCEEDED' });
  const snap = h.snapshot(); assert.equal(snap.storage[0]?.itemCount, ITEMS); assert.equal(snap.reminders.length, 1);
});

void test('STORE-06/items-1000-delete-recovery-i: deleting one item at the cap frees exactly one slot', async () => {
  const h = createHarness(); h.seedStorage(OWNER, ITEMS - 1, 0);
  const full = await h.service.create(OWNER, validCreate({ id: 'full' }), testBudget());
  await assert.rejects(h.service.create(OWNER, validCreate({ id: 'blocked' }), testBudget()), { status: 413 });
  await h.service.remove(OWNER, 'full', full.etag, testBudget()); assert.equal(h.snapshot().storage[0]?.itemCount, ITEMS - 1);
  await h.service.create(OWNER, validCreate({ id: 'recovered' }), testBudget()); assert.equal(h.snapshot().storage[0]?.itemCount, ITEMS);
  await assert.rejects(h.service.create(OWNER, validCreate({ id: 'blocked-again' }), testBudget()), { status: 413 });
});

void test('STORE-06/image-128mib-boundary-i: images may fill exactly 134217728 bytes and one more byte is refused', async () => {
  const h = createHarness(); h.seedStorage(OWNER, 0, BYTES - IMAGE);
  await h.service.create(OWNER, validCreate({ id: 'fill', thumbnail: png(IMAGE) }), testBudget());
  assert.equal(h.snapshot().storage[0]?.imageBytes, BYTES);
  await assert.rejects(h.service.create(OWNER, validCreate({ id: 'over', thumbnail: png(syntheticPngBytes.length + 1) }), testBudget()), { status: 413, code: 'OWNER_STORAGE_LIMIT_EXCEEDED' });
  const snap = h.snapshot(); assert.equal(snap.storage[0]?.imageBytes, BYTES); assert.equal(snap.reminders.length, 1); assert.equal(snap.jobs.filter(job => job.state === 'committed').length, 1);
  await h.service.create(OWNER, validCreate({ id: 'no-image' }), testBudget()); assert.equal(h.snapshot().storage[0]?.imageBytes, BYTES);
});

void test('STORE-06/image-128mib-concurrent-i: two 1 MiB creates from one slot below the cap give one success and one 413', async () => {
  const h = createHarness(); h.seedStorage(OWNER, 0, BYTES - IMAGE);
  const results = await Promise.allSettled(['a', 'b'].map(id => h.service.create(OWNER, validCreate({ id, thumbnail: png(IMAGE) }), testBudget())));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult; assert.deepEqual({ status: (refused.reason as { status: number }).status, code: code(refused.reason) }, { status: 413, code: 'OWNER_STORAGE_LIMIT_EXCEEDED' });
  const snap = h.snapshot(); assert.equal(snap.storage[0]?.imageBytes, BYTES); assert.equal(snap.reminders.length, 1);
  assert.equal(snap.jobs.filter(job => job.state === 'committed').length, 1, 'only the winner commits an image');
});

void test('STORE-06/image-128mib-delete-recovery-i: deleting the image item returns its bytes and allows a new image', async () => {
  const h = createHarness(); h.seedStorage(OWNER, 0, BYTES - IMAGE);
  const full = await h.service.create(OWNER, validCreate({ id: 'full', thumbnail: png(IMAGE) }), testBudget());
  await assert.rejects(h.service.create(OWNER, validCreate({ id: 'blocked', thumbnail: png(IMAGE) }), testBudget()), { status: 413 });
  await h.service.remove(OWNER, 'full', full.etag, testBudget()); assert.equal(h.snapshot().storage[0]?.imageBytes, BYTES - IMAGE);
  await h.service.create(OWNER, validCreate({ id: 'recovered', thumbnail: png(IMAGE) }), testBudget()); assert.equal(h.snapshot().storage[0]?.imageBytes, BYTES);
});
