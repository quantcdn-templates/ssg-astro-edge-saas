// A local Quant KV for the tests, from @quantcdn/edge-kv, with the indexes
// that quant/meta.json declares for the orbit store.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createLocalKv } from "@quantcdn/edge-kv";

const meta = JSON.parse(
  await readFile(new URL("../quant/meta.json", import.meta.url), "utf8"),
);
export const indexes =
  meta.kv_stores.find((store) => store.name === "orbit")?.indexes ?? [];
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const { KVError } = createLocalKv();

// A kvStore with one format 2 store that has the declared indexes.
export async function createKV(storeId, declared = indexes, options = {}) {
  const { kvStore, backend } = createLocalKv({
    indexes: { initialState: "ACTIVE" },
    KVError,
    ...options,
  });
  await backend.createStore({ id: storeId, format: 2 });
  for (const definition of declared)
    await backend.declareIndex(storeId, definition);
  return kvStore;
}
