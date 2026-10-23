import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKV, indexesFromMeta, KVError } from "../scripts/kv.mjs";

const store = "orbit";
const indexes = [
  {
    name: "projectsByStatus",
    collection: "workspace:*:project",
    fields: ["workspace", "status"],
    sortBy: "updatedAt",
    count: true,
  },
  {
    name: "projectsByOwner",
    collection: "workspace:*:project",
    fields: ["workspace", "ownerKey"],
    sortBy: "updatedAt",
  },
  {
    name: "projectNames",
    collection: "workspace:*:project",
    fields: ["workspace", "nameKey"],
    unique: true,
  },
];
const fresh = () => createKV(undefined, { indexes });
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

test("every write gives the key a new string version", async () => {
  const kv = await fresh();
  assert.equal(await kv.set(store, "a", 1), true);
  const first = await kv.getEntry(store, "a");
  assert.equal(typeof first.version, "string");
  assert.equal(first.value, 1);
  await kv.set(store, "a", 2);
  const second = await kv.getEntry(store, "a");
  assert.notEqual(second.version, first.version);
  assert.ok(second.version > first.version);
  const { version } = await kv.set(store, "a", 3, {
    ifVersion: second.version,
  });
  assert.equal((await kv.getEntry(store, "a")).version, version);
  assert.equal(await kv.getEntry(store, "missing"), null);
});

test("ifAbsent on a live key fails CONFLICT exists", async () => {
  const kv = await fresh();
  const { version } = await kv.set(store, "a", 1, { ifAbsent: true });
  await rejects(kv.set(store, "a", 2, { ifAbsent: true }), "CONFLICT", {
    status: 409,
    retryable: false,
    reason: "exists",
    key: "a",
    currentVersion: version,
  });
  assert.equal(await kv.get(store, "a"), 1);
});

test("a stale ifVersion fails CONFLICT version with currentVersion", async () => {
  const kv = await fresh();
  const { version: v1 } = await kv.set(store, "a", 1, { ifAbsent: true });
  const { version: v2 } = await kv.set(store, "a", 2, { ifVersion: v1 });
  await rejects(kv.set(store, "a", 3, { ifVersion: v1 }), "CONFLICT", {
    reason: "version",
    currentVersion: v2,
  });
  await rejects(kv.delete(store, "a", { ifVersion: v1 }), "CONFLICT", {
    reason: "version",
    currentVersion: v2,
  });
  assert.equal(await kv.get(store, "a"), 2);
});

test("conditional writes on a missing key fail CONFLICT missing", async () => {
  const kv = await fresh();
  const { version } = await kv.set(store, "a", 1, { ifAbsent: true });
  await kv.delete(store, "a");
  await assert.rejects(kv.delete(store, "a", { ifVersion: version }), (e) => {
    assert.equal(e.code, "CONFLICT");
    assert.equal(e.reason, "missing");
    assert.equal(e.currentVersion, undefined);
    return true;
  });
  await rejects(kv.set(store, "a", 1, { ifVersion: version }), "CONFLICT", {
    reason: "missing",
  });
  assert.equal(await kv.delete(store, "a"), false);
});

test("write options are checked as the runtime checks them", async () => {
  const kv = await fresh();
  await rejects(kv.set(store, "a", 1, { ifAbsnt: true }), "VALIDATION");
  await rejects(
    kv.set(store, "a", 1, { ifAbsent: true, ifVersion: "x" }),
    "VALIDATION",
  );
  await rejects(kv.set(store, "a", 1, { ifAbsent: false }), "VALIDATION");
  await rejects(kv.set(store, "a", 1, { ttl: 5 }), "VALIDATION");
  await rejects(
    kv.set(store, "a", 1, { ifVersion: "not-a-version" }),
    "VALIDATION",
  );
  assert.equal(await kv.set(store, "a", 1, { expiration: 5 }), true);
  await assert.rejects(kv.get("bad store", "a"), /Invalid KV store identifier/);
});

