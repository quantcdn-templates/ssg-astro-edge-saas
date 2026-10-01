import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
// Only a development adapter. Production uses the runtime's kvStore object.
export async function createKV(file) {
  let data = {};
  if (file) {
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  let pending = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(data, null, 2);
    pending = pending.then(async () => {
      if (!file) return;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    return pending;
  };
  const live = (entry) =>
    entry && (!entry.expires || entry.expires > Date.now());
  return {
    async get(store, key) {
      const entry = data[`${store}/${key}`];
      return live(entry) ? structuredClone(entry.value) : null;
    },
    async set(store, key, value, options = {}) {
      data[`${store}/${key}`] = {
        value: structuredClone(value),
        expires: options.ttl ? Date.now() + options.ttl * 1000 : null,
      };
      await persist();
      return true;
    },
    async delete(store, key) {
      delete data[`${store}/${key}`];
      await persist();
      return true;
    },
    async list(
      store,
      { prefix = "", limit = 50, cursor, includeValues = false } = {},
    ) {
      // Opaque cursor bound to its query, as in the real cursor API.
      let after = "";
      if (cursor) {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (parsed.store !== store || parsed.prefix !== prefix)
          throw new Error("Invalid cursor");
        after = parsed.after;
      }
      const keys = Object.keys(data)
        .filter(
          (k) =>
            k.startsWith(`${store}/${prefix}`) && live(data[k]) && k > after,
        )
        .sort();
      const selected = keys.slice(0, limit);
      const hasMore = keys.length > limit;
      return {
        items: selected.map((k) => ({
          key: k.slice(store.length + 1),
          ...(includeValues ? { value: structuredClone(data[k].value) } : {}),
        })),
        hasMore,
        cursor: hasMore
          ? Buffer.from(
              JSON.stringify({ store, prefix, after: selected.at(-1) }),
            ).toString("base64url")
          : null,
        scannedCount: selected.length,
      };
    },
  };
}
