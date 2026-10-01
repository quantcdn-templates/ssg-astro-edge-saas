const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  settings: {},
  projects: [],
  cursor: null,
  hasMore: false,
  busy: false,
  loaded: false,
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
const date = (value) =>
  value
    ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "No date";
const announce = (message, error = false) => {
  $("notice").textContent = message;
  $("notice").hidden = !message;
  $("notice").setAttribute("role", error ? "alert" : "status");
};
function showLogin() {
  document.querySelector(".skip-link").setAttribute("href", "#main");
  state.user = null;
  state.projects = [];
  state.loaded = false;
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("project-dialog").close();
  $("access-key").focus();
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch {
    throw new Error("Could not connect. Check your connection and try again.");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The workspace API is unavailable. Check that /api/* is connected to the edge function.",
    );
  }
  if (!response.ok) {
    if (
      response.status === 401 &&
      !(path === "/session" && options.method === "POST")
    )
      showLogin();
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}
function setBusy(busy) {
  state.busy = busy;
  document
    .querySelectorAll(
      "#project-form button, #settings-form button, #new-project, #load-more, .edit-project",
    )
    .forEach((button) => {
      button.disabled = busy;
    });
  $("save-state").textContent = busy
    ? "Saving changes…"
    : "Workspace connected";
}
function table(projects) {
  if (!projects.length)
    return '<div class="empty"><h3>A little room for something new.</h3><p>No projects to show. Try another filter or create your first project.</p></div>';
  const canEdit = state.user.role === "owner";
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Project name</th><th scope="col">Status</th><th scope="col">Progress</th><th scope="col">Owner</th><th scope="col">Target date</th>${canEdit ? '<th scope="col"><span class="muted">Manage</span></th>' : ""}</tr></thead><tbody>${projects.map((p, i) => `<tr><td><div class="project-cell"><span class="project-mark" aria-hidden="true">${["◈", "▧", "✳", "◉"][i % 4]}</span><div><strong>${escape(p.name)}</strong><small>${escape(p.description)}</small></div></div></td><td><span class="status ${escape(p.status)}">${escape(labels[p.status])}</span></td><td><div class="progress"><progress max="100" value="${Number(p.progress)}" aria-label="${escape(p.name)} progress"></progress>${Number(p.progress)}%</div></td><td><span class="mini-avatar">${escape(initials(p.owner))}</span>${escape(p.owner)}</td><td>${escape(date(p.due))}</td>${canEdit ? `<td><button class="edit-project" data-id="${escape(p.id)}" aria-label="Edit ${escape(p.name)}">Edit ↗</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
function renderProjects() {
  const query = $("project-search").value.toLowerCase().trim();
  const status = $("status-filter").value;
  const projects = state.projects.filter(
    (p) =>
      (status === "all" || p.status === status) &&
      `${p.name} ${p.owner} ${p.description}`.toLowerCase().includes(query),
  );
  $("projects-table").innerHTML = table(projects);
  $("result-count").textContent =
    `${projects.length} project${projects.length === 1 ? "" : "s"}`;
}
function render() {
  const sorted = [...state.projects].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const active = sorted.filter((p) => p.status === "active");
  const current = sorted.filter((p) => p.status !== "archived");
  $("nav-count").textContent = String(sorted.length);
  $("stat-total").textContent = String(sorted.length);
  $("stat-active").textContent = String(active.length);
  $("stat-complete").textContent = String(
    sorted.filter((p) => p.status === "complete").length,
  );
  $("stat-progress").innerHTML =
    `${current.length ? Math.round(current.reduce((sum, p) => sum + p.progress, 0) / current.length) : 0}<small>%</small>`;
  const overall = current.length
    ? Math.round(
        current.reduce((sum, p) => sum + p.progress, 0) / current.length,
      )
    : 0;
  $("overall-meter").style.width = `${overall}%`;
  $("welcome-summary").textContent = active.length
    ? `${active.length} active projects. A world of possibility. Let's make a little progress today.`
    : "Your ideas, your people, your next big thing. All in orbit.";
  const chart = current.slice(0, 6);
  $("progress-chart").innerHTML = chart.length
    ? chart
        .map(
          (p) =>
            `<div class="chart-column" tabindex="0" role="img" aria-label="${escape(p.name)}: ${p.progress}% complete"><span class="chart-tooltip">${escape(p.name)} · ${p.progress}%</span><div class="chart-track"><div class="chart-bar ${escape(p.status)}" style="height:${p.progress}%">${p.progress >= 20 ? `<span class="chart-value">${p.progress}</span>` : ""}</div></div><small>${escape(p.name)}</small></div>`,
        )
        .join("")
    : '<div class="empty">Your next chapter starts with a project.</div>';
  const next = active
    .filter((p) => p.due)
    .sort((a, b) => a.due.localeCompare(b.due))[0];
  $("focus-title").textContent = next ? next.name : "A new chapter awaits.";
  $("focus-copy").textContent = next
    ? next.description ||
      `A little closer with every step. Led by ${next.owner}.`
    : "Start a project and give your next idea a little room to grow.";
  $("focus-percent").textContent = next ? `${next.progress}%` : "—";
  $("focus-ring-value").style.strokeDashoffset = String(
    320.442 * (1 - (next?.progress || 0) / 100),
  );
  $("focus-date").textContent = next
    ? `Target · ${date(next.due)}`
    : "Your next chapter";
  $("overview-table").innerHTML = table(sorted.slice(0, 4));
  $("activity-list").innerHTML = sorted.length
    ? sorted
        .map(
          (p) =>
            `<article class="activity-row"><span class="avatar">${escape(initials(p.updatedBy))}</span><div><strong>${escape(p.updatedBy)}</strong> updated <strong>${escape(p.name)}</strong><p>${escape(labels[p.status])} · ${p.progress}% complete · ${escape(p.priority)} priority</p></div><time datetime="${escape(p.updatedAt)}">${escape(new Date(p.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</time></article>`,
        )
        .join("")
    : '<div class="empty">Updates will appear here as your projects take shape.</div>';
  $("load-more").hidden = !state.hasMore;
  const scope = state.hasMore
    ? `Showing ${sorted.length} loaded projects. Load more in Projects to include the rest in your overview, search and activity.`
    : `${sorted.length} projects · All workspace projects loaded`;
  $("overview-scope").textContent = scope;
  $("list-scope").textContent = scope;
  renderProjects();
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
async function loadProjects(more = false) {
  const data = await api(
    `/projects${more && state.cursor ? `?cursor=${encodeURIComponent(state.cursor)}` : ""}`,
  );
  state.projects = [
    ...new Map(
      [...(more ? state.projects : []), ...data.projects].map((p) => [p.id, p]),
    ).values(),
  ];
  state.cursor = data.cursor;
  state.hasMore = data.hasMore;
  state.loaded = true;
  render();
  navigate();
}
async function openWorkspace() {
  const session = await api("/session");
  state.user = session.user;
  $("today-label").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  state.settings = session.settings;
  state.loaded = false;
  $("login").hidden = true;
  $("workspace").hidden = false;
  document.querySelector(".skip-link").setAttribute("href", "#dashboard");
  $("user-name").textContent = session.user.name;
  $("user-role").textContent = session.user.role;
  $("user-avatar").textContent = $("top-avatar").textContent = initials(
    session.user.name,
  );
  $("workspace-name").textContent = session.settings.name;
  $("settings-name").value = session.settings.name;
  $("settings-description").value = session.settings.description;
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
    await loadProjects();
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
$("load-more").addEventListener("click", async () => {
  $("load-more").disabled = true;
  try {
    await loadProjects(true);
    announce("");
  } catch (e) {
    announce(e.message, true);
  } finally {
    $("load-more").disabled = false;
  }
});
$("project-search").addEventListener("input", renderProjects);
$("status-filter").addEventListener("change", renderProjects);
window.addEventListener("hashchange", navigate);
function edit(project) {
  $("project-form").reset();
  const values = project || {
    id: "",
    name: "",
    description: "",
    owner: state.user.name,
    due: "",
    status: "planned",
    priority: "medium",
    progress: 0,
  };
  Object.entries(values).forEach(([key, value]) => {
    const field = $("project-form").elements.namedItem(key);
    if (field) field.value = value;
  });
  $("dialog-title").textContent = project
    ? "A little fine-tuning."
    : "Start something good.";
  $("delete-project").hidden = !project;
  $("project-error").textContent = "";
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
$("project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const form = Object.fromEntries(new FormData(e.target));
  const id = form.id;
  delete form.id;
  form.progress = Number(form.progress);
  setBusy(true);
  $("project-error").textContent = "";
  try {
    const { project } = await api(id ? `/projects/${id}` : "/projects", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(form),
    });
    state.projects = [
      ...state.projects.filter((p) => p.id !== project.id),
      project,
    ];
    render();
    $("project-dialog").close();
    announce(
      id
        ? "Project updated. A little progress, made."
        : "Your new project is ready to go.",
    );
  } catch (e) {
    $("project-error").textContent = e.message;
  } finally {
    setBusy(false);
  }
});
$("delete-project").addEventListener("click", async () => {
  const id = $("project-form").elements.namedItem("id").value;
  if (!confirm("Delete this project? This cannot be undone.")) return;
  setBusy(true);
  try {
    await api(`/projects/${id}`, { method: "DELETE" });
    state.projects = state.projects.filter((p) => p.id !== id);
    render();
    $("project-dialog").close();
    announce("Project deleted.");
  } catch (e) {
    $("project-error").textContent = e.message;
  } finally {
    setBusy(false);
  }
});
$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  setBusy(true);
  $("settings-error").textContent = "";
  try {
    const { settings } = await api("/settings", {
      method: "PATCH",
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    state.settings = settings;
    $("workspace-name").textContent = settings.name;
    announce("Workspace details saved.");
  } catch (e) {
    $("settings-error").textContent = e.message;
  } finally {
    setBusy(false);
  }
});
openWorkspace().catch((e) => {
  showLogin();
  if (!["Sign in to continue.", "Your access has expired."].includes(e.message))
    $("login-error").textContent = e.message;
});