test("values are stored as the runtime stores them", async () => {
  const kv = await fresh();
  await kv.set(store, "obj", { a: 1, skip: undefined });
  assert.deepEqual(await kv.get(store, "obj"), { a: 1 });
  assert.equal(await kv.get(store, "obj", true), '{"a":1}');
  await kv.set(store, "json", '{"b":2}');
  assert.deepEqual(await kv.get(store, "json"), { b: 2 });
  await kv.set(store, "text", "hello");
  assert.equal(await kv.get(store, "text"), "hello");
  await kv.set(store, "nil", null);
  assert.equal(await kv.get(store, "nil"), null);
  await kv.set(store, "secret", { token: "t" }, { secret: true });
  assert.deepEqual(await kv.get(store, "secret"), { token: "t" });
  assert.equal((await kv.getEntry(store, "secret")).encrypted, true);
  const page = await kv.list(store, { prefix: "secret", includeValues: true });
  assert.equal(page.items[0].value, "[ENCRYPTED]");
});

test("getMany returns entries in input order and null for missing keys", async () => {
  const kv = await fresh();
  await kv.set(store, "a", 1);
  await kv.set(store, "b", 2);
  const [b, missing, a] = await kv.getMany(store, ["b", "x", "a"]);
  assert.deepEqual([b.key, b.value, missing, a.key], ["b", 2, null, "a"]);
  assert.equal(typeof a.version, "string");
  await rejects(kv.getMany(store, []), "VALIDATION");
});

test("increment counts from zero and refuses indexed and non-numeric keys", async () => {
  const kv = await fresh();
  assert.equal(await kv.increment(store, "hits"), 1);
  assert.equal(await kv.increment(store, "hits", 4), 5);
  assert.equal(await kv.get(store, "hits"), 5);
  await kv.set(store, "word", "x");
  await rejects(kv.increment(store, "word"), "VALIDATION");
  await rejects(kv.increment(store, "hits", 0), "VALIDATION");
  await rejects(kv.increment(store, key("p1")), "VALIDATION");
});

test("atomic commits all operations or none, naming the failing operation", async () => {
  const kv = await fresh();
  const { version } = await kv.set(store, "a", 1, { ifAbsent: true });
  await kv.set(store, "b", "old");
  await rejects(
    kv
      .atomic(store)
      .set("c", 3)
      .delete("b")
      .set("a", 2, { ifAbsent: true })
      .commit(),
    "CONFLICT",
    { operation: 2, reason: "exists", key: "a", currentVersion: version },
  );
  assert.equal(await kv.get(store, "c"), null);
  assert.equal(await kv.get(store, "b"), "old");
  assert.equal(await kv.get(store, "a"), 1);

  const result = await kv
    .atomic(store)
    .check("a", version)
    .set("c", { n: 3 })
    .delete("b")
    .increment("n", 2)
    .commit();
  assert.equal(result.replayed, false);
  assert.deepEqual(Object.keys(result.versions).sort(), ["c", "n"]);
  assert.equal((await kv.getEntry(store, "c")).version, result.versions.c);
  assert.equal(await kv.get(store, "b"), null);
  assert.equal(await kv.get(store, "n"), 2);

  await rejects(
    kv.atomic(store).set("x", 1).check("a", result.versions.c).commit(),
    "CONFLICT",
    { operation: 1, reason: "version", currentVersion: version },
  );
  assert.equal(await kv.get(store, "x"), null);
});

test("atomic refuses what the runtime refuses", async () => {
  const kv = await fresh();
  assert.throws(() => kv.atomic(store).set("a", 1, { ifAbsnt: true }), {
    message: "Unknown set option: ifAbsnt",
  });
  await rejects(
    kv.atomic(store).set("a", 1).set("a", 2).commit(),
    "VALIDATION",
  );
  await rejects(
    kv.atomic(store).set("a", 1).commit({ other: 1 }),
    "VALIDATION",
  );
  await rejects(kv.atomic(store).commit(), "VALIDATION");
  const builder = kv.atomic(store).set("a", 1);
  await builder.commit();
  await assert.rejects(builder.commit(), {
    message: "This transaction was already committed",
  });
});

