import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemindersService } from '../../../src/reminders/service.ts';
import type { RemindersStore } from '../../../src/shared/ports.ts';
import { createHarness, harnessConfig } from '../../support/stateful-store.ts';
import { syntheticPngBase64, testBudget, validCreate } from '../../support/fixtures.ts';

/**
 * Layer I: the real service, DynamoDB adapter and transaction semantics of the stateful store, with only the reminders get port wrapped.
 * Both writers read the same old active revision with a consistent get, and only then may either one commit. This is a store-level
 * proof; it is not the E layer (two real HTTP requests through the Gateway), which runs in tests/e2e/floci storage cases.
 */
const OWNER = 'owner-concurrency';
function gated(h: ReturnType<typeof createHarness>, readers: number) {
  const events: string[] = []; let arrived = 0; let release!: () => void; const open = new Promise<void>(resolve => { release = resolve; });
  const reminders: RemindersStore = {
    query: (...args) => h.reminders.query(...args),
    async get(ownerId, id, budget) { const record = await h.reminders.get(ownerId, id, budget); events.push('read'); if (++arrived >= readers) release(); await open; return record; },
    async commit(change, budget) { events.push('commit'); return h.reminders.commit(change, budget); },
  };
  let token = 0;
  const service = createRemindersService({ reminders, owners: h.owners, jobs: h.jobs, images: h.images, config: harnessConfig, clock: () => Date.parse('2026-10-03T00:00:00.000Z'), uuid: () => `11111111-1111-4111-8111-${String(++token).padStart(12, '0')}` });
  return { service, events };
}
const reasons = (results: PromiseSettledResult<unknown>[]) => results.map(result => result.status === 'rejected' ? (result.reason as { status?: number; code?: string }) : null);
const winners = (results: PromiseSettledResult<unknown>[]) => results.filter(result => result.status === 'fulfilled').length;
const bothReadBeforeAnyCommit = (events: string[]) => events.slice(0, 2).join() === 'read,read' && events.indexOf('commit') >= 2;

void test('STORE-03/both-read-old-i: PATCH and PATCH on the same ETag give one success and one 412 with one revision change', async () => {
  const h = createHarness(); const created = await h.service.create(OWNER, validCreate({ id: 'p' }), testBudget());
  const { service, events } = gated(h, 2);
  const results = await Promise.allSettled([service.patch(OWNER, 'p', created.etag, { title: 'first' }, testBudget()), service.patch(OWNER, 'p', created.etag, { title: 'second' }, testBudget())]);
  assert.equal(winners(results), 1); assert.ok(bothReadBeforeAnyCommit(events), events.join());
  const loser = reasons(results).find(item => item !== null); assert.deepEqual({ status: loser?.status, code: loser?.code }, { status: 412, code: 'PRECONDITION_FAILED' });
  const snap = h.snapshot(); const row = snap.reminders[0] as { revision: number; title: string };
  assert.equal(snap.reminders.length, 1); assert.equal(row.revision, 2);
  const won = results.findIndex(result => result.status === 'fulfilled'); assert.equal(row.title, won === 0 ? 'first' : 'second');
  assert.equal(snap.storage[0]?.itemCount, 1);
});

void test('STORE-03/both-read-old-i: DELETE and DELETE give one success and one 412 (not 404), one tombstone and one counter/job change', async () => {
  const h = createHarness(); const created = await h.service.create(OWNER, validCreate({ id: 'd', thumbnail: syntheticPngBase64 }), testBudget());
  const before = h.snapshot(); assert.equal(before.jobs.filter(job => job.state === 'committed').length, 1);
  const { service, events } = gated(h, 2);
  const results = await Promise.allSettled([service.remove(OWNER, 'd', created.etag, testBudget()), service.remove(OWNER, 'd', created.etag, testBudget())]);
  assert.equal(winners(results), 1); assert.ok(bothReadBeforeAnyCommit(events), events.join());
  const loser = reasons(results).find(item => item !== null); assert.deepEqual({ status: loser?.status, code: loser?.code }, { status: 412, code: 'PRECONDITION_FAILED' });
  const snap = h.snapshot();
  assert.deepEqual(Object.keys(snap.reminders[0]!).sort(), ['deleted', 'deletedAt', 'id', 'ownerId', 'revision']); assert.equal((snap.reminders[0] as { revision: number }).revision, 2);
  assert.equal(snap.storage[0]?.itemCount, 0); assert.equal(snap.storage[0]?.imageBytes, 0);
  assert.equal(snap.jobs.filter(job => job.state === 'retired').length, 1); assert.equal(snap.jobs.filter(job => job.state === 'committed').length, 0);
});

