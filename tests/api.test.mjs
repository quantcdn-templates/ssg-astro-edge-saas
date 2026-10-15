import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createKV, digest } from "../scripts/kv.mjs";
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
async function setup() {
  const kv = await createKV();
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
  assert.equal(
    (await (await call("/projects", { cookie })).json()).projects.length,
    1,
  );
  const updated = await call(`/projects/${created.id}`, {
    cookie,
    method: "PATCH",
    body: { ...project, status: "complete", progress: 3 },
  });
  assert.equal((await updated.json()).project.progress, 100);
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
    (await call(`/projects/${created.id}`, { cookie, method: "DELETE" }))
      .status,
    200,
  );
  assert.equal(
    (
      await call(`/projects/${created.id}`, {
        cookie,
        method: "PATCH",
        body: project,
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
        body: { name: "New name", description: "" },
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
  assert.equal(
    (await call("/projects", { method: "POST", cookie, body: project })).status,
    503,
  );
  kv.delete = async () => false;
  assert.equal(
    (await call(`/projects/${created.id}`, { method: "DELETE", cookie }))
      .status,
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
  const kv = await createKV();
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