test("an idempotency key replays the first result without writing again", async () => {
  const kv = await fresh();
  const commit = () =>
    kv
      .atomic(store)
      .increment("n")
      .set("log", "x")
      .commit({ idempotencyKey: "req-1" });
  const first = await commit();
  const second = await commit();
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.versions, first.versions);
  assert.equal(await kv.get(store, "n"), 1);
  await rejects(
    kv.atomic(store).increment("m").commit({ idempotencyKey: "req-1" }),
    "VALIDATION",
  );
  const other = await kv
    .atomic("other-store")
    .increment("m")
    .commit({ idempotencyKey: "req-1" });
  assert.equal(other.replayed, false);
});

test("a collection list orders by key id, reverses, and pages with a cursor", async () => {
  const kv = await fresh();
  for (const id of ["c", "a", "e", "b", "d"])
    await kv.set(store, `log:${id}`, { id });
  await kv.set(store, "log:sub:x", 1);
  await kv.set(store, "logs", 1);
  const ids = (page) => page.items.map((item) => item.key);
  const all = await kv.list(store, { collection: "log" });
  assert.deepEqual(ids(all), ["log:a", "log:b", "log:c", "log:d", "log:e"]);
  assert.equal(all.hasMore, false);
  assert.equal(all.cursor, null);
  assert.equal(all.indexed, true);
  assert.equal(typeof all.items[0].version, "string");
  assert.equal(all.items[0].value, undefined);

  const reversed = await kv.list(store, { collection: "log", reverse: true });
  assert.deepEqual(ids(reversed), [
    "log:e",
    "log:d",
    "log:c",
    "log:b",
    "log:a",
  ]);

  const pages = [];
  let cursor;
  do {
    const page = await kv.list(store, {
      collection: "log",
      reverse: true,
      limit: 2,
      includeValues: true,
      ...(cursor ? { cursor } : {}),
    });
    pages.push(ids(page));
    cursor = page.cursor;
    assert.equal(page.hasMore, cursor !== null);
  } while (cursor);
  assert.deepEqual(pages, [["log:e", "log:d"], ["log:c", "log:b"], ["log:a"]]);

  const firstPage = await kv.list(store, { collection: "log", limit: 2 });
  await rejects(
    kv.list(store, {
      collection: "log",
      reverse: true,
      cursor: firstPage.cursor,
    }),
    "CURSOR_INVALID",
  );
  const bounded = await kv.list(store, {
    collection: "log",
    after: "a",
    before: "d",
  });
  assert.deepEqual(ids(bounded), ["log:b", "log:c"]);
});

test("list options are validated as the runtime validates them", async () => {
  const kv = await fresh();
  await assert.rejects(kv.list(store, { limit: 101 }), /limit/);
  await assert.rejects(kv.list(store, { reverse: true }), /need a collection/);
  await assert.rejects(
    kv.list(store, { where: { a: 1 } }),
    /Unknown KV query option: where/,
  );
  await assert.rejects(
    kv.list(store, { index: "projectsByStatus", collection: "x" }),
    /index cannot be combined/,
  );
  await rejects(
    kv.list(store, { index: "nope", equals: { a: 1 } }),
    "VALIDATION",
  );
  await rejects(
    kv.list(store, {
      index: "projectsByStatus",
      equals: { workspace: "alpha" },
    }),
    "VALIDATION",
  );
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
    { operation: 1, index: "projectNames", existingKey: key("p3") },
  );
  assert.equal(await kv.get(store, key("p3")), null);

  await kv.set(store, key("p1"), project("p1", { nameKey: "renamed" }));
  await kv.set(store, key("p2"), project("p2", { nameKey: "web" }));
  await kv.delete(store, key("p2"));
  await kv.set(store, key("p5"), project("p5", { nameKey: "web" }));
});

