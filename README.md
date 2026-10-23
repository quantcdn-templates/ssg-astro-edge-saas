# Orbit · Edge SaaS template

A working project-management dashboard built with a static Astro frontend, one Quant edge function and a Quant KV store. No application server, SQL database or external authentication service is required. Quant Studio is optional: use it to edit the public website's content through the portal.

## Create your application

Choose **Use this template → Create a new repository** on [GitHub](https://github.com/quantcdn-templates/ssg-astro-edge-saas/generate), or select **Orbit · Edge SaaS** in the Quant portal's Studio template picker. The template verifies its build without deployment credentials; configure your Quant project to enable deployment.

The portal creates the KV store and the separate rules token when it sets the site up. This template declares its function in `quant/edge-functions.json` and its API routing in `quant/edge-rules.json`; the workflow applies it on every deploy when the rules token is present. Personal access keys are always provisioned separately.

## Run locally

Requires Node 22.12+.

```sh
npm install
npm run dev
```

Open the URL Astro prints and visit `/app`. Choose **Enter demo workspace** to explore eight sample projects. Create, edit, complete and delete projects, filter the list by status and owner, review the activity feed and change workspace settings. Reloading preserves your changes.

The local Astro integration executes **the same `quant/edge-functions/api.js` body** as production. Its filesystem KV adapter persists records in `.local/kv.json`, which is ignored by Git. It seeds only on the first run. Stop the dev server and remove that file to reset the demo. The adapter reads the indexes from `quant/meta.json` and emulates the KV v2 contract that Orbit uses (see [Local emulator limits](#local-emulator-limits)), not the hosted service's latency or failure modes.

`npm run preview` serves only the static production build; it does not start the development API. Use `npm run dev` for the complete local application. Demo credentials and the demo button are development-only and are absent from the production bundle. Production setup seeds workspace settings from `quant/meta.json`; it never seeds the local demo credentials or projects.

## What is included

- Responsive dashboard with project counts from a KV count index, a progress chart and a next-milestone card.
- Persistent project CRUD with version checks, status and owner filters served by KV indexes, search, ownership labels, priorities, target dates and progress.
- Workspace isolation and personal owner/viewer access keys, enforced by the API.
- Opaque eight-hour sessions in HttpOnly, Secure, SameSite=Strict cookies over HTTPS. Sessions are stored by hash, expire both in application code and through KV TTL, and are removed on sign-out.
- Workspace settings and an activity feed: one entry for each create, update and delete, kept for 90 days.
- Public landing page and field guide backed by typed Astro content collections.
- An API test suite, browser tests, local emulator, provisioning helper and GitHub deployment workflow.

Owner labels on projects are descriptive names, not account assignments or invitations. Activity entries are written in the same transaction as the change, but they expire after 90 days and are not an immutable audit log. Billing, email, self-service registration and password recovery are extension points, not simulated features.

## Architecture

```text
Browser ── GET /, /guide, /app ──> Quant static hosting (Astro dist/)
        └─ /api/* ──────────────> Quant edge function
                                  ├─ session / access checks
                                  ├─ workspace-scoped project operations
                                  └─ Quant KV store

Quant Studio ── edits src/content/pages/*.md ──> static public pages
```

`/app` is a public **shell**. It contains no private data. Every private read and write goes through the authenticated API. API responses include `Cache-Control: private, no-store` and `Surrogate-Control: no-store`. Writes require a matching `Origin`; JSON bodies are limited to 8 KiB and validated on the server. Browser-rendered project text is escaped. Workspace IDs and roles come from the stored access record, never from user-supplied request fields.

The function uses Quant's runtime `event.quantOrg`, `event.quantProject`, `event.request`, `event.url`, Web Crypto and `kvStore`. The store identifier is `${event.quantOrg}-${event.quantProject}-orbit`.

### KV requirements

The `orbit` store is a **format 2 (KV v2)** store. The function uses these runtime calls:

```js
await kvStore.get(store, key);
await kvStore.getEntry(store, key); // { value, version }
await kvStore.set(store, key, value, { ifAbsent: true }); // or { ifVersion }
await kvStore.list(store, { collection, reverse, cursor, includeValues, limit });
await kvStore.list(store, { index, equals, where, reverse, cursor, includeValues, limit });
await kvStore.count(store, { index, equals });
await kvStore
  .atomic(store)
  .set(projectKey, project, { ifVersion })
  .set(activityKey, entry, { ttl })
  .commit({ idempotencyKey });
```

A runtime without conditional writes, transactions or index queries cannot run this template. A store that is not format 2, or an index that is not ready, returns a visible service error rather than an empty dashboard. [Data model](#data-model) describes the keys, the indexes and the consistency of each query.

## Data model

### Keys and collections

Keys whose text before the last `:` is the same form one **collection**. `workspace:studio:project:<id>` is in the collection `workspace:studio:project`.

| Key | Collection | Value |
| --- | --- | --- |
| `auth:<sha256>` | `auth` | Access record |
| `session:<sha256>` | `session` | Session, 8-hour TTL |
| `workspace:<ws>:settings` | `workspace:<ws>` | Workspace settings |
| `workspace:<ws>:project:<id>` | `workspace:<ws>:project` | One project, with `workspace`, `nameKey` and `ownerKey` |
| `workspace:<ws>:activity:<id>` | `workspace:<ws>:activity` | One change, 90-day TTL |

`nameKey` and `ownerKey` are the name and the owner, trimmed and lower-cased. "Website" and "website " are then the same name, and the owner filter ignores case. The API writes these fields; the browser cannot set them. An activity `<id>` is the change time in milliseconds (13 digits), then `-` and 8 hex characters, so key order is time order.

### The `kv_stores` declaration

`quant/meta.json` declares the store, its indexes and its initial values. Setup creates each index before it seeds the store, and every publish adds an index that is declared but missing:

```json
"kv_stores": [
  {
    "name": "orbit",
    "indexes": [
      { "name": "projectsByStatus", "collection": "workspace:*:project",
        "fields": ["workspace", "status"], "sortBy": "updatedAt", "count": true },
      { "name": "projectsByOwner", "collection": "workspace:*:project",
        "fields": ["workspace", "ownerKey"], "sortBy": "updatedAt" },
      { "name": "projectNames", "collection": "workspace:*:project",
        "fields": ["workspace", "nameKey"], "unique": true }
    ],
    "initial_values": [ ... ]
  }
]
```

`workspace:*:project` matches the project collection of every workspace. Each index has `workspace` as its first field, so every query names one workspace and never sees another workspace's projects.

### Each index and the query that uses it

| Index | Query | Route |
| --- | --- | --- |
| `projectsByStatus` | `list({ index, equals: { workspace, status }, reverse: true })`, newest first by `updatedAt` | `GET /api/projects?status=active` |
| `projectsByStatus` | the same, with `where: { ownerKey }` | `GET /api/projects?status=active&owner=jamie chen` |
| `projectsByStatus` (`count: true`) | `count({ index, equals: { workspace, status } })`, once for each status | `GET /api/projects/summary` |
| `projectsByOwner` | `list({ index, equals: { workspace, ownerKey }, reverse: true })`, newest first | `GET /api/projects?owner=jamie chen` |
| `projectNames` (`unique: true`) | No query. A create or rename that gives a second project the same `nameKey` fails with `UNIQUE_VIOLATION`, and the API returns 409 "A project with this name already exists." | `POST`, `PATCH /api/projects` |

Two queries use no index:

- `GET /api/projects` with no filter is a `list({ collection: "workspace:<ws>:project" })`. It is in key order, which is random project-id order, so the browser sorts each loaded page by `updatedAt`.
- `GET /api/activity` is a reverse `list({ collection: "workspace:<ws>:activity" })`, newest first. No count index covers the activity collection, because its entries have a TTL.

### Strong and eventual reads

- **Strong:** `get`, `getEntry`, collection lists, `count` and `getBy`. A sign-out or a revoked key takes effect on the next request. The summary counts and the unfiltered project list always include the last saved change.
- **Eventual on the edge:** index lists. A project that was just saved can take a moment to appear in, or leave, a filtered view. The browser shows the saved project in the current list at once, so the person who saved it does not see the lag.

### Conflicts and retries

- **Versions.** Each project in a list has its `version`. An edit sends that version, and the API writes with `ifVersion`. If someone else saved the project first, the API returns 409 "Someone else changed this project. Reload it to see their change." The dialog keeps the person's input and shows **Load the latest version**. A delete sends `?version=` and follows the same rule. Settings use the same rule with `settingsVersion` from `GET /api/session`; the first settings write uses `ifAbsent`.
- **Transactions.** A project change and its activity entry commit in one `atomic()` transaction. If the change fails, no activity entry is written.
- **Idempotency.** The browser sends a new `X-Request-Id` with each create, update and delete. The API commits with an idempotency key made from the session and that ID, so a repeated request writes at most once, and one session cannot replay another's. The browser sends a create again once, with the same ID, after a network failure. It never sends an edit or a delete again: when the network fails, it tells the person to reload and check.

### Add an index

1. Add the index to `indexes` in `quant/meta.json`, with a new name.
2. Change the API to query it.
3. Publish. The deploy adds the index to the store, and the index is built from the existing data.

Never change the definition of an existing index. To change one, add a new index with a new name, move the queries to it, and leave the old one. Indexes that are removed from `meta.json` are not dropped.

### No migrations

There is no data migration step. An index includes only the records that have its fields. A project written before an index existed, or before the API wrote its fields, is in the unfiltered list but not in the filters or the counts. It joins the indexes on its next edit. If you add a field that an index needs, write it on every save, and edit the older records (or write a one-off script) if they must appear at once.

### Local emulator limits

`scripts/kv.mjs` emulates the KV v2 calls above from the declaration in `quant/meta.json`, so a change to the indexes takes effect locally on the next `npm run dev`. It does not model:

- index build states (an index is ready at once, so `INDEX_NOT_READY` never occurs locally);
- the eventual lag of index lists (every local read is strong);
- durable idempotency (idempotency keys are kept in memory and are lost when the dev server stops).

Test index lag, build states and retries on a staging site.

## Deploy to Quant

1. Create the site through the portal’s template flow. With template KV provisioning installed, the portal creates and links `orbit`, waits for it to be ready, and inserts the initial workspace settings from `quant/meta.json` before starting the build. For a GitHub-only deployment or an older portal, create a Quant project and a KV store named `orbit` in **Compute → K/V Stores**. Verify the full identifier is `<organization>-<project>-orbit` and the store is available to the project's functions. If your identifier differs, update the `store` declaration in `quant/edge-functions/api.js`.
2. Create your repository from this GitHub template (the portal does this for you when using its template flow). For manual setup, set repository variables `QUANT_CUSTOMER` (organization slug) and `QUANT_PROJECT`, plus secret `QUANT_TOKEN` (deployment token).
3. Push to `main` or run the deployment workflow. It tests, builds, deploys the static site and function, then purges the static cache. The function's identity is the `uuid` committed in `quant/edge-functions.json`, so every deploy updates the same function. Function UUIDs are scoped to a project, so every site created from this template can keep the same value. Do not change it after the first deploy. To adopt an existing function, replace it with that function's UUID.
4. Sites created through the portal get the `/api/*` rule from `quant/edge-rules.json` automatically, both on every GitHub deploy and on every Quant Studio publish (see below). For a manual setup without the rules token, bind the deployed **[Orbit]** function to `/api/*` for **all request methods** in the Quant portal instead; ensure the rule precedes any catch-all/static fallback and no cache rule overrides its no-store response headers. KV creation is performed by portal template setup; the GitHub Action alone does not provision storage.
5. Copy the **owner access key** from the setup screen. The portal generates it during setup and shows it once; it stores only its hash. Open `https://your-domain/app` and sign in with it. If you set the site up without the portal, or lose the key, follow [Reset or add access keys](#reset-or-add-access-keys). Use HTTPS. Configure Quant WAF request limits for `/api/session` appropriate to your traffic; the template does not implement a distributed login rate limiter.

Use separate Quant projects/stores for staging and production. The deployment token is never sent to the browser or stored in the site's content.

Before launch, verify a deployed sign-in, project create/update/delete, sign-out, viewer restrictions, and a private API request without a cookie (it must return 401). Local tests cannot verify portal route bindings, runtime rollout or CDN cache rules.

### Declarative rules and separate deployment credentials

`quant/edge-functions.json` gives the API function an explicit `uuid` and the name `orbit-api-v1`.
`quant/edge-rules.json` references that name and routes all methods under `/api/*` to it.
The CLI resolves the reference to the function's committed `uuid`.

The rules-capable static/Studio setup detects this file and injects:

- `QUANT_TOKEN`: existing content/function upload secret.
- `QUANT_API_TOKEN`: separate token restricted to this project, with
  `projects:read`, `rules:read`, and `rules:write` scopes.
- `QUANT_BASE_URL`: the owning portal's `/api/v2` URL, selected for the platform
  and staging/production environment, independently of `QUANT_ENDPOINT`.

The deploy workflow applies `quant/edge-rules.json` after the site and function upload
whenever `QUANT_API_TOKEN` and `QUANT_BASE_URL` are set. A Quant Studio publish
applies the same file after it deploys the function, when the person publishing
can manage the project (`add_projects`); otherwise Studio reports the rules as
skipped. Both paths update the same managed rule. To run it by hand:

```sh
# Set QUANT_API_TOKEN and QUANT_BASE_URL in your environment.
quant rules quant/edge-rules.json --functions quant/edge-functions.json -c CUSTOMER -p PROJECT --dry-run
quant rules quant/edge-rules.json --functions quant/edge-functions.json -c CUSTOMER -p PROJECT
```

Rules deployment never accepts the upload token as a fallback. Repeated deploys
update the same managed rule and preserve unrelated rules. Rules deployed this
way are managed in code: the portal shows them read-only. If one is changed
outside code, the deploy stops before uploading and lists the changed fields;
re-run the workflow with `rules-force: true` on the deploy step (or
`quant rules ... --force`) to restore the version in `quant/edge-rules.json`. Removing an entry
from the file does not delete it; set `disabled: true` explicitly.
Authentication and filter functions use the same format with `type: "auth"` or
`type: "filter"`; give authentication rules lower weights than protected API rules.
Orbit itself performs authentication inside its API function.

Portal-issued
template API tokens expire after one year; rotate the token and replace the
GitHub secret before expiry. A token issued by a local portal database cannot
be used against the shared staging portal.

### Template KV declarations

`quant/meta.json` declares the store and what setup puts in it. The `indexes` field is described in [Data model](#data-model); it is left out here:

```json
"kv_stores": [
  {
    "name": "orbit",
    "initial_values": [
      {
        "key": "workspace:studio:settings",
        "value": { "name": "My workspace", "description": "A little space for our next big thing." }
      },
      {
        "key": "auth:{sha256}",
        "generate": { "bytes": 32, "reveal": "once", "label": "Owner access key (workspace: studio)" },
        "value": { "workspace": "studio", "name": "{user_name}", "role": "owner", "active": true }
      }
    ]
  }
]
```

Store names are project-local: the portal expands `orbit` to `<organization>-<project>-orbit`. Values may be JSON objects, arrays, strings, numbers, booleans or null. Setup preserves existing values, checkpoints each seeded key, and skips seeding stores already linked to the project. It will not repopulate deleted defaults on a later deployment. A newly created store is linked only after its defaults are ready.

The second entry is the owner access key. Setup generates 32 random bytes (the 64-character hex key the API expects), stores the access record under `auth:` plus the SHA-256 of that key, fills `{user_name}` with the name of the person creating the site, and shows the key once on the setup screen. The plaintext key is never stored in KV, in the repository or in deployment records. A retry of a finished setup never creates a second key.

Declarations contain public defaults only. An unlinked store with the same name is a setup conflict: link it through the portal, then retry to preserve its existing data. Initial values are limited to 100 across at most 10 stores, 16 KiB per value and 64 KiB for the complete declaration. The initializer is a setup workflow, not a data migration engine; do not edit a new store manually while its initialisation is in progress.

### Reset or add access keys

Use this when the owner key is lost, someone leaves, or you add a person. Run it locally; it never contacts Quant:

```sh
npm run provision -- studio "Alex Morgan" owner
npm run provision -- studio "Jamie Chen" viewer
npm run provision -- another-team "Taylor Brooks" owner
```

Each invocation prints:

- `accessKey`: a new random 256-bit personal key. Give it to that person securely. It is shown only in this output.
- `key`: the KV key, `auth:<sha256-of-access-key>`.
- `value`: the JSON object to store at that key.

Then, in the portal, open **Compute → K/V Stores → `<organization>-<project>-orbit`**:

1. **Add** a key: paste `key` as the key and the `value` **object** as the value. Do not store the plaintext access key, the whole output, or a quoted JSON string.
2. **To reset a lost key:** add the new record as above, sign in with the new key, then find the old `auth:...` record (its value names the person) and delete it, or set `"active": false`.

The API rechecks the access record on every request, so deleting or deactivating it signs out existing sessions immediately. Workspace slugs use lowercase letters, digits and hyphens. People with the same slug share projects; different slugs are isolated. Give every person their own key. This is a deliberate access-key authentication example; add an identity provider if you need email login, MFA or SSO.

### Keys at rest

| Key                                    | Value                                                   |
| -------------------------------------- | ------------------------------------------------------- |
| `auth:<SHA-256>`                       | Workspace, display name, role, active flag              |
| `session:<SHA-256>`                    | Reference to access record, absolute expiry; 8-hour TTL |
| `workspace:<slug>:settings`            | Name and description                                    |
| `workspace:<slug>:project:<random-id>` | One project, timestamps, latest editor and index fields |
| `workspace:<slug>:activity:<ms>-<hex>` | One change (actor, action, project snapshot); 90-day TTL |

The function treats a KV write that returns no version, or an explicit `false`, as a failure and returns 503 rather than acknowledging an unsuccessful write. The browser sends a create again once, with the same request ID, after a network failure; it never sends an edit or a delete again (see [Conflicts and retries](#conflicts-and-retries)). Back up production KV data through your normal operational process; the repository and static deployment do not contain it.

## Optional Quant Studio editing

Connect the repository to Quant Studio in the portal. Studio reads `src/content.config.ts` to generate editing forms for the `pages` collection:

- `src/content/pages/home.md` → `/`
- `src/content/pages/guide.md` → `/guide`
- Add another Markdown entry → a matching public route.

Edit the title, description, eyebrow, CTA label/link, body and draft flag. Draft entries are excluded from static output. `quant.studio.json` registers an optional Callout component. There is no MDX dependency; the supplied pages use Markdown. The site declares English as its default locale, following the other Studio templates; translated route generation is not included.

Studio edits public web content. It is not the editor for KV project records, private workspace settings or credentials. Use the application for project data and the KV portal for access provisioning. Static content publishing does not need to redeploy the API; function source changes use the repository's deployment workflow. No Studio account is needed to build or operate the dashboard.

## Files to start with

| File                           | Purpose                                      |
| ------------------------------ | -------------------------------------------- |
| `quant/edge-functions/api.js`  | Complete hosted API function body            |
| `quant/edge-functions.json`    | Function manifest (committed `uuid`)         |
| `quant/edge-rules.json`        | Managed `/api/*` rule                        |
| `quant/meta.json`              | Template metadata and KV declarations        |
| `src/pages/app.astro`          | Static application shell and forms           |
| `src/scripts/app.js`           | API client, rendering and interaction        |
| `src/styles/global.css`        | Public and dashboard styling                 |
| `src/content.config.ts`        | Studio content schema                        |
| `scripts/local-edge.mjs`       | Development bridge to the same edge function |
| `scripts/kv.mjs`               | Persistent development KV adapter            |
| `scripts/provision.mjs`        | Generates personal access records            |
| `.github/workflows/deploy.yml` | Tests, build, function/static deployment     |

## Verification

```sh
npm test
npm run build

# With npm run dev running in another terminal:
npx playwright install chromium
BASE_URL=http://localhost:4321 npm run test:browser
```

Set `BASE_URL` to the actual development URL printed by Astro. Browser tests expect a freshly seeded local store with eight projects (stop the dev server and delete `.local/kv.json` first) and delete the projects they create. The activity entries that they write stay in the local store for 90 days, so the activity feed grows with each run. They cover desktop and phone layouts, authentication, persisted CRUD, server filters by status and owner, summary counts, the activity feed, a two-person edit conflict, a duplicate name, settings conflicts, the create retry, HTML escaping and failed-save recovery. Screenshots go to `.local/screenshots/`. API tests cover isolation, roles, expiry/revocation, CSRF origin checks, validation, pagination, version conflicts, unique names, idempotent retries, indexes, counts, activity and storage failures.

The workflow runs API tests and a production build on pushes to `main`, pull requests, and manual runs. Deployment runs only when the Quant variables and token are configured, and is skipped for pull requests or commits containing `[skip deploy]`. Browser tests are a local verification step. Fonts are loaded from Google Fonts with system fallbacks; self-host them if needed.

References: [Quant edge functions](https://docs.quantcdn.io/compute/functions), [KV stores](https://docs.quantcdn.io/compute/kv-stores/), [deploy action](https://github.com/quantcdn/deploy-action). The local `mc-ai/site` examples informed the function-body and deployment conventions; KV v2 indexes replace their best-effort shared index.