void test('STORE-03/both-read-old-i: PATCH and DELETE in either order give one winner, a 412 loser and a consistent final state', async () => {
  for (const order of ['patch-first', 'delete-first'] as const) {
    const h = createHarness(); const created = await h.service.create(OWNER, validCreate({ id: 'm' }), testBudget());
    const { service, events } = gated(h, 2);
    const patch = () => service.patch(OWNER, 'm', created.etag, { title: 'patched' }, testBudget()); const remove = () => service.remove(OWNER, 'm', created.etag, testBudget());
    const results = await Promise.allSettled(order === 'patch-first' ? [patch(), remove()] : [remove(), patch()]);
    assert.equal(winners(results), 1, order); assert.ok(bothReadBeforeAnyCommit(events), events.join());
    const loser = reasons(results).find(item => item !== null); assert.equal(loser?.status, 412, order);
    const patchWon = results[order === 'patch-first' ? 0 : 1]!.status === 'fulfilled'; const snap = h.snapshot(); const row = snap.reminders[0] as { revision: number; deleted: boolean; title?: string };
    assert.equal(row.revision, 2); assert.equal(row.deleted, !patchWon); assert.equal(snap.storage[0]?.itemCount, patchWon ? 1 : 0);
    if (patchWon) assert.equal(row.title, 'patched');
  }
});

void test('STORE-03/both-read-old-i control: when DELETE finishes before the other request reads, the current read answers 404', async () => {
  const h = createHarness(); const created = await h.service.create(OWNER, validCreate({ id: 'c' }), testBudget());
  await h.service.remove(OWNER, 'c', created.etag, testBudget());
  await assert.rejects(h.service.patch(OWNER, 'c', created.etag, { title: 'late' }, testBudget()), { status: 404, code: 'REMINDER_NOT_FOUND' });
  await assert.rejects(h.service.remove(OWNER, 'c', created.etag, testBudget()), { status: 404 });
  assert.equal(h.snapshot().storage[0]?.itemCount, 0);
});

void test('STORE-03/both-read-old-i control: the gate really holds both reads before a commit (one reader never releases it)', async () => {
  const h = createHarness(); const created = await h.service.create(OWNER, validCreate({ id: 'g' }), testBudget());
  const { service, events } = gated(h, 2); let settled = false;
  const only = service.patch(OWNER, 'g', created.etag, { title: 'x' }, testBudget()).then(() => { settled = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false); assert.deepEqual(events, ['read']);
  const second = service.patch(OWNER, 'g', created.etag, { title: 'y' }, testBudget()).catch(() => undefined);
  await Promise.all([only.catch(() => undefined), second]); assert.ok(bothReadBeforeAnyCommit(events));
});

void test('STORE-04/create-race-i: two creates of one ID give one 201 and one 409 ALREADY_EXISTS with one counter change', async () => {
  const h = createHarness();
  const results = await Promise.allSettled([h.service.create(OWNER, validCreate({ id: 'same', title: 'one' }), testBudget()), h.service.create(OWNER, validCreate({ id: 'same', title: 'two' }), testBudget())]);
  assert.equal(winners(results), 1); const loser = reasons(results).find(item => item !== null); assert.deepEqual({ status: loser?.status, code: loser?.code }, { status: 409, code: 'ALREADY_EXISTS' });
  const snap = h.snapshot(); assert.equal(snap.reminders.length, 1); assert.equal(snap.storage[0]?.itemCount, 1);
  const again = await Promise.allSettled([h.service.create(OWNER, validCreate({ id: 'same', title: 'one' }), testBudget())]); assert.equal(reasons(again)[0]?.status, 409);
  assert.equal(h.snapshot().storage[0]?.itemCount, 1);
});

void test('STORE-04/create-race-i: updates to different items both succeed and both are retained', async () => {
  const h = createHarness(); const [x, y] = [await h.service.create(OWNER, validCreate({ id: 'x' }), testBudget()), await h.service.create(OWNER, validCreate({ id: 'y' }), testBudget())];
  const results = await Promise.allSettled([h.service.patch(OWNER, 'x', x.etag, { title: 'x2' }, testBudget()), h.service.patch(OWNER, 'y', y.etag, { title: 'y2' }, testBudget())]);
  assert.equal(winners(results), 2); const rows = h.snapshot().reminders as { id: string; title: string; revision: number }[];
  assert.deepEqual(rows.map(row => [row.id, row.title, row.revision]).sort(), [['x', 'x2', 2], ['y', 'y2', 2]]); assert.equal(h.snapshot().storage[0]?.itemCount, 2);
});