test("indexed collections refuse ttl with a count index and encrypted values", async () => {
  const kv = await fresh();
  await rejects(
    kv.set(store, key("p1"), project("p1"), { ttl: 3600 }),
    "COUNT_WITH_TTL",
    { status: 400 },
  );
  await rejects(
    kv.set(store, key("p1"), project("p1"), { secret: true }),
    "INDEX_FIELD_ENCRYPTED",
    { status: 400 },
  );
  await rejects(
    kv
      .atomic(store)
      .set("free", 1)
      .set(key("p1"), project("p1"), { ttl: 3600 })
      .commit(),
    "COUNT_WITH_TTL",
    { operation: 1 },
  );
  assert.equal(await kv.get(store, "free"), null);
  assert.equal(
    await kv.set(store, "workspace:alpha:activity:1", { a: 1 }, { ttl: 3600 }),
    true,
  );
});

test("expired entries are invisible everywhere", async (t) => {
  const kv = await createKV(undefined, {
    indexes: [
      { name: "byOwner", collection: "tmp", fields: ["owner"] },
      { name: "byEmail", collection: "tmp", fields: ["email"], unique: true },
    ],
  });
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  await kv.set(store, "log:a", 1, { ttl: 60 });
  await kv.set(store, "tmp:a", { owner: "z", email: "e" }, { ttl: 60 });
  await kv.set(store, "log:b", 2);
  now += 61_000;
  assert.equal(await kv.get(store, "log:a"), null);
  assert.equal(await kv.getEntry(store, "log:a"), null);
  assert.deepEqual(await kv.getMany(store, ["log:a"]), [null]);
  const page = await kv.list(store, { collection: "log" });
  assert.deepEqual(
    page.items.map((i) => i.key),
    ["log:b"],
  );
  const legacy = await kv.list(store, { prefix: "log:" });
  assert.deepEqual(
    legacy.items.map((i) => i.key),
    ["log:b"],
  );
  const owners = await kv.list(store, {
    index: "byOwner",
    equals: { owner: "z" },
  });
  assert.deepEqual(owners.items, []);
  assert.equal(await kv.getBy(store, "byEmail", { email: "e" }), null);
  await kv.set(store, "tmp:b", { owner: "y", email: "e" });
  assert.equal((await kv.getBy(store, "byEmail", { email: "e" })).key, "tmp:b");
  await rejects(
    kv.set(store, "log:a", 3, { ifVersion: "0000000000000000000000000A" }),
    "CONFLICT",
    {
      reason: "expired",
    },
  );
  assert.equal(
    (await kv.set(store, "log:a", 3, { ifAbsent: true })).version.length,
    26,
  );
  assert.equal(await kv.increment(store, "hits", 1, { ttl: 60 }), 1);
  now += 61_000;
  assert.equal(await kv.increment(store, "hits"), 1);
});

test("the file keeps entries and versions across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-kv-"));
  const file = join(dir, "kv.json");
  const kv = await createKV(file, { indexes });
  const { version } = await kv.set(store, "a", { n: 1 }, { ifAbsent: true });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const again = await createKV(file, { indexes });
  assert.equal((await again.getEntry(store, "a")).version, version);
  const { version: next } = await again.set(
    store,
    "a",
    { n: 2 },
    { ifVersion: version },
  );
  assert.ok(next > version);
  JSON.parse(await readFile(file, "utf8"));
});

test("indexesFromMeta reads the orbit store's indexes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-meta-"));
  const file = join(dir, "meta.json");
  await writeFile(
    file,
    JSON.stringify({
      kv_stores: [
        { name: "other", indexes: [1] },
        { name: "orbit", indexes },
      ],
    }),
  );
  assert.deepEqual(await indexesFromMeta(file), indexes);
  await writeFile(file, JSON.stringify({ kv_stores: [{ name: "orbit" }] }));
  assert.deepEqual(await indexesFromMeta(file), []);
  const real = await indexesFromMeta(
    new URL("../quant/meta.json", import.meta.url).pathname,
  );
  assert.ok(Array.isArray(real));
});

