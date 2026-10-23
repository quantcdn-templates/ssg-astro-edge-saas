import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createKV, digest, indexesFromMeta, KVError } from "../scripts/kv.mjs";
const indexes = await indexesFromMeta(
  new URL("../quant/meta.json", import.meta.url).pathname,
);
const source = await readFile(
  new URL("../quant/edge-functions/api.js", import.meta.url),
  "utf8",
);
const run = new (Object.getPrototypeOf(async function () {}).constructor)(
  "event",
  "kvStore",
  source,
);
const store = "test-project-orbit";
const ownerKey = "a".repeat(64),
  viewerKey = "b".repeat(64),
  otherKey = "c".repeat(64);
const project = {
  name: "Launch",
  description: "A useful thing",
  owner: "Alex",
  status: "active",
  priority: "high",
  progress: 25,
  due: "2026-11-01",
};
// declared: the indexes the store has (all of quant/meta.json by default).
async function setup(declared = indexes) {
  const kv = await createKV(undefined, { indexes: declared });
  for (const [key, workspace, role] of [
    [ownerKey, "alpha", "owner"],
    [viewerKey, "alpha", "viewer"],
    [otherKey, "beta", "owner"],
  ])
    await kv.set(store, `auth:${digest(key)}`, {
      name: "Alex",
      workspace,
      role,
      active: true,
    });
  const call = async (
    path,
    {
      method = "GET",
      body,
      cookie,
      origin = "https://orbit.test",
      raw,
      headers = {},
    } = {},
  ) =>
    run(
      {
        quantOrg: "test",
        quantProject: "project",
        request: new Request(`https://orbit.test/api${path}`, {
          method,
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
          ...(body || raw ? { body: raw || JSON.stringify(body) } : {}),
        }),
      },
      kv,
    );
  const login = async (accessKey = ownerKey) => {
    const res = await call("/session", { method: "POST", body: { accessKey } });
    assert.equal(res.status, 200);
    return res.headers.get("set-cookie").split(";")[0];
  };
  return { kv, call, login };
}
test("authentication fails closed; cookies are secure and API responses cannot be cached", async () => {
  const { call, login } = await setup();
  assert.equal((await call("/projects")).status, 401);
  assert.equal(
    (
      await call("/session", {
        method: "POST",
        body: { accessKey: "d".repeat(64) },
      })
    ).status,
    401,
  );
  const res = await call("/session", {
    method: "POST",
    body: { accessKey: ownerKey },
  });
  assert.match(
    res.headers.get("set-cookie"),
    /^__Host-orbit=.*HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/,
  );
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const data = await (await call("/session", { cookie: await login() })).json();
  assert.equal(data.user.role, "owner");
  assert.equal(data.user.workspace, "alpha");
});
test("project CRUD, validation and server-owned fields", async () => {
  const { call, login } = await setup();
  const cookie = await login();
  const res = await call("/projects", {
    method: "POST",
    cookie,
    body: { ...project, id: "attacker", workspace: "beta" },
  });
  assert.equal(res.status, 201);
  const { project: created } = await res.json();
  assert.match(created.id, /^[a-f0-9]{32}$/);
  assert.equal(created.updatedBy, "Alex");
  assert.equal(created.workspace, "alpha");
  assert.equal(created.nameKey, "launch");
  assert.equal(created.ownerKey, "alex");
  assert.match(created.version, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(
    (await (await call("/projects", { cookie })).json()).projects.length,
    1,
  );
  const updated = await call(`/projects/${created.id}`, {
    cookie,
    method: "PATCH",
    body: { ...project, status: "complete", progress: 3, version: created.version },
  });
  const { project: saved } = await updated.json();
  assert.equal(saved.progress, 100);
  for (const invalid of [
    { progress: 101 },
    { due: "2026-02-30" },
    { status: "invalid" },
    { name: " " },
    { name: "x".repeat(101) },
    { priority: "urgent" },
  ])
    assert.equal(
      (
        await call("/projects", {
          cookie,
          method: "POST",
          body: { ...project, ...invalid },
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await call(`/projects/${created.id}?version=${saved.version}`, {
        cookie,
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/projects/${created.id}`, {
        cookie,
        method: "PATCH",
        body: { ...project, version: saved.version },
      })
    ).status,
    404,
  );
});
test("workspace isolation and viewer permissions are enforced by the API", async () => {
  const { call, login } = await setup();
  const owner = await login(),
    viewer = await login(viewerKey),
    other = await login(otherKey);
  const { project: created } = await (
    await call("/projects", { method: "POST", cookie: owner, body: project })
  ).json();
  assert.equal(
    (await (await call("/projects", { cookie: viewer })).json()).projects
      .length,
    1,
  );
  assert.equal(
    (await (await call("/projects", { cookie: other })).json()).projects.length,
    0,
  );
  for (const method of ["PATCH", "DELETE"]) {
    assert.equal(
      (
        await call(`/projects/${created.id}`, {
          method,
          cookie: viewer,
          body: project,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(`/projects/${created.id}`, {
          method,
          cookie: other,
          body: project,
        })
      ).status,
      404,
    );
  }
  assert.equal(
    (await call("/projects", { method: "POST", cookie: viewer, body: project }))
      .status,
    403,
  );
  assert.equal(
    (
      await call("/settings", {
        method: "PATCH",
        cookie: viewer,
        body: { name: "No", description: "" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/settings", {
        method: "PATCH",
        cookie: owner,
        body: { name: "New name", description: "", version: null },
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await call("/session", { cookie: owner })).json()).settings.name,
    "New name",
  );
});
test("origin, content type and payload checks reject malicious requests", async () => {
  const { call, login } = await setup();
  const cookie = await login();
  assert.equal(
    (
      await call("/projects", {
        method: "POST",
        cookie,
        body: project,
        origin: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/session", {
        method: "POST",
        body: { accessKey: ownerKey },
        origin: "",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/projects", { method: "POST", cookie, raw: "{broken" }))
      .status,
    400,
  );
  assert.equal(
    (await call("/projects", { method: "POST", cookie, raw: "[]" })).status,
    400,
  );
  assert.equal(
    (await call("/projects", { method: "POST", cookie, raw: "x".repeat(9000) }))
      .status,
    413,
  );
  assert.equal(
    (
      await call("/projects", {
        method: "POST",
        cookie,
        body: project,
        headers: { "Content-Type": "text/plain" },
      })
    ).status,
    415,
  );
});
test("logout, expiry and credential revocation invalidate existing sessions", async () => {
  const { call, login, kv } = await setup();
  let cookie = await login();
  assert.equal(
    (await call("/session", { method: "DELETE", cookie })).status,
    200,
  );
  assert.equal((await call("/projects", { cookie })).status, 401);
  cookie = await login();
  const key = `session:${digest(cookie.split("=")[1])}`;
  await kv.set(store, key, {
    ...(await kv.get(store, key)),
    expires: Date.now() - 1,
  });
  assert.equal((await call("/projects", { cookie })).status, 401);
  cookie = await login();
  await kv.delete(store, `auth:${digest(ownerKey)}`);
  assert.equal((await call("/projects", { cookie })).status, 401);
});
test("a second sign-out with the same cookie still returns 200 and clears the cookie", async () => {
  const { call, login, kv } = await setup();
  const cookie = await login();
  for (const attempt of [1, 2]) {
    const res = await call("/session", { method: "DELETE", cookie });
    assert.equal(res.status, 200, `sign-out ${attempt}`);
    assert.match(res.headers.get("set-cookie"), /^__Host-orbit=; .*Max-Age=0; Secure$/);
  }
  assert.equal((await call("/projects", { cookie })).status, 401);
  // A delete that fails while the session is still stored is not a sign-out.
  const live = await login();
  kv.delete = async () => false;
  assert.equal((await call("/session", { method: "DELETE", cookie: live })).status, 503);
  assert.equal((await call("/session", { cookie: live })).status, 200);
});
test("pagination does not lose concurrent creates or cross workspace boundaries", async () => {
  const { call, login } = await setup();
  const cookie = await login();
  await Promise.all(
    Array.from({ length: 53 }, (_, i) =>
      call("/projects", {
        method: "POST",
        cookie,
        body: { ...project, name: `Project ${i}` },
      }),
    ),
  );
  const page = await (await call("/projects", { cookie })).json();
  assert.equal(page.projects.length, 50);
  assert.equal(page.hasMore, true);
  const next = await (
    await call(`/projects?cursor=${encodeURIComponent(page.cursor)}`, {
      cookie,
    })
  ).json();
  assert.equal(next.projects.length, 3);
  assert.equal(next.hasMore, false);
  assert.equal(
    new Set([...page.projects, ...next.projects].map((p) => p.id)).size,
    53,
  );
  const other = await login(otherKey);
  assert.equal(
    (
      await call(`/projects?cursor=${encodeURIComponent(page.cursor)}`, {
        cookie: other,
      })
    ).status,
    503,
  );
});
test("storage failures never acknowledge a successful save, delete or list", async () => {
  const { call, login, kv } = await setup();
  const cookie = await login();
  const { project: created } = await (
    await call("/projects", { method: "POST", cookie, body: project })
  ).json();
  kv.set = async () => false;
  kv.delete = async () => false;
  // Project writes are transactions: a commit without versions is no success.
  const unacknowledged = () => {
    const builder = {
      set: () => builder,
      delete: () => builder,
      commit: async () => ({}),
    };
    return builder;
  };
  kv.atomic = unacknowledged;
  assert.equal(
    (await call("/projects", { method: "POST", cookie, body: project })).status,
    503,
  );
  assert.equal(
    (
      await call(`/projects/${created.id}?version=${created.version}`, {
        method: "DELETE",
        cookie,
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await call("/settings", {
        method: "PATCH",
        cookie,
        body: { name: "New", description: "", version: null },
      })
    ).status,
    503,
  );
  kv.list = async () => {
    throw new Error("Unavailable");
  };
  assert.equal((await call("/projects", { cookie })).status, 503);
});
test("empty evaluated pages preserve pagination metadata", async () => {
  const { call, login, kv } = await setup();
  const cookie = await login();
  kv.list = async () => ({ items: [], cursor: "next-page", hasMore: true });
  const result = await (await call("/projects", { cookie })).json();
  assert.deepEqual(result, {
    projects: [],
    cursor: "next-page",
    hasMore: true,
  });
});

test("uses Quant's public URL for origin checks behind the edge proxy", async () => {
  const kv = await createKV(undefined, { indexes });
  await kv.set(store, `auth:${digest(ownerKey)}`, {
    name: "Alex", workspace: "alpha", role: "owner", active: true,
  });
  const call = (origin) => run({
    quantOrg: "test", quantProject: "project",
    url: new URL("https://orbit.test/fn/12345678-1234-4234-a234-123456789012"),
    request: new Request("https://internal.edge.test/api/session", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: ownerKey }),
    }),
  }, kv);
  const response = await call("https://orbit.test");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /__Host-orbit=.*; Secure$/);
  assert.equal((await call("https://foreign.test")).status, 403);
  assert.equal((await call("https://internal.edge.test")).status, 403);
});

// ---- KV v2: conditional writes, transactions, indexes, counts, activity.
const VERSION = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const conflictCopy =
  "Someone else changed this project. Reload it to see their change.";
const duplicateCopy = "A project with this name already exists.";
const notReadyCopy =
  "The workspace is still being set up. Try again in a minute.";
const unavailableCopy = "The workspace could not be reached. Please try again.";
// A clock that moves 1 s on each read, so updatedAt and activity ids order.
// A later use starts after the last time an earlier use gave.
let clockEnd = 0;
async function withClock(fn) {
  const realNow = Date.now;
  let t = Math.max(realNow(), clockEnd);
  Date.now = () => (t += 1000);
  try {
    return await fn();
  } finally {
    Date.now = realNow;
    clockEnd = t;
  }
}
async function orbit(declared) {
  const env = await setup(declared);
  const cookie = await env.login();
  const create = async (fields = {}, headers = {}) => {
    const res = await env.call("/projects", {
      method: "POST",
      cookie,
      body: { ...project, ...fields },
      headers,
    });
    return { res, body: await res.json() };
  };
  const patch = async (id, fields, headers = {}) => {
    const res = await env.call(`/projects/${id}`, {
      method: "PATCH",
      cookie,
      body: { ...project, ...fields },
      headers,
    });
    return { res, body: await res.json() };
  };
  const get = async (path, as = cookie) => {
    const res = await env.call(path, { cookie: as });
    return { res, body: await res.json() };
  };
  const stored = (id) => env.kv.getEntry(store, `workspace:alpha:project:${id}`);
  const activity = async () => (await get("/activity")).body.activity;
  return { ...env, cookie, create, patch, get, stored, activity };
}

test("two edits from the same version: the second gets 409 and the first edit is kept", async () => {
  const o = await orbit();
  const { body } = await o.create();
  const v0 = body.project.version;
  const first = await o.patch(body.project.id, { progress: 40, version: v0 });
  assert.equal(first.res.status, 200);
  assert.match(first.body.project.version, VERSION);
  assert.notEqual(first.body.project.version, v0);
  const second = await o.patch(body.project.id, { progress: 90, version: v0 });
  assert.equal(second.res.status, 409);
  assert.deepEqual(second.body, {
    error: conflictCopy,
    currentVersion: first.body.project.version,
  });
  const entry = await o.stored(body.project.id);
  assert.equal(entry.value.progress, 40);
  assert.equal(entry.version, first.body.project.version);
});

test("an edit without a valid version is refused and changes nothing", async () => {
  const o = await orbit();
  const { body } = await o.create();
  for (const version of [undefined, "x", 7, "0".repeat(25), "I".repeat(26)]) {
    const res = await o.patch(body.project.id, { progress: 99, version });
    assert.equal(res.res.status, 400);
    assert.match(res.body.error, /version/i);
  }
  const entry = await o.stored(body.project.id);
  assert.equal(entry.version, body.project.version);
  assert.equal(entry.value.progress, 25);
  assert.equal((await o.activity()).length, 1);
});

test("a duplicate project name is a 409, ignoring case and whitespace", async () => {
  const o = await orbit();
  const { body } = await o.create({ name: "Website" });
  const dup = await o.create({ name: "  website " });
  assert.equal(dup.res.status, 409);
  assert.deepEqual(dup.body, { error: duplicateCopy });
  const other = await o.create({ name: "Other" });
  const rename = await o.patch(other.body.project.id, {
    name: "WEBSITE",
    version: other.body.project.version,
  });
  assert.equal(rename.res.status, 409);
  assert.deepEqual(rename.body, { error: duplicateCopy });
  // The same project may keep its own name.
  const keep = await o.patch(body.project.id, {
    name: "Website",
    version: body.project.version,
  });
  assert.equal(keep.res.status, 200);
  assert.equal((await o.get("/projects")).body.projects.length, 2);
});

test("a create retry with the same request ID returns the stored project and writes once", async () => {
  const o = await orbit();
  const headers = { "X-Request-Id": "req_0123456789abcdef" };
  const first = await o.create({}, headers);
  // The retry has new timestamps: only the id, getEntry and ifAbsent protect it.
  const again = await withClock(() => o.create({}, headers));
  assert.equal(first.res.status, 201);
  assert.equal(again.res.status, 201);
  assert.deepEqual(again.body, first.body);
  assert.equal((await o.get("/projects")).body.projects.length, 1);
  assert.equal((await o.activity()).length, 1);
  // Another session with the same request ID is a different request.
  const other = await o.login();
  const res = await o.call("/projects", {
    method: "POST",
    cookie: other,
    body: { ...project, name: "Second" },
    headers,
  });
  assert.equal(res.status, 201);
  assert.notEqual((await res.json()).project.id, first.body.project.id);
});

test("a create that races its own retry gets the already-created copy, not the edit-conflict copy", async () => {
  const o = await orbit();
  const headers = { "X-Request-Id": "race-0123456789abcdef" };
  const first = await o.create({}, headers);
  assert.equal(first.res.status, 201);
  // The retry's pre-check runs before the first attempt is visible, and its
  // commit reaches ifAbsent (as when the two operation lists differ).
  const getEntry = o.kv.getEntry;
  let missed = false;
  o.kv.getEntry = async (s, key) => {
    if (!missed && key.includes(":project:")) {
      missed = true;
      return null;
    }
    return getEntry(s, key);
  };
  const atomic = o.kv.atomic;
  o.kv.atomic = (s) => {
    const tx = atomic(s);
    const commit = tx.commit;
    tx.commit = () => commit();
    return tx;
  };
  const again = await o.create({}, headers);
  assert.equal(missed, true);
  assert.equal(again.res.status, 409);
  assert.equal(again.body.error, "This project was already created. Reload to see it.");
  o.kv.getEntry = getEntry;
  o.kv.atomic = atomic;
  assert.equal((await o.get("/projects")).body.projects.length, 1);
  assert.equal((await o.activity()).length, 1);
});

test("no commit sends an idempotency key; an invalid request ID gives a new id", async () => {
  const o = await orbit();
  const commits = [];
  const atomic = o.kv.atomic;
  o.kv.atomic = (s) => {
    const tx = atomic(s);
    const commit = tx.commit;
    tx.commit = (...args) => {
      commits.push(args);
      return commit(...args);
    };
    return tx;
  };
  const headers = { "X-Request-Id": "too-short" };
  assert.equal((await o.create({ name: "One" }, headers)).res.status, 201);
  assert.equal((await o.create({ name: "Two" }, headers)).res.status, 201);
  assert.equal((await o.get("/projects")).body.projects.length, 2);
  const valid = { "X-Request-Id": "valid_request_id_1" };
  const { body } = await o.create({ name: "Three" }, valid);
  assert.equal(body.project.id, (await o.create({ name: "Three" }, valid)).body.project.id);
  const edit = await o.patch(body.project.id, { name: "Three", progress: 60, version: body.project.version }, valid);
  assert.equal(edit.res.status, 200);
  const del = await o.call(`/projects/${body.project.id}?version=${edit.body.project.version}`, {
    method: "DELETE",
    cookie: o.cookie,
    headers: valid,
  });
  assert.equal(del.status, 200);
  // Three creates, one edit and one delete; the retried create did not commit.
  assert.deepEqual(commits, [[], [], [], [], []]);
});

test("a delete with a stale version is a 409 and the project is kept", async () => {
  const o = await orbit();
  const { body } = await o.create();
  const v0 = body.project.version;
  const edit = await o.patch(body.project.id, { progress: 50, version: v0 });
  const del = (version) =>
    o.call(`/projects/${body.project.id}${version === undefined ? "" : `?version=${version}`}`, {
      method: "DELETE",
      cookie: o.cookie,
    });
  const stale = await del(v0);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: conflictCopy,
    currentVersion: edit.body.project.version,
  });
  assert.ok(await o.stored(body.project.id));
  assert.equal((await del()).status, 400);
  assert.equal((await del("nope")).status, 400);
  assert.ok(await o.stored(body.project.id));
  assert.equal((await del(edit.body.project.version)).status, 200);
  assert.equal(await o.stored(body.project.id), null);
});

test("a failed transaction writes no activity", async () => {
  const o = await orbit();
  const { body } = await o.create({ name: "Website" });
  assert.equal((await o.create({ name: "WEBSITE" })).res.status, 409);
  const ok = await o.patch(body.project.id, { progress: 30, version: body.project.version });
  assert.equal(ok.res.status, 200);
  assert.equal((await o.patch(body.project.id, { progress: 31, version: body.project.version })).res.status, 409);
  const stale = await o.call(`/projects/${body.project.id}?version=${body.project.version}`, {
    method: "DELETE",
    cookie: o.cookie,
  });
  assert.equal(stale.status, 409);
  const entries = await o.activity();
  assert.deepEqual(entries.map((a) => a.action).sort(), ["created", "updated"]);
});

test("summary counts follow create, status change and delete", async () => {
  const o = await orbit();
  const zero = await o.get("/projects/summary");
  assert.equal(zero.res.status, 200);
  assert.deepEqual(zero.body, {
    counts: { planned: 0, active: 0, complete: 0, archived: 0 },
    total: 0,
  });
  const a = (await o.create({ name: "A", status: "active" })).body.project;
  await o.create({ name: "B", status: "planned" });
  await o.create({ name: "C", status: "active" });
  assert.deepEqual((await o.get("/projects/summary")).body, {
    counts: { planned: 1, active: 2, complete: 0, archived: 0 },
    total: 3,
  });
  const done = (await o.patch(a.id, { name: "A", status: "complete", version: a.version })).body.project;
  assert.deepEqual((await o.get("/projects/summary")).body.counts, {
    planned: 1, active: 1, complete: 1, archived: 0,
  });
  await o.call(`/projects/${a.id}?version=${done.version}`, { method: "DELETE", cookie: o.cookie });
  assert.deepEqual((await o.get("/projects/summary")).body, {
    counts: { planned: 1, active: 1, complete: 0, archived: 0 },
    total: 2,
  });
  // Counts are per workspace, and a viewer may read them.
  const other = await o.login(otherKey);
  assert.equal((await o.get("/projects/summary", other)).body.total, 0);
  const viewer = await o.login(viewerKey);
  assert.equal((await o.get("/projects/summary", viewer)).body.total, 2);
});

test("filters by status, by owner and by both, newest first", async () => {
  const o = await orbit();
  await withClock(async () => {
    await o.create({ name: "P1", status: "active", owner: "Alex" });
    await o.create({ name: "P2", status: "planned", owner: "alex " });
    await o.create({ name: "P3", status: "active", owner: "Jamie" });
    await o.create({ name: "P4", status: "active", owner: "ALEX" });
  });
  const names = async (query) => {
    const { res, body } = await o.get(`/projects?${query}`);
    assert.equal(res.status, 200, query);
    for (const p of body.projects) assert.match(p.version, VERSION);
    return body.projects.map((p) => p.name);
  };
  assert.deepEqual(await names("status=active"), ["P4", "P3", "P1"]);
  assert.deepEqual(await names("owner=alex"), ["P4", "P2", "P1"]);
  assert.deepEqual(await names(`owner=${encodeURIComponent(" ALEX ")}`), ["P4", "P2", "P1"]);
  assert.deepEqual(await names("status=active&owner=Alex"), ["P4", "P1"]);
  assert.deepEqual(await names("status=archived"), []);
  assert.equal((await o.get("/projects?status=urgent")).res.status, 400);
  assert.equal((await o.get(`/projects?status=active&cursor=${"x".repeat(8193)}`)).res.status, 400);
  // Other workspaces never appear in a filtered list.
  const other = await o.login(otherKey);
  assert.deepEqual((await o.get("/projects?owner=alex", other)).body.projects, []);
});

test("filtered lists page with a cursor", async () => {
  const o = await orbit();
  await withClock(async () => {
    for (let i = 0; i < 53; i++) await o.create({ name: `P${i}`, status: "active" });
  });
  const page = (await o.get("/projects?status=active")).body;
  assert.equal(page.projects.length, 50);
  assert.equal(page.hasMore, true);
  assert.equal(page.projects[0].name, "P52");
  const next = (await o.get(`/projects?status=active&cursor=${encodeURIComponent(page.cursor)}`)).body;
  assert.deepEqual(next.projects.map((p) => p.name), ["P2", "P1", "P0"]);
  assert.equal(next.hasMore, false);
});

test("activity is newest first, pages with a cursor and records each change", async () => {
  const o = await orbit();
  let a;
  await withClock(async () => {
    a = (await o.create({ name: "First" })).body.project;
    const b = (await o.patch(a.id, { name: "First", progress: 80, version: a.version })).body.project;
    await o.call(`/projects/${a.id}?version=${b.version}`, { method: "DELETE", cookie: o.cookie });
  });
  const entries = await o.activity();
  assert.deepEqual(entries.map((e) => e.action), ["deleted", "updated", "created"]);
  for (const e of entries) {
    assert.match(e.id, /^\d{13}-[a-f0-9]{8}$/);
    assert.equal(e.actor, "Alex");
    assert.equal(new Date(e.at).toISOString(), e.at);
    assert.deepEqual(Object.keys(e.project).sort(), ["id", "name", "priority", "progress", "status"]);
    assert.equal(e.project.id, a.id);
  }
  assert.equal(entries[1].project.progress, 80);
  const key = `workspace:alpha:activity:${entries[0].id}`;
  const entry = await o.kv.getEntry(store, key);
  // The test clock moves 1 s on each read, so allow a few seconds.
  const ttl = entry.expiresAt - Math.floor(Date.parse(entries[0].at) / 1000);
  assert.ok(Math.abs(ttl - 90 * 86400) <= 60, `ttl ${ttl}`);
  // 53 more changes: 50 a page, newest first, then the rest.
  await withClock(async () => {
    for (let i = 0; i < 53; i++) await o.create({ name: `P${i}` });
  });
  const page = (await o.get("/activity")).body;
  assert.equal(page.activity.length, 50);
  assert.equal(page.hasMore, true);
  assert.equal(page.activity[0].project.name, "P52");
  const next = (await o.get(`/activity?cursor=${encodeURIComponent(page.cursor)}`)).body;
  assert.equal(next.activity.length, 6);
  assert.equal(next.hasMore, false);
  assert.equal(next.activity.at(-1).action, "created");
  assert.equal(next.activity.at(-1).project.name, "First");
  const ids = [...page.activity, ...next.activity].map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort().reverse());
  // A viewer may read activity; another workspace sees none of it.
  assert.equal((await o.get("/activity", await o.login(viewerKey))).body.activity.length, 50);
  assert.deepEqual((await o.get("/activity", await o.login(otherKey))).body.activity, []);
  assert.equal((await o.get(`/activity?cursor=${"x".repeat(8193)}`)).res.status, 400);
  // The runtime accepts a cursor of up to 8192 characters: this one reaches
  // the KV call, which refuses it as an invalid cursor (not the 400 here).
  assert.equal((await o.get(`/activity?cursor=${"x".repeat(8192)}`)).res.status, 503);
});

test("a project from before this change is listed but not counted until its next edit", async () => {
  const o = await orbit();
  const id = "f".repeat(32);
  await o.kv.set(store, `workspace:alpha:project:${id}`, {
    id, name: "Legacy", description: "", owner: "Alex", status: "active",
    priority: "low", progress: 5, due: "", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "Alex",
  });
  const listed = (await o.get("/projects")).body.projects;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Legacy");
  assert.match(listed[0].version, VERSION);
  assert.equal((await o.get("/projects/summary")).body.total, 0);
  assert.deepEqual((await o.get("/projects?status=active")).body.projects, []);
  const edit = await o.patch(id, { name: "Legacy", status: "active", version: listed[0].version });
  assert.equal(edit.res.status, 200);
  assert.equal(edit.body.project.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal((await o.get("/projects/summary")).body.counts.active, 1);
  assert.equal((await o.get("/projects?status=active")).body.projects.length, 1);
});

test("settings use a version: first write, conflicts and the session version", async () => {
  const o = await orbit();
  const settingsConflict =
    "Someone else changed these settings. Reload them to see their change.";
  const patchSettings = (body) =>
    o.call("/settings", { method: "PATCH", cookie: o.cookie, body });
  const start = (await o.get("/session")).body;
  assert.equal(start.settingsVersion, null);
  assert.equal((await patchSettings({ name: "One", description: "" })).status, 400);
  assert.equal((await patchSettings({ name: "One", description: "", version: "x" })).status, 400);
  const first = await patchSettings({ name: "One", description: "", version: null });
  assert.equal(first.status, 200);
  const saved = await first.json();
  assert.deepEqual(saved.settings, { name: "One", description: "" });
  assert.match(saved.version, VERSION);
  assert.equal((await o.get("/session")).body.settingsVersion, saved.version);
  const again = await patchSettings({ name: "Two", description: "", version: null });
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: settingsConflict, currentVersion: saved.version });
  const next = await patchSettings({ name: "Two", description: "", version: saved.version });
  assert.equal(next.status, 200);
  const stale = await patchSettings({ name: "Three", description: "", version: saved.version });
  assert.equal(stale.status, 409);
  assert.equal((await o.get("/session")).body.settings.name, "Two");
});

test("a store whose index is not ready gives the not-ready message, never the KV message", async () => {
  const o = await orbit();
  const notReady = () => {
    throw new KVError("INDEX_NOT_READY", "Index projectsByStatus is BUILDING (secret detail)", {
      index: "projectsByStatus",
    });
  };
  o.kv.list = async () => notReady();
  o.kv.count = async () => notReady();
  for (const path of ["/projects?status=active", "/projects?owner=alex", "/projects/summary"]) {
    const { res, body } = await o.get(path);
    assert.equal(res.status, 503, path);
    assert.deepEqual(body, { error: notReadyCopy });
  }
  o.kv.list = async () => {
    throw new KVError("VALIDATION", "internal detail");
  };
  const { res, body } = await o.get("/projects");
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: unavailableCopy });
});

test("a viewer still cannot write, but may read lists, summary and activity", async () => {
  const o = await orbit();
  const { body } = await o.create();
  const viewer = await o.login(viewerKey);
  const version = body.project.version;
  for (const [path, method, payload] of [
    ["/projects", "POST", project],
    [`/projects/${body.project.id}`, "PATCH", { ...project, version }],
    [`/projects/${body.project.id}?version=${version}`, "DELETE", undefined],
    ["/settings", "PATCH", { name: "No", description: "", version: null }],
  ])
    assert.equal((await o.call(path, { method, cookie: viewer, body: payload })).status, 403, `${method} ${path}`);
  assert.equal((await o.stored(body.project.id)).version, version);
  for (const path of ["/projects", "/projects?status=active", "/projects/summary", "/activity"])
    assert.equal((await o.get(path, viewer)).res.status, 200, path);
});

test("text fields refuse control characters other than tab and newline", async () => {
  const o = await orbit();
  for (const [field, label] of [
    ["name", "Project name"],
    ["description", "Description"],
    ["owner", "Owner"],
  ])
    for (const bad of ["\u0000", "\u0007", "\u001b", "\u007f"]) {
      const { res, body } = await o.create({ [field]: `A${bad}B` });
      assert.equal(res.status, 400, `${field} ${JSON.stringify(bad)}`);
      assert.deepEqual(body, { error: `${label} must not contain control characters.` });
    }
  const ok = await o.create({ name: "Tab\tname", description: "Line one\nLine two\r\nthree" });
  assert.equal(ok.res.status, 201);
  const settings = await o.call("/settings", {
    method: "PATCH",
    cookie: o.cookie,
    body: { name: "Work\u0000space", description: "", version: null },
  });
  assert.equal(settings.status, 400);
  assert.deepEqual(await settings.json(), { error: "Workspace name must not contain control characters." });
  const filter = await o.get(`/projects?owner=${encodeURIComponent("al\u0000ex")}`);
  assert.equal(filter.res.status, 400);
  assert.deepEqual(filter.body, { error: "Owner must not contain control characters." });
  assert.equal((await o.get("/projects")).body.projects.length, 1);
});

const dataModelCopy = "The workspace data model is not set up. See README › Data model.";
test("a store without the declared indexes gives the data model message, never the KV message", async () => {
  const o = await orbit([]);
  assert.equal((await o.create()).res.status, 201);
  // The unfiltered list and activity are collection lists: they need no index.
  assert.equal((await o.get("/projects")).body.projects.length, 1);
  assert.equal((await o.get("/activity")).res.status, 200);
  for (const path of ["/projects/summary", "/projects?status=active", "/projects?owner=alex"]) {
    const { res, body } = await o.get(path);
    assert.equal(res.status, 503, path);
    assert.deepEqual(body, { error: dataModelCopy }, path);
  }
});

test("a format 1 store gives the data model message, never the KV message", async () => {
  const o = await orbit();
  const format1 = () => {
    throw new KVError("REQUIRES_FORMAT_2", "Store test-project-orbit is format 1 (secret detail)");
  };
  o.kv.list = async () => format1();
  o.kv.count = async () => format1();
  o.kv.atomic = () => ({ set() { return this; }, commit: async () => format1() });
  for (const path of ["/projects", "/projects/summary", "/activity"]) {
    const { res, body } = await o.get(path);
    assert.equal(res.status, 503, path);
    assert.deepEqual(body, { error: dataModelCopy }, path);
  }
  const { res, body } = await o.create();
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: dataModelCopy });
  // Another VALIDATION error is still the generic message.
  o.kv.count = async () => {
    throw new KVError("VALIDATION", "Index projectsByStatus is not a count index");
  };
  assert.deepEqual((await o.get("/projects/summary")).body, { error: unavailableCopy });
});
