import test from "node:test";
import assert from "node:assert/strict";
import { createLocalKv } from "@quantcdn/edge-kv";
import { createKV, indexes, KVError } from "./kv-local.mjs";

// The orbit indexes from quant/meta.json, on the local Quant KV
// (@quantcdn/edge-kv). The general KV behaviour is tested in that package.
const store = "orbit";
const fresh = () => createKV(store);
const project = (id, over = {}) => ({
  workspace: "alpha",
  name: id,
  nameKey: id,
  ownerKey: "alex",
  status: "active",
  updatedAt: 1,
  ...over,
});
const key = (id, ws = "alpha") => `workspace:${ws}:project:${id}`;

// Assert a rejection with a KVError of this code and these details.
async function rejects(promise, code, details = {}) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof KVError, `expected KVError, got ${error}`);
    assert.equal(error.name, "KVError");
    assert.equal(error.code, code);
    for (const [field, value] of Object.entries(details))
      assert.equal(error[field], value, field);
    return true;
  });
}


test("quant/meta.json declares the three orbit indexes, and each one is ACTIVE on a format 2 store", async () => {
  assert.deepEqual(
    indexes.map((index) => index.name),
    ["projectsByStatus", "projectsByOwner", "projectNames"],
  );
  const { backend } = createLocalKv({ indexes: { initialState: "ACTIVE" } });
  await backend.createStore({ id: store, format: 2 });
  for (const definition of indexes) {
    const result = await backend.declareIndex(store, definition);
    assert.deepEqual(result, { name: definition.name, state: "ACTIVE" });
  }
});

test("an index list filters by equals, sorts by sortBy and applies where", async () => {
  const kv = await fresh();
  await kv.set(store, key("p1"), project("p1", { updatedAt: 30 }));
  await kv.set(
    store,
    key("p2"),
    project("p2", { updatedAt: 10, ownerKey: "sam" }),
  );
  await kv.set(store, key("p3"), project("p3", { updatedAt: 20 }));
  await kv.set(store, key("p4"), project("p4", { status: "done" }));
  await kv.set(store, key("p5", "beta"), project("p5", { workspace: "beta" }));
  const nosort = project("p6", { updatedAt: undefined });
  await kv.set(store, key("p6"), nosort);
  const old = { name: "legacy" };
  await kv.set(store, key("p7"), old);
  const equals = { workspace: "alpha", status: "active" };
  const ids = (page) => page.items.map((item) => item.value?.name ?? item.key);

  const page = await kv.list(store, {
    index: "projectsByStatus",
    equals,
    includeValues: true,
  });
  assert.deepEqual(ids(page), ["p6", "p2", "p3", "p1"]);
  assert.equal(page.indexed, true);
  const newest = await kv.list(store, {
    index: "projectsByStatus",
    equals,
    reverse: true,
    includeValues: true,
    limit: 2,
  });
  assert.deepEqual(ids(newest), ["p1", "p3"]);
  const rest = await kv.list(store, {
    index: "projectsByStatus",
    equals,
    reverse: true,
    includeValues: true,
    limit: 2,
    cursor: newest.cursor,
  });
  assert.deepEqual(ids(rest), ["p2", "p6"]);
  assert.equal(rest.hasMore, false);

  const sam = await kv.list(store, {
    index: "projectsByStatus",
    equals,
    where: { ownerKey: "sam" },
    includeValues: true,
  });
  assert.deepEqual(ids(sam), ["p2"]);
  const bounded = await kv.list(store, {
    index: "projectsByStatus",
    equals,
    after: 10,
    includeValues: true,
  });
  assert.deepEqual(ids(bounded), ["p3", "p1"]);
  const owner = await kv.list(store, {
    index: "projectsByOwner",
    equals: { workspace: "alpha", ownerKey: "alex" },
    includeValues: true,
  });
  assert.deepEqual(ids(owner), ["p6", "p4", "p3", "p1"]);
});

test("count follows creates, field changes and deletes", async () => {
  const kv = await fresh();
  const count = (status, ws = "alpha") =>
    kv.count(store, {
      index: "projectsByStatus",
      equals: { workspace: ws, status },
    });
  assert.equal(await count("active"), 0);
  await kv.set(store, key("p1"), project("p1"));
  await kv.set(store, key("p2"), project("p2"));
  await kv.set(store, key("p3", "beta"), project("p3", { workspace: "beta" }));
  assert.equal(await count("active"), 2);
  assert.equal(await count("active", "beta"), 1);
  await kv.set(store, key("p2"), project("p2", { status: "done" }));
  assert.equal(await count("active"), 1);
  assert.equal(await count("done"), 1);
  await kv.delete(store, key("p1"));
  assert.equal(await count("active"), 0);
  await rejects(
    kv.count(store, {
      index: "projectsByOwner",
      equals: { workspace: "a", ownerKey: "b" },
    }),
    "VALIDATION",
  );
  await rejects(kv.count(store, { index: "projectsByStatus" }), "VALIDATION");
  await rejects(kv.count(store), "VALIDATION");
});

test("a unique index refuses a second key with the same fields, not the same key", async () => {
  const kv = await fresh();
  await kv.set(store, key("p1"), project("p1", { nameKey: "web" }));
  await kv.set(
    store,
    key("p1"),
    project("p1", { nameKey: "web", status: "done" }),
  );
  await rejects(
    kv.set(store, key("p2"), project("p2", { nameKey: "web" })),
    "UNIQUE_VIOLATION",
    {
      status: 409,
      retryable: false,
      index: "projectNames",
      existingKey: key("p1"),
    },
  );
  assert.equal(await kv.get(store, key("p2")), null);
  await kv.set(
    store,
    key("p2", "beta"),
    project("p2", { workspace: "beta", nameKey: "web" }),
  );
  const owner = await kv.getBy(store, "projectNames", {
    workspace: "alpha",
    nameKey: "web",
  });
  assert.equal(owner.key, key("p1"));
  assert.equal(typeof owner.version, "string");
  assert.equal(
    await kv.getBy(store, "projectNames", { workspace: "alpha", nameKey: "x" }),
    null,
  );
  await rejects(
    kv.getBy(store, "projectsByOwner", { workspace: "a", ownerKey: "b" }),
    "VALIDATION",
  );

  await rejects(
    kv
      .atomic(store)
      .set(key("p3"), project("p3", { nameKey: "new" }))
      .set(key("p4"), project("p4", { nameKey: "new" }))
      .commit(),
    "UNIQUE_VIOLATION",
    { index: "projectNames", existingKey: key("p3") },
  );
  assert.equal(await kv.get(store, key("p3")), null);

  await kv.set(store, key("p1"), project("p1", { nameKey: "renamed" }));
  await kv.set(store, key("p2"), project("p2", { nameKey: "web" }));
  await kv.delete(store, key("p2"));
  await kv.set(store, key("p5"), project("p5", { nameKey: "web" }));
});