test("an indexed write refuses a string with U+0000 in an indexed field", async () => {
  const kv = await createKV(undefined, {
    indexes: [
      { name: "byOwner", collection: "t", fields: ["owner"], sortBy: "at" },
    ],
  });
  await rejects(kv.set(store, "t:a", { owner: "x\u0000y" }), "VALIDATION", {
    message: "Indexed strings must not contain U+0000",
  });
  await rejects(
    kv.set(store, "t:a", { owner: "x", at: "1\u00002" }),
    "VALIDATION",
  );
  assert.equal(await kv.get(store, "t:a"), null);
  await rejects(
    kv.atomic(store).set("free", 1).set("t:b", { owner: "\u0000" }).commit(),
    "VALIDATION",
    { operation: 1 },
  );
  assert.equal(await kv.get(store, "free"), null);
  assert.equal(
    await kv.set(store, "t:c", { owner: "x", note: "a\u0000b" }),
    true,
  );
  assert.equal(await kv.set(store, "u:a", { owner: "x\u0000y" }), true);
  await rejects(
    kv.list(store, { index: "byOwner", equals: { owner: "\u0000" } }),
    "VALIDATION",
  );
});

test("a stored string with U+0000 never breaks index or where lists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-kv-"));
  const file = join(dir, "kv.json");
  const plain = await createKV(file);
  await plain.set(store, "t:bad", { owner: "x\u0000y", at: 1 });
  await plain.set(store, "t:sort", { owner: "z", at: "a\u0000" });
  await plain.set(store, "t:good", { owner: "z", at: 2 });
  const kv = await createKV(file, {
    indexes: [
      { name: "byOwner", collection: "t", fields: ["owner"], sortBy: "at" },
      { name: "owners", collection: "t", fields: ["owner"], count: true },
    ],
  });
  const keys = (page) => page.items.map((i) => i.key);
  const page = await kv.list(store, {
    index: "byOwner",
    equals: { owner: "z" },
  });
  assert.deepEqual(keys(page), ["t:good"]);
  const where = await kv.list(store, {
    collection: "t",
    where: { owner: "z" },
  });
  assert.deepEqual(keys(where), ["t:good", "t:sort"]);
  const none = await kv.list(store, { collection: "t", where: { at: 1 } });
  assert.deepEqual(keys(none), ["t:bad"]);
  assert.equal(
    await kv.count(store, { index: "owners", equals: { owner: "z" } }),
    2,
  );
});

test("list items carry timestamps and version like the runtime's query items", async (t) => {
  const kv = await fresh();
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  await kv.set(store, "log:a", 1, { ttl: 60 });
  await kv.set(store, "log:b", 2);
  const page = await kv.list(store, { collection: "log", includeValues: true });
  const iso = new Date(1_800_000_000_000).toISOString();
  const { version: va } = await kv.getEntry(store, "log:a");
  const { version: vb } = await kv.getEntry(store, "log:b");
  assert.deepEqual(page.items, [
    {
      key: "log:a",
      encrypted: false,
      createdAt: iso,
      updatedAt: iso,
      expiresAt: 1_800_000_060,
      version: va,
      value: 1,
    },
    {
      key: "log:b",
      encrypted: false,
      createdAt: iso,
      updatedAt: iso,
      version: vb,
      value: 2,
    },
  ]);
  assert.deepEqual(Object.keys(page.items[0]), [
    "key",
    "encrypted",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "version",
    "value",
  ]);
});

test("getMany converts keys to strings first, as the polyfill does", async () => {
  const kv = await fresh();
  await kv.set(store, "1", "one");
  const [entry] = await kv.getMany(store, [1]);
  assert.equal(entry.key, "1");
  assert.equal(entry.value, "one");
});
