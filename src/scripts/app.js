const $ = (id) => document.getElementById(id);
const STATUSES = ["planned", "active", "complete", "archived"];
const state = {
  user: null,
  settings: {},
  settingsVersion: null,
  // The Projects view: one list for the current filters, newest first.
  projects: [],
  cursor: null,
  hasMore: false,
  filters: { status: "", owner: "" },
  listRequest: 0,
  // The overview: the unfiltered pages loaded so far.
  overview: [],
  overviewHasMore: false,
  // Owner names seen in loaded data, by owner key, for the owner filter.
  owners: new Map(),
  summary: { counts: {}, total: 0 },
  activity: [],
  activityCursor: null,
  activityHasMore: false,
  busy: false,
  loaded: false,
};
const COPY = {
  duplicate: "A project with this name already exists.",
  offline: "Could not connect. Check your connection and try again.",
  uncertain:
    "Could not connect. Your change may have been saved. Reload the page to check before you try again.",
};
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const initials = (name) =>
  name
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const labels = {
  planned: "Planned",
  active: "Active",
  complete: "Complete",
  archived: "Archived",
};
const actions = { created: "created", updated: "updated", deleted: "deleted" };
const date = (value) =>
  value
    ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "No date";
const time = (value) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const newestFirst = (list) =>
  [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
const ownerKeyOf = (p) => p.ownerKey || p.owner.trim().toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const announce = (message, error = false) => {
  $("notice").textContent = message;
  $("notice").hidden = !message;
  $("notice").setAttribute("role", error ? "alert" : "status");
};
function showLogin() {
  document.querySelector(".skip-link").setAttribute("href", "#main");
  state.user = null;
  state.projects = [];
  state.overview = [];
  state.owners = new Map();
  state.loaded = false;
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("project-dialog").close();
  $("access-key").focus();
}

// ---- API client.
// An error from the API carries its HTTP status and body.
const apiError = (message, status = 0, body = {}) =>
  Object.assign(new Error(message), { status, body });
// Only a create is sent again after a network failure: it has the same
// request ID, so the API writes it at most once. A PATCH or DELETE is never
// sent again, because the outcome of the first attempt is not known.
async function send(path, init, retry) {
  try {
    return await fetch(`/api${path}`, init);
  } catch {
    if (retry) return send(path, init, false);
    throw apiError(init.method === "POST" ? COPY.offline : COPY.uncertain);
  }
}
const writeError = (method) =>
  ["PATCH", "DELETE"].includes(method) ? COPY.uncertain : COPY.offline;
function requestInit({ requestId, retry, ...rest }) {
  return {
    ...rest,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
      ...rest.headers,
    },
  };
}
async function readJson(response, method) {
  try {
    return await response.json();
  } catch {
    throw apiError(
      method === "GET"
        ? "The workspace API is unavailable. Check that /api/* is connected to the edge function."
        : writeError(method),
    );
  }
}
async function api(path, options = {}) {
  const init = requestInit(options);
  const method = init.method || "GET";
  const response = await send(path, init, options.retry === true);
  const data = await readJson(response, method);
  if (response.ok) return data;
  if (response.status === 401 && !(path === "/session" && method === "POST"))
    showLogin();
  throw apiError(
    data.error || "Something went wrong. Please try again.",
    response.status,
    data,
  );
}
// Each create, update and delete has its own request ID.
const write = (path, method, body) =>
  api(path, {
    method,
    requestId: crypto.randomUUID(),
    retry: method === "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
function setBusy(busy, label = "Saving changes…") {
  state.busy = busy;
  document
    .querySelectorAll(
      "#project-form button, #settings-form button, #new-project, #load-more, #activity-more, .edit-project",
    )
    .forEach((button) => {
      button.disabled = busy;
    });
  $("save-state").textContent = busy ? label : "Workspace connected";
}

// ---- Rendering.
function projectRow(p, i, canEdit) {
  const manage = canEdit
    ? `<td><button class="edit-project" data-id="${escape(p.id)}" aria-label="Edit ${escape(p.name)}">Edit ↗</button></td>`
    : "";
  return `<tr><td><div class="project-cell"><span class="project-mark" aria-hidden="true">${["◈", "▧", "✳", "◉"][i % 4]}</span><div><strong>${escape(p.name)}</strong><small>${escape(p.description)}</small></div></div></td><td><span class="status ${escape(p.status)}">${escape(labels[p.status])}</span></td><td><div class="progress"><progress max="100" value="${Number(p.progress)}" aria-label="${escape(p.name)} progress"></progress>${Number(p.progress)}%</div></td><td><span class="mini-avatar">${escape(initials(p.owner))}</span>${escape(p.owner)}</td><td>${escape(date(p.due))}</td>${manage}</tr>`;
}
function table(projects) {
  if (!projects.length)
    return '<div class="empty"><h3>A little room for something new.</h3><p>No projects to show. Try another filter or create your first project.</p></div>';
  const canEdit = state.user.role === "owner";
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Project name</th><th scope="col">Status</th><th scope="col">Progress</th><th scope="col">Owner</th><th scope="col">Target date</th>${canEdit ? '<th scope="col"><span class="muted">Manage</span></th>' : ""}</tr></thead><tbody>${projects.map((p, i) => projectRow(p, i, canEdit)).join("")}</tbody></table></div>`;
}
function renderOwners() {
  const select = $("owner-filter");
  const owners = [...state.owners].sort((a, b) => a[1].localeCompare(b[1]));
  select.innerHTML = `<option value="">Anyone</option>${owners.map(([key, name]) => `<option value="${escape(key)}">${escape(name)}</option>`).join("")}`;
  select.value = state.filters.owner;
}
function renderProjects() {
  const query = $("project-search").value.toLowerCase().trim();
  const projects = newestFirst(state.projects).filter((p) =>
    `${p.name} ${p.owner} ${p.description}`.toLowerCase().includes(query),
  );
  $("projects-table").innerHTML = table(projects);
  $("result-count").textContent = state.hasMore
    ? `${plural(projects.length, "project")} loaded · more to load`
    : plural(projects.length, "project");
  $("load-more").hidden = !state.hasMore;
}
// The counts come from the API, so they cover every indexed project.
function renderStats() {
  const { counts, total } = state.summary;
  $("nav-count").textContent = String(total);
  $("stat-total").textContent = String(total);
  $("stat-active").textContent = String(counts.active || 0);
  $("stat-complete").textContent = String(counts.complete || 0);
  $("welcome-summary").textContent = counts.active
    ? `${plural(counts.active, "active project")}. A world of possibility. Let's make a little progress today.`
    : "Your ideas, your people, your next big thing. All in orbit.";
}
function chartColumn(p) {
  const value = p.progress >= 20 ? `<span class="chart-value">${p.progress}</span>` : "";
  return `<div class="chart-column" tabindex="0" role="img" aria-label="${escape(p.name)}: ${p.progress}% complete"><span class="chart-tooltip">${escape(p.name)} · ${p.progress}%</span><div class="chart-track"><div class="chart-bar ${escape(p.status)}" style="height:${p.progress}%">${value}</div></div><small>${escape(p.name)}</small></div>`;
}
// The chart, overall progress and next milestone use per-project data, so
// they cover the loaded projects. The labels say so when more exist.
function renderProgress(current) {
  const overall = current.length
    ? Math.round(current.reduce((sum, p) => sum + p.progress, 0) / current.length)
    : 0;
  $("stat-progress").innerHTML = `${overall}<small>%</small>`;
  $("overall-meter").style.width = `${overall}%`;
  const partial = state.overviewHasMore;
  $("progress-scope").textContent = partial
    ? "Across loaded non-archived projects"
    : "Across non-archived projects";
  $("chart-scope").textContent = partial
    ? "Latest loaded projects"
    : "Latest projects";
  const chart = current.slice(0, 6);
  $("progress-chart").innerHTML = chart.length
    ? chart.map(chartColumn).join("")
    : '<div class="empty">Your next chapter starts with a project.</div>';
}
function renderFocus(active) {
  const next = active
    .filter((p) => p.due)
    .sort((a, b) => a.due.localeCompare(b.due))[0];
  $("focus-title").textContent = next ? next.name : "A new chapter awaits.";
  $("focus-copy").textContent = next
    ? next.description || `A little closer with every step. Led by ${next.owner}.`
    : "Start a project and give your next idea a little room to grow.";
  $("focus-percent").textContent = next ? `${next.progress}%` : "—";
  $("focus-ring-value").style.strokeDashoffset = String(
    320.442 * (1 - (next?.progress || 0) / 100),
  );
  $("focus-date").textContent = next
    ? `Target · ${date(next.due)}`
    : "Your next chapter";
}
function renderOverview() {
  const sorted = newestFirst(state.overview);
  renderStats();
  renderProgress(sorted.filter((p) => p.status !== "archived"));
  renderFocus(sorted.filter((p) => p.status === "active"));
  $("overview-table").innerHTML = table(sorted.slice(0, 4));
}
function activityRow(entry) {
  const p = entry.project;
  return `<article class="activity-row"><span class="avatar">${escape(initials(entry.actor))}</span><div><strong>${escape(entry.actor)}</strong> ${escape(actions[entry.action] || "changed")} <strong>${escape(p.name)}</strong><p>${escape(labels[p.status])} · ${Number(p.progress)}% complete · ${escape(p.priority)} priority</p></div><time datetime="${escape(entry.at)}">${escape(time(entry.at))}</time></article>`;
}
function renderActivity() {
  $("activity-list").innerHTML = state.activity.length
    ? state.activity.map(activityRow).join("")
    : '<div class="empty">Updates will appear here as your projects take shape.</div>';
  $("activity-more").hidden = !state.activityHasMore;
}
function render() {
  renderOverview();
  renderOwners();
  renderProjects();
  renderActivity();
}
function navigate() {
  const requested = location.hash.slice(1);
  const view = ["overview", "projects", "activity", "settings"].includes(
    requested,
  )
    ? requested
    : "overview";
  const titles = {
    overview: [
      "YOUR WORK, IN ORBIT",
      state.user
        ? `Welcome back, ${state.user.name.split(/\s+/)[0]}.`
        : "Welcome to your workspace.",
      "A fresh perspective on everything you’re moving forward.",
    ],
    projects: [
      "FROM IDEA TO DONE",
      "Good things in the works.",
      "A home for everything your team is moving forward.",
    ],
    activity: [
      "THE LATEST CHAPTER",
      "Progress, one step at a time.",
      "Catch up on the latest changes to your projects.",
    ],
    settings: [
      "MAKE YOURSELF AT HOME",
      "Your workspace. Your way.",
      "A few details to make this space feel like yours.",
    ],
  };
  [
    $("page-eyebrow").textContent,
    $("page-title").textContent,
    $("page-description").textContent,
  ] = titles[view];
  $("breadcrumb").textContent = view[0].toUpperCase() + view.slice(1);
  document.querySelectorAll("[data-view]").forEach((a) => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view").forEach((el) => {
    el.hidden = !state.loaded || el.id !== `${view}-view`;
  });
  $("new-project").hidden =
    !state.user || state.user.role !== "owner" || view === "settings";
}

// ---- Loading.
const merge = (list, items) => [
  ...new Map([...list, ...items].map((p) => [p.id, p])).values(),
];
function rememberOwners(projects) {
  for (const p of projects) state.owners.set(ownerKeyOf(p), p.owner.trim());
}
const filtered = () => Boolean(state.filters.status || state.filters.owner);
function projectsPath(cursor) {
  const params = new URLSearchParams();
  if (state.filters.status) params.set("status", state.filters.status);
  if (state.filters.owner) params.set("owner", state.filters.owner);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return `/projects${query ? `?${query}` : ""}`;
}
// A filter change starts a new list. Only the latest request updates it.
async function loadProjects(more = false) {
  const request = ++state.listRequest;
  const data = await api(projectsPath(more ? state.cursor : null));
  if (request !== state.listRequest) return;
  state.projects = merge(more ? state.projects : [], data.projects);
  state.cursor = data.cursor;
  state.hasMore = data.hasMore;
  rememberOwners(data.projects);
  if (!filtered()) {
    state.overview = state.projects;
    state.overviewHasMore = state.hasMore;
  }
  render();
}
async function loadSummary() {
  state.summary = await api("/projects/summary");
}
async function loadActivity(more = false) {
  const cursor = more && state.activityCursor;
  const data = await api(
    `/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  state.activity = more ? [...state.activity, ...data.activity] : data.activity;
  state.activityCursor = data.cursor;
  state.activityHasMore = data.hasMore;
}
// After a change, the counts and the activity come from the API again.
async function refreshAfterChange() {
  try {
    await Promise.all([loadSummary(), loadActivity()]);
  } catch (e) {
    announce(e.message, true);
  }
  render();
}
function showSettings(settings, version) {
  state.settings = settings;
  state.settingsVersion = version ?? null;
  $("workspace-name").textContent = settings.name;
  $("settings-name").value = settings.name;
  $("settings-description").value = settings.description;
}
async function openWorkspace() {
  const session = await api("/session");
  state.user = session.user;
  $("today-label").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  state.loaded = false;
  $("login").hidden = true;
  $("workspace").hidden = false;
  document.querySelector(".skip-link").setAttribute("href", "#dashboard");
  $("user-name").textContent = session.user.name;
  $("user-role").textContent = session.user.role;
  $("user-avatar").textContent = $("top-avatar").textContent = initials(
    session.user.name,
  );
  showSettings(session.settings, session.settingsVersion);
  $("settings-access").textContent =
    `Signed in as ${session.user.name} · ${session.user.role} access`;
  document
    .querySelectorAll(
      "#settings-form input, #settings-form textarea, #settings-form button",
    )
    .forEach((el) => {
      el.disabled = session.user.role !== "owner";
    });
  $("loading").hidden = false;
  $("retry").hidden = true;
  announce("");
  navigate();
  try {
    await Promise.all([loadProjects(), loadSummary(), loadActivity()]);
    state.loaded = true;
    render();
    navigate();
    $("dashboard").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    announce(e.message, true);
    $("retry").hidden = false;
  } finally {
    $("loading").hidden = true;
  }
}
async function login(key) {
  $("login-error").textContent = "";
  const buttons = document.querySelectorAll("#login-form button");
  buttons.forEach((b) => {
    b.disabled = true;
  });
  try {
    await api("/session", {
      method: "POST",
      body: JSON.stringify({ accessKey: key.trim() }),
    });
    $("access-key").value = "";
    await openWorkspace();
  } catch (e) {
    $("login-error").textContent = e.message;
  } finally {
    buttons.forEach((b) => {
      b.disabled = false;
    });
  }
}
$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  login($("access-key").value);
});
// This branch and the demo credential are removed by Vite's production build.
if (import.meta.env.DEV)
  $("demo-login")?.addEventListener("click", () =>
    login("0123456789abcdef".repeat(4)),
  );
$("logout").addEventListener("click", async () => {
  try {
    await api("/session", { method: "DELETE" });
    showLogin();
  } catch (e) {
    announce(e.message, true);
  }
});
$("retry").addEventListener("click", async () => {
  try {
    await openWorkspace();
  } catch (e) {
    announce(e.message, true);
  }
});
async function loadMore(button, load) {
  button.disabled = true;
  try {
    await load();
    announce("");
  } catch (e) {
    announce(e.message, true);
  } finally {
    button.disabled = false;
  }
}
$("load-more").addEventListener("click", () =>
  loadMore($("load-more"), () => loadProjects(true)),
);
$("activity-more").addEventListener("click", () =>
  loadMore($("activity-more"), async () => {
    await loadActivity(true);
    renderActivity();
  }),
);
async function changeFilter() {
  state.filters = {
    status: $("status-filter").value === "all" ? "" : $("status-filter").value,
    owner: $("owner-filter").value,
  };
  state.cursor = null;
  state.hasMore = false;
  try {
    await loadProjects();
    announce("");
  } catch (e) {
    announce(e.message, true);
  }
}
$("project-search").addEventListener("input", renderProjects);
$("status-filter").addEventListener("change", changeFilter);
$("owner-filter").addEventListener("change", changeFilter);
window.addEventListener("hashchange", navigate);

// ---- The project dialog.
const projectField = (name) => $("project-form").elements.namedItem(name);
function clearProjectMessages() {
  $("project-error").textContent = "";
  $("project-name-error").textContent = "";
  $("project-name").removeAttribute("aria-invalid");
  $("project-note").textContent = "";
  $("load-latest").hidden = true;
}
function fillProject(values) {
  Object.entries(values).forEach(([key, value]) => {
    const field = projectField(key);
    if (field) field.value = value;
  });
}
function edit(project) {
  $("project-form").reset();
  fillProject(
    project || {
      id: "",
      version: "",
      name: "",
      description: "",
      owner: state.user.name,
      due: "",
      status: "planned",
      priority: "medium",
      progress: 0,
    },
  );
  $("dialog-title").textContent = project
    ? "A little fine-tuning."
    : "Start something good.";
  $("delete-project").hidden = !project;
  clearProjectMessages();
  $("project-dialog").showModal();
  $("project-name").focus();
}
$("new-project").addEventListener("click", () => edit());
document.addEventListener("click", (e) => {
  const button = e.target.closest(".edit-project");
  if (button && !state.busy)
    edit(state.projects.find((p) => p.id === button.dataset.id));
});
$("close-dialog").addEventListener("click", () => $("project-dialog").close());
$("project-dialog").addEventListener("cancel", (e) => {
  if (state.busy) e.preventDefault();
});
const matchesFilters = (p) =>
  (!state.filters.status || p.status === state.filters.status) &&
  (!state.filters.owner || ownerKeyOf(p) === state.filters.owner);
// Show a saved project at once: the filtered lists are eventual on the edge.
function storeProject(project) {
  const others = (list) => list.filter((p) => p.id !== project.id);
  state.projects = matchesFilters(project)
    ? [...others(state.projects), project]
    : others(state.projects);
  state.overview = [...others(state.overview), project];
  rememberOwners([project]);
}
function forgetProject(id) {
  state.projects = state.projects.filter((p) => p.id !== id);
  state.overview = state.overview.filter((p) => p.id !== id);
}
// A 409 keeps the dialog open and the person's input in the form.
function showProjectError(error, editing) {
  if (error.status === 409 && error.message === COPY.duplicate) {
    $("project-name-error").textContent = error.message;
    $("project-name").setAttribute("aria-invalid", "true");
    $("project-name").focus();
    return;
  }
  $("project-error").textContent = error.message;
  $("load-latest").hidden = !(error.status === 409 && editing);
}
function projectBody(form) {
  const body = Object.fromEntries(new FormData(form));
  delete body.id;
  body.progress = Number(body.progress);
  return body;
}
$("project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const id = projectField("id").value;
  const body = projectBody(e.target);
  if (!id) delete body.version;
  setBusy(true);
  clearProjectMessages();
  try {
    const { project } = id
      ? await write(`/projects/${id}`, "PATCH", body)
      : await write("/projects", "POST", body);
    storeProject(project);
    render();
    $("project-dialog").close();
    announce(
      id
        ? "Project updated. A little progress, made."
        : "Your new project is ready to go.",
    );
    await refreshAfterChange();
  } catch (error) {
    showProjectError(error, Boolean(id));
  } finally {
    setBusy(false);
  }
});
$("delete-project").addEventListener("click", async () => {
  const id = projectField("id").value;
  const version = projectField("version").value;
  if (!confirm("Delete this project? This cannot be undone.")) return;
  setBusy(true);
  clearProjectMessages();
  try {
    await write(
      `/projects/${id}?version=${encodeURIComponent(version)}`,
      "DELETE",
    );
    forgetProject(id);
    render();
    $("project-dialog").close();
    announce("Project deleted.");
    await refreshAfterChange();
  } catch (error) {
    showProjectError(error, true);
  } finally {
    setBusy(false);
  }
});
// The default list is strong, so the latest version is in one of its pages.
async function findProject(id) {
  let cursor = null;
  do {
    const data = await api(
      `/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    const found = data.projects.find((p) => p.id === id);
    if (found) return found;
    cursor = data.hasMore ? data.cursor : null;
  } while (cursor);
  return null;
}
async function loadLatestProject() {
  const id = projectField("id").value;
  const latest = await findProject(id);
  clearProjectMessages();
  if (!latest) {
    forgetProject(id);
    render();
    $("project-error").textContent =
      "Someone else deleted this project. Close this dialog to see the current list.";
    return;
  }
  fillProject(latest);
  storeProject(latest);
  render();
  $("project-note").textContent =
    "This is the latest version. Make your change again, then save.";
  $("project-name").focus();
}
$("load-latest").addEventListener("click", async () => {
  setBusy(true, "Loading the latest version…");
  try {
    await loadLatestProject();
  } catch (error) {
    $("project-error").textContent = error.message;
  } finally {
    setBusy(false);
  }
});

// ---- Settings.
function clearSettingsMessages() {
  $("settings-error").textContent = "";
  $("settings-note").textContent = "";
  $("settings-load-latest").hidden = true;
}
$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  setBusy(true);
  clearSettingsMessages();
  try {
    const { settings, version } = await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({
        ...Object.fromEntries(new FormData(e.target)),
        version: state.settingsVersion,
      }),
    });
    showSettings(settings, version);
    announce("Workspace details saved.");
  } catch (error) {
    $("settings-error").textContent = error.message;
    $("settings-load-latest").hidden = error.status !== 409;
  } finally {
    setBusy(false);
  }
});
$("settings-load-latest").addEventListener("click", async () => {
  setBusy(true, "Loading the latest version…");
  try {
    const session = await api("/session");
    clearSettingsMessages();
    showSettings(session.settings, session.settingsVersion);
    $("settings-note").textContent =
      "These are the latest settings. Make your change again, then save.";
    $("settings-name").focus();
  } catch (error) {
    $("settings-error").textContent = error.message;
  } finally {
    setBusy(false);
  }
});
openWorkspace().catch((e) => {
  showLogin();
  if (!["Sign in to continue.", "Your access has expired."].includes(e.message))
    $("login-error").textContent = e.message;
});
