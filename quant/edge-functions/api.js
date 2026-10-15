// Quant function body: event and kvStore are provided by the runtime.
// No Node imports, server process, or build-time credentials.
const request = event.request;
// Keep the original request path: Quant may rewrite event.url to /fn/<uuid>.
// Its host/protocol identify the public origin rather than the internal backend.
const url = new URL(request.url);
if (event.url) {
  const publicUrl = new URL(event.url);
  url.protocol = publicUrl.protocol;
  url.host = publicUrl.host;
}
const store = `${event.quantOrg}-${event.quantProject}-orbit`;
const secure = url.protocol === "https:";
const cookieName = secure ? "__Host-orbit" : "orbit-local";
const sessionSeconds = 8 * 60 * 60;
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "Surrogate-Control": "no-store",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const hash = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const set = async (key, value, options) => {
  if ((await kvStore.set(store, key, value, options)) === false)
    throw new Error("KV write rejected");
};
const remove = async (key) => {
  if ((await kvStore.delete(store, key)) === false)
    throw new Error("KV delete rejected");
};
const cookie = (value, age = sessionSeconds) =>
  `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
const readBody = async () => {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    fail(415, "Send application/json.");
  // Bound the stream too: Content-Length is optional and untrusted.
  const reader = request.body?.getReader();
  if (!reader) fail(400, "A JSON object is required.");
  let length = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 8192) {
      await reader.cancel();
      fail(413, "Request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(400, "Invalid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    fail(400, "A JSON object is required.");
  return body;
};
const text = (value, label, max, optional = false) => {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (!optional && !value.trim())
  )
    fail(
      400,
      `${label} must be ${optional ? "at most" : "between 1 and"} ${max} characters.`,
    );
  return value.trim();
};
const validPrincipal = (p) =>
  p &&
  /^[a-z0-9][a-z0-9-]{0,47}$/.test(p.workspace) &&
  ["owner", "viewer"].includes(p.role) &&
  typeof p.name === "string" &&
  p.active === true;
try {
  if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method))
    return json({ error: "Method not allowed." }, 405, {
      Allow: "GET, POST, PATCH, DELETE",
    });
  if (request.method !== "GET" && request.headers.get("origin") !== url.origin)
    fail(403, "A same-origin request is required.");
  const path = url.pathname.replace(/\/$/, "");
  if (path === "/api/session" && request.method === "POST") {
    const body = await readBody();
    if (
      typeof body.accessKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.accessKey)
    )
      fail(401, "The access key is not valid.");
    const authKey = `auth:${await hash(body.accessKey)}`;
    const principal = await kvStore.get(store, authKey);
    if (!validPrincipal(principal)) fail(401, "The access key is not valid.");
    const token = random();
    await set(
      `session:${await hash(token)}`,
      { authKey, expires: Date.now() + sessionSeconds * 1000 },
      { ttl: sessionSeconds },
    );
    return json({ ok: true }, 200, { "Set-Cookie": cookie(token) });
  }
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  const sessionKey =
    token && /^[a-f0-9]{64}$/.test(token)
      ? `session:${await hash(token)}`
      : null;
  if (path === "/api/session" && request.method === "DELETE") {
    if (sessionKey) await remove(sessionKey);
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
  }
  const session = sessionKey ? await kvStore.get(store, sessionKey) : null;
  if (
    !session ||
    !Number.isFinite(session.expires) ||
    session.expires <= Date.now() ||
    !/^auth:[a-f0-9]{64}$/.test(session.authKey)
  )
    fail(401, "Sign in to continue.");
  // Re-read access on every request: deleting/disabling an auth key revokes its sessions.
  const principal = await kvStore.get(store, session.authKey);
  if (!validPrincipal(principal)) fail(401, "Your access has expired.");
  const prefix = `workspace:${principal.workspace}:`;
  if (path === "/api/session" && request.method === "GET") {
    const settings = (await kvStore.get(store, `${prefix}settings`)) || {
      name: "My workspace",
      description: "",
    };
    return json({
      user: {
        name: principal.name,
        role: principal.role,
        workspace: principal.workspace,
      },
      settings,
    });
  }
  if (request.method !== "GET" && principal.role !== "owner")
    fail(403, "Owner access is required.");
  if (path === "/api/settings" && request.method === "PATCH") {
    const body = await readBody();
    const settings = {
      name: text(body.name, "Workspace name", 60),
      description: text(body.description, "Description", 240, true),
    };
    await set(`${prefix}settings`, settings);
    return json({ settings });
  }
  if (path === "/api/projects" && request.method === "GET") {
    const cursor = url.searchParams.get("cursor");
    if (cursor && cursor.length > 4096) fail(400, "Invalid cursor.");
    const page = await kvStore.list(store, {
      prefix: `${prefix}project:`,
      includeValues: true,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    if (
      !page ||
      !Array.isArray(page.items) ||
      typeof page.hasMore !== "boolean" ||
      (page.hasMore && !page.cursor)
    )
      throw new Error("KV cursor API required");
    const projects = page.items.map((item) => {
      if (
        !item.key.startsWith(`${prefix}project:`) ||
        !item.value ||
        item.value.id !== item.key.slice(`${prefix}project:`.length)
      )
        throw new Error("Invalid project record");
      return item.value;
    });
    return json({ projects, cursor: page.cursor, hasMore: page.hasMore });
  }
  const match = path.match(/^\/api\/projects\/([a-f0-9]{32})$/);
  const create = path === "/api/projects" && request.method === "POST";
  if (match || create) {
    if (!create && !["PATCH", "DELETE"].includes(request.method))
      return json({ error: "Method not allowed." }, 405, {
        Allow: "PATCH, DELETE",
      });
    const id = create ? random().slice(0, 32) : match[1];
    const key = `${prefix}project:${id}`;
    const existing = create ? null : await kvStore.get(store, key);
    if (!create && !existing) fail(404, "Project not found.");
    if (request.method === "DELETE") {
      await remove(key);
      return json({ ok: true });
    }
    const body = await readBody();
    const name = text(body.name, "Project name", 100);
    const description = text(body.description, "Description", 500, true);
    const owner = text(body.owner, "Owner", 60);
    if (!["planned", "active", "complete", "archived"].includes(body.status))
      fail(400, "Choose a valid status.");
    if (!["low", "medium", "high"].includes(body.priority))
      fail(400, "Choose a valid priority.");
    if (
      !Number.isInteger(body.progress) ||
      body.progress < 0 ||
      body.progress > 100
    )
      fail(400, "Progress must be 0–100.");
    if (
      typeof body.due !== "string" ||
      (body.due !== "" &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(body.due) ||
          !Number.isFinite(Date.parse(body.due)) ||
          new Date(body.due).toISOString().slice(0, 10) !== body.due))
    )
      fail(400, "Choose a valid due date.");
    const now = new Date().toISOString();
    const project = {
      id,
      name,
      description,
      owner,
      status: body.status,
      priority: body.priority,
      progress: body.status === "complete" ? 100 : body.progress,
      due: body.due,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      updatedBy: principal.name,
    };
    await set(key, project);
    return json({ project }, create ? 201 : 200);
  }
  return json({ error: "Route not found." }, 404);
} catch (error) {
  if (!error.status) console.error("Orbit API request failed:", error.message);
  return json(
    {
      error: error.status
        ? error.message
        : "The workspace could not be reached. Please try again.",
    },
    error.status || 503,
  );
}
