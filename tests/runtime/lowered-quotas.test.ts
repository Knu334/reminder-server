import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, harnessConfig } from "../support/stateful-store";
import { syntheticPngBytes, testBudget, validCreate } from "../support/fixtures";

const png = (extra = 0) => Buffer.concat([syntheticPngBytes, Buffer.alloc(extra)]).toString("base64");
void test("lowering item cap from three to one permits deletion and unchanged dimensions", async () => {
  const config = structuredClone(harnessConfig), h = createHarness(config);
  const created = await Promise.all(["a", "b", "c"].map(id => h.service.create("owner", validCreate({id}), testBudget())));
  config.limits.itemCount = 1;
  const patched = await h.service.patch("owner", "c", created[2]!.etag, {title:"changed"}, testBudget());
  await h.service.remove("owner", "a", created[0]!.etag, testBudget());
  assert.equal(h.snapshot().storage[0]?.itemCount, 2);
  await assert.rejects(h.service.create("owner", validCreate({id:"growth"}), testBudget()), {status:413});
  await h.service.remove("owner", "b", created[1]!.etag, testBudget());
  assert.equal(h.snapshot().storage[0]?.itemCount, 1);
  await assert.rejects(h.service.remove("owner", "c", created[2]!.etag, testBudget()), {status:412});
  await h.service.remove("owner", "c", patched.etag, testBudget());
  const results = await Promise.allSettled(["d", "e"].map(id => h.service.create("owner", validCreate({id}), testBudget())));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(h.snapshot().storage[0]?.itemCount, 1);
});
void test("lowered image cap allows reductions, clears and independent nongrowth but rejects byte growth", async () => {
  const config = structuredClone(harnessConfig), h = createHarness(config);
  const a = await h.service.create("owner", validCreate({id:"a",thumbnail:png(20)}), testBudget());
  const b = await h.service.create("owner", validCreate({id:"b",thumbnail:png(20)}), testBudget());
  config.limits.imageBytes = 12;
  const metadata = await h.service.patch("owner", "a", a.etag, {title:"still editable"}, testBudget());
  await h.service.create("owner", validCreate({id:"no-image"}), testBudget());
  const reduced = await h.service.patch("owner", "a", metadata.etag, {thumbnail:png()}, testBudget());
  assert.equal(h.snapshot().storage[0]?.imageBytes, 44);
  await assert.rejects(h.service.patch("owner", "a", reduced.etag, {thumbnail:png(1)}, testBudget()), {status:413});
  await h.service.patch("owner", "b", b.etag, {thumbnail:""}, testBudget());
  assert.equal(h.snapshot().storage[0]?.imageBytes, 12);
  const cleared = await h.service.patch("owner", "a", reduced.etag, {thumbnail:""}, testBudget());
  const results = await Promise.allSettled(["a", "b"].map(async id => {
    const r = id === "a" ? cleared : await h.service.get("owner", id, testBudget());
    return h.service.patch("owner", id, r.etag, {thumbnail:png()}, testBudget());
  }));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(h.snapshot().storage[0]?.imageBytes, 12);
  assert.equal(h.snapshot().jobs.filter(j => j.state === "committed").length, 1);
  assert.ok(h.snapshot().jobs.filter(j => j.state === "retired").length >= 3);
});
