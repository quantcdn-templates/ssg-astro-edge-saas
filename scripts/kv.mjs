import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");

// Only a development adapter. Production uses the runtime's kvStore object.
// It follows the Quant edge runtime's KV v2 contract (format 2 store): the
// polyfill src/sandbox/isolate-runtime/polyfills/kvstore.js and the host code
// in mocks/kv-backends/ of the edge runtime, and the management API rules in
// app-api-spec.yaml. It does not model eventual index lists, index build
// states, ledgers (append, since/until) or search.

const DETAIL_FIELDS = [
  "key",
  "currentVersion",
  "reason",
  "operation",
  "index",
  "existingKey",
  "state",
  "activeAfter",
];
const STATUS = {
  CONFLICT: 409,
  UNIQUE_VIOLATION: 409,
  COUNT_WITH_TTL: 400,
  INDEX_FIELD_ENCRYPTED: 400,
  VALIDATION: 400,
  CURSOR_INVALID: 400,
};

export class KVError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "KVError";
    this.code = code;
    this.status = STATUS[code];
    this.retryable = false;
    for (const field of DETAIL_FIELDS)
      if (["string", "number"].includes(typeof details[field]))
        this[field] = details[field];
  }
}

const invalid = (message, details) =>
  new KVError("VALIDATION", message, details);
const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const own = (object, field) =>
  Object.prototype.hasOwnProperty.call(object, field);
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// ---- Versions: 26 Crockford base32 characters (the ULID alphabet), from a
// counter, so a later version always sorts after an earlier one.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const VERSION = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const renderVersion = (n) => {
  let text = "";
  for (let rest = n; rest > 0n; rest /= 32n)
    text = CROCKFORD[Number(rest % 32n)] + text;
  return text.padStart(26, "0");
};
const parseVersion = (text) =>
  [...text].reduce((n, c) => n * 32n + BigInt(CROCKFORD.indexOf(c)), 0n);

// ---- Values: the runtime JSON-encodes objects and parses JSON strings.
function parseStringValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function storedForm(value) {
  if (["undefined", "function", "symbol"].includes(typeof value))
    throw invalid("value is required and must be JSON");
  if (typeof value === "object") return JSON.parse(JSON.stringify(value));
  return parseStringValue(value);
}

// decodeStoredValue (kv-values.js): a JSON null reads as its text.
function decodeStoredValue(value) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  try {
    const parsed = JSON.parse(text);
    return parsed === null ? text : parsed;
  } catch {
    return text;
  }
}

// ---- Keys and collections: the collection is the text before the last ":".
const collectionOf = (key) =>
  key.includes(":") ? key.slice(0, key.lastIndexOf(":")) : "";
const idOf = (key) => key.slice(key.lastIndexOf(":") + 1);

function matchesCollection(pattern, collection) {
  const p = pattern.split(":");
  const c = collection.split(":");
  return p.length === c.length && p.every((s, i) => s === "*" || s === c[i]);
}

// ---- Index keys (backend kv-index-keys): values are type-tagged and
// numbers sort numerically.
const SEP = "\u0000";

function encodeNumber(n) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(n === 0 ? 0 : n);
  if (n >= 0) buf[0] ^= 0x80;
  else for (let i = 0; i < 8; i++) buf[i] ^= 0xff;
  return buf.toString("hex");
}

const ENCODERS = {
  boolean: (v) => (v ? "2" : "1"),
  number: (v) => (Number.isFinite(v) ? "3" + encodeNumber(v) : undefined),
  string: (v) => {
    if (v.includes(SEP))
      throw invalid("Indexed strings must not contain U+0000");
    return "4" + v;
  },
};

function encodeScalar(value) {
  if (value === null) return "0";
  const encoder = ENCODERS[typeof value];
  return encoder ? encoder(value) : undefined;
}

function fieldValues(def, value) {
  if (!isPlainObject(value)) return def.fields.length === 0 ? [] : undefined;
  const out = [];
  for (const field of def.fields) {
    const encoded = own(value, field) ? encodeScalar(value[field]) : undefined;
    if (encoded === undefined) return undefined;
    out.push(encoded);
  }
  return out;
}

function sortPart(def, value) {
  if (!def.sortBy || !isPlainObject(value) || !own(value, def.sortBy))
    return "";
  return encodeScalar(value[def.sortBy]) ?? "";
}

const sameValues = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- Option checks, as the runtime makes them.
const STORE_ID = /^[A-Za-z0-9_-]{1,255}$/;
function checkStore(storeId) {
  if (typeof storeId !== "string" || !STORE_ID.test(storeId))
    throw new Error("Invalid KV store identifier");
  return storeId;
}

// kv-store.js checkWriteOptions: a misspelt condition or secret flag throws;
// any other unknown option is ignored.
const WRITE_OPTIONS = {
  set: ["ttl", "secret", "ifAbsent", "ifVersion"],
  delete: ["ifVersion"],
};
const STRICT_OPTION = /^if|absent|version|condition|exists|secret|encrypt/i;
function checkWriteOptions(kind, options) {
  if (!options || typeof options !== "object") return;
  for (const name of Object.keys(options)) {
    if (!WRITE_OPTIONS[kind].includes(name) && STRICT_OPTION.test(name))
      throw invalid(`Unknown ${kind} option: ${name}`);
  }
}
const safeOptions = (options) => (isPlainObject(options) ? options : {});
const hasCondition = (o) =>
  o.ifAbsent !== undefined || o.ifVersion !== undefined;

// aws-backend.js validateCondition, then the backend's version pattern.
function checkCondition({ ifAbsent, ifVersion }, details) {
  if (ifAbsent !== undefined && ifAbsent !== true)
    throw invalid("ifAbsent must be true when given", details);
  if (
    ifVersion !== undefined &&
    (typeof ifVersion !== "string" || !VERSION.test(ifVersion))
  )
    throw invalid("ifVersion must be a version from getEntry", details);
  if (ifAbsent === true && ifVersion !== undefined)
    throw invalid("Use ifAbsent or ifVersion, not both", details);
}

const isTtl = (ttl) => Number.isInteger(ttl) && ttl >= 60 && ttl <= 31536000;
function checkTtl(ttl, details) {
  if (ttl !== undefined && !isTtl(ttl))
    throw invalid(
      "ttl must be an integer from 60 to 31536000 seconds",
      details,
    );
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,64}$/;
function checkTransactArgs(operations, options) {
  if (
    !Array.isArray(operations) ||
    operations.length < 1 ||
    operations.length > 25
  )
    throw invalid("A transaction takes 1 to 25 operations");
  if (
    !isPlainObject(options) ||
    Object.keys(options).some((n) => n !== "idempotencyKey")
  )
    throw invalid("commit options only support idempotencyKey");
  const key = options.idempotencyKey;
  if (
    key !== undefined &&
    !(typeof key === "string" && IDEMPOTENCY_KEY.test(key))
  )
    throw invalid("idempotencyKey must be 1 to 64 letters, digits, - or _");
}

const isAmount = (amount) => Number.isSafeInteger(amount) && amount !== 0;
function checkIncrementArgs(key, amount, options) {
  if (typeof key !== "string" || !key.length || key.length > 2048)
    throw invalid("Invalid counter key");
  if (!isAmount(amount)) throw invalid("amount must be a nonzero safe integer");
  if (!isPlainObject(options) || Object.keys(options).some((n) => n !== "ttl"))
    throw invalid("Increment options only support ttl");
  checkTtl(options.ttl);
}

// The fields each operation type takes (POST /transact).
const OPERATION_CHECKS = {
  check(op, details) {
    if (typeof op.version !== "string" || !VERSION.test(op.version))
      throw invalid("check needs a version from getEntry", details);
  },
  set(op, details) {
    if (!own(op, "value")) throw invalid("set needs a value", details);
    checkCondition(op, details);
    checkTtl(op.ttl, details);
  },
  delete(op, details) {
    checkCondition(op, details);
  },
  increment(op, details) {
    if (!isAmount(op.amount))
      throw invalid("amount must be a nonzero safe integer", details);
  },
};

function checkOperation(op, index, seen) {
  const details = { operation: index, key: op.key };
  if (typeof op.key !== "string" || !op.key.length)
    throw invalid("Invalid key", details);
  if (seen.has(op.key))
    throw invalid("A transaction names each key once", details);
  seen.add(op.key);
  const check = own(OPERATION_CHECKS, op.type)
    ? OPERATION_CHECKS[op.type]
    : undefined;
  if (!check) throw invalid("Unknown operation type", details);
  check(op, details);
}

// The next value of a counter, or why it has none.
function nextCount(old, amount) {
  if (old && (old.encrypted || !Number.isSafeInteger(old.value)))
    return { reason: "not_numeric" };
  const value = (old ? old.value : 0) + amount;
  return Number.isSafeInteger(value) ? { value } : { reason: "range" };
}

async function loadData(file) {
  if (!file) return {};
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return {};
  }
}

function highestVersion(data) {
  let highest = 0n;
  for (const { version } of Object.values(data)) {
    const n =
      typeof version === "string" && VERSION.test(version)
        ? parseVersion(version)
        : 0n;
    if (n > highest) highest = n;
  }
  return highest;
}

// ---- Query options: kv-query-options.js (the public edge query contract).
const QUERY_TYPES = ["all", "plaintext", "encrypted"];
const RESERVED_FIELDS = ["__proto__", "constructor", "prototype"];
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const INDEX_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COLLECTION_OPTIONS = [
  "collection",
  "startsWith",
  "after",
  "before",
  "reverse",
  "since",
  "until",
];

function checkAllowedKeys(options) {
  const withWhere =
    options.collection !== undefined || options.index !== undefined;
  const allowed = [
    "prefix",
    "limit",
    "cursor",
    "includeValues",
    "type",
    ...COLLECTION_OPTIONS,
    "index",
    "equals",
    ...(withWhere ? ["where"] : []),
  ];
  const unknown = Object.keys(options).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new Error(`Unknown KV query option: ${unknown}`);
}

function checkPaging(limit, includeValues, type, cursor) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("KV query limit must be an integer from 1 to 100");
  if (typeof includeValues !== "boolean")
    throw new Error("includeValues must be boolean");
  if (!QUERY_TYPES.includes(type)) throw new Error("Invalid KV query type");
  if (cursor == null) return;
  if (typeof cursor !== "string" || !cursor.length || cursor.length > 8192)
    throw new Error("Invalid KV query cursor");
}

function checkPrefix(prefix) {
  if (prefix === undefined) return;
  if (typeof prefix !== "string" || !prefix.length || prefix.length > 512)
    throw new Error(
      "prefix must be a non-empty string of at most 512 characters",
    );
}

function isWhereScalar(value) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= 512;
}

const isFieldName = (field) =>
  FIELD_NAME.test(field) && !RESERVED_FIELDS.includes(field);

function checkWhere(where, type) {
  if (where === undefined) return;
  const fieldCount = isPlainObject(where) ? Object.keys(where).length : 0;
  if (fieldCount < 1 || fieldCount > 8)
    throw new Error("where must contain 1 to 8 field equalities");
  for (const [field, value] of Object.entries(where)) {
    if (!isFieldName(field)) throw new Error("Invalid where field");
    if (!isWhereScalar(value))
      throw new Error(
        "where values must be JSON scalars (strings at most 512 characters)",
      );
  }
  if (type === "encrypted")
    throw new Error("Cannot filter fields of encrypted values");
}

function checkIdBound(name, value) {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 1000 ||
    value.includes(":")
  )
    throw new Error(`${name} must be 1 to 1000 characters without ":"`);
}

function checkCollectionBounds({ startsWith, after, before }) {
  for (const [name, value] of [
    ["startsWith", startsWith],
    ["after", after],
    ["before", before],
  ])
    checkIdBound(name, value);
  if (startsWith !== undefined && (after !== undefined || before !== undefined))
    throw new Error("Use startsWith or after/before, not both");
  if (
    after !== undefined &&
    before !== undefined &&
    byteOrder(after, before) >= 0
  )
    throw new Error("after must sort before before");
}

const hasWindow = ({ since, until }) =>
  since !== undefined || until !== undefined;
const someDefined = (values) => values.some((v) => v !== undefined);

function checkReverse(reverse) {
  if (reverse !== undefined && typeof reverse !== "boolean")
    throw new Error("reverse must be boolean");
}

function checkCollection(options) {
  const { collection, startsWith, after, before, reverse, prefix } = options;
  if (collection === undefined) {
    if (someDefined([startsWith, after, before, reverse]))
      throw new Error(
        "startsWith, after, before and reverse need a collection",
      );
    if (hasWindow(options)) throw invalid("since, until need a collection");
    return;
  }
  if (typeof collection !== "string" || collection.length > 1024)
    throw new Error("collection must be a string of at most 1024 characters");
  if (prefix !== undefined)
    throw new Error("Use one of collection, prefix or pattern");
  checkReverse(reverse);
  checkCollectionBounds(options);
  // Ledgers are not emulated: the runtime needs a ledger collection here.
  if (hasWindow(options))
    throw new Error("Ledger lists (since/until) are not emulated");
}

function checkIndexName(index) {
  if (typeof index !== "string" || !INDEX_NAME.test(index))
    throw new Error(
      "index must be a name of 1 to 64 letters, digits or _, starting with a letter",
    );
}

function checkEquals(equals, min = 1) {
  if (!isPlainObject(equals))
    throw new Error("equals must be an object of scalar fields");
  const fields = Object.entries(equals);
  if (fields.length < min || fields.length > 3)
    throw new Error(`equals must contain ${min} to 3 scalar fields`);
  for (const [field, value] of fields) {
    if (!isFieldName(field)) throw new Error("Invalid equals field");
    if (!isWhereScalar(value))
      throw new Error(
        "equals values must be JSON scalars (strings at most 512 characters)",
      );
  }
}

function checkIndexBound(name, value) {
  const ok =
    isWhereScalar(value) || (typeof value === "string" && value.length <= 2048);
  if (value !== undefined && !ok)
    throw new Error(
      `${name} must be a JSON scalar (strings at most 2048 characters)`,
    );
}

function checkIndex(options) {
  const {
    index,
    equals,
    after,
    before,
    reverse,
    collection,
    prefix,
    startsWith,
  } = options;
  checkIndexName(index);
  if (hasWindow(options))
    throw invalid("since/until cannot be combined with index");
  if (someDefined([collection, prefix, startsWith]))
    throw new Error(
      "index cannot be combined with collection, prefix, pattern or startsWith",
    );
  if (equals !== undefined) checkEquals(equals, 0);
  checkIndexBound("after", after);
  checkIndexBound("before", before);
  checkReverse(reverse);
}

function checkModeOptions(options) {
  if (options.index !== undefined) return checkIndex(options);
  if (options.equals !== undefined) throw new Error("equals needs an index");
  return checkCollection(options);
}

function validateQueryOptions(options = {}) {
  if (!isPlainObject(options))
    throw new Error("KV query options must be an object");
  checkAllowedKeys(options);
  const { limit = 25, includeValues = false, type = "all" } = options;
  checkPaging(limit, includeValues, type, options.cursor);
  checkPrefix(options.prefix);
  checkModeOptions(options);
  checkWhere(options.where, type);
  return { ...options, limit, includeValues, type };
}

// Lookup and count arguments are VALIDATION errors (aws-backend.js indexPath).
function checkIndexArgs(index, equals, min) {
  try {
    checkIndexName(index);
    if (equals !== undefined || min > 0) checkEquals(equals, min);
  } catch (error) {
    throw invalid(error.message);
  }
}

function checkBatchKeys(keys) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 100)
    throw invalid("getMany takes 1 to 100 keys");
  if (keys.some((key) => typeof key !== "string" || !key.length))
    throw invalid("getMany keys must be non-empty strings");
}

// ---- The atomic builder (kv-atomic.js and the polyfill's copy).
const SET_OPTIONS = ["ifAbsent", "ifVersion", "secret", "ttl"];
const DELETE_OPTIONS = ["ifVersion"];

function refuseUnknownOptions(kind, options, allowed) {
  const unknown = Object.keys(options).find((name) => !allowed.includes(name));
  if (unknown !== undefined)
    throw new Error(`Unknown ${kind} option: ${unknown}`);
}

function setOperation(key, value, options = {}) {
  refuseUnknownOptions("set", options, SET_OPTIONS);
  const op = { type: "set", key, value: parseStringValue(value) };
  if (options.ifAbsent !== undefined) op.ifAbsent = options.ifAbsent;
  if (options.ifVersion !== undefined) op.ifVersion = options.ifVersion;
  if (options.secret === true) op.encrypted = true;
  if (options.ttl !== undefined) op.ttl = options.ttl;
  return op;
}

function deleteOperation(key, options = {}) {
  refuseUnknownOptions("delete", options, DELETE_OPTIONS);
  const op = { type: "delete", key };
  if (options.ifVersion !== undefined) op.ifVersion = options.ifVersion;
  return op;
}

function createAtomic(commit) {
  const operations = [];
  let committed = false;
  const builder = {
    check(key, version) {
      operations.push({ type: "check", key: String(key), version });
      return builder;
    },
    set(key, value, options) {
      operations.push(setOperation(String(key), value, options));
      return builder;
    },
    delete(key, options) {
      operations.push(deleteOperation(String(key), options));
      return builder;
    },
    increment(key, amount = 1) {
      operations.push({ type: "increment", key: String(key), amount });
      return builder;
    },
    async commit(options = {}) {
      if (committed) throw new Error("This transaction was already committed");
      committed = true;
      return commit(operations.slice(), options);
    },
  };
  return builder;
}

// ---- Entries and pages.
const isoTime = (ms) => new Date(ms).toISOString();

function toEntry(key, entry) {
  const out = {
    key,
    value: decodeStoredValue(entry.value),
    createdAt: isoTime(entry.createdAt),
    updatedAt: isoTime(entry.updatedAt),
  };
  if (entry.expires) out.expiresAt = Math.floor(entry.expires / 1000);
  out.version = entry.version;
  out.encrypted = !!entry.encrypted;
  return out;
}

function toItem(key, entry, includeValues) {
  const item = { key, encrypted: !!entry.encrypted, version: entry.version };
  if (includeValues) item.value = entry.encrypted ? "[ENCRYPTED]" : entry.value;
  return item;
}

const encodeCursor = (query, pos) =>
  Buffer.from(JSON.stringify({ query, pos })).toString("base64url");

function decodeCursor(cursor, query) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (parsed.query === query && typeof parsed.pos === "string")
      return parsed.pos;
  } catch {
    // Falls through to the error below.
  }
  throw new KVError(
    "CURSOR_INVALID",
    "The cursor does not belong to this listing",
  );
}

function whereMatches(entry, where) {
  if (!where) return true;
  if (entry.encrypted || !isPlainObject(entry.value)) return false;
  return Object.entries(where).every(
    ([field, value]) =>
      own(entry.value, field) &&
      encodeScalar(entry.value[field]) === encodeScalar(value),
  );
}

function typeMatches(entry, type) {
  if (type === "plaintext") return !entry.encrypted;
  if (type === "encrypted") return !!entry.encrypted;
  return true;
}

// Exclusive bounds of an index list as positions (kv-index-keys sortBounds).
function boundPosition(def, value, side) {
  if (!def.sortBy) {
    if (typeof value !== "string")
      throw invalid("after and before are keys when the index has no sortBy");
    return side === "lo" ? SEP + value + SEP : SEP + value;
  }
  const encoded = encodeScalar(value);
  if (encoded === undefined)
    throw invalid("after and before must be JSON scalars");
  return side === "lo" ? encoded + "\u0001" : encoded + SEP;
}

function inRange(pos, lo, hi) {
  if (lo !== undefined && byteOrder(pos, lo) < 0) return false;
  return hi === undefined || byteOrder(pos, hi) < 0;
}

function idInBounds(id, { startsWith, after, before }) {
  if (startsWith !== undefined && !id.startsWith(startsWith)) return false;
  if (after !== undefined && byteOrder(id, after) <= 0) return false;
  return before === undefined || byteOrder(id, before) < 0;
}

function pageOf(rows, options, query) {
  const direction = options.reverse ? -1 : 1;
  rows.sort((a, b) => direction * byteOrder(a.pos, b.pos));
  const from = options.cursor ? decodeCursor(options.cursor, query) : undefined;
  const after =
    from === undefined
      ? rows
      : rows.filter((r) => direction * byteOrder(r.pos, from) > 0);
  const selected = after.slice(0, options.limit);
  const hasMore = after.length > options.limit;
  return {
    items: selected.map((r) => toItem(r.key, r.entry, options.includeValues)),
    cursor: hasMore ? encodeCursor(query, selected.at(-1).pos) : null,
    hasMore,
    scannedCount: selected.length,
  };
}

// ---- The store.
export async function createKV(file, { indexes: declared = [] } = {}) {
  const indexes = declared.map((def) => ({ fields: [], ...def }));
  const data = await loadData(file);
  const idempotency = new Map();
  let counter = highestVersion(data);
  const nextVersion = () => renderVersion(++counter);
  for (const entry of Object.values(data)) upgradeEntry(entry);

  // An entry from an older emulator file gets a version and timestamps.
  function upgradeEntry(entry) {
    if (typeof entry.version !== "string") entry.version = nextVersion();
    entry.createdAt ??= Date.now();
    entry.updatedAt ??= entry.createdAt;
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

  const live = (entry, now = Date.now()) =>
    !!entry && (!entry.expires || entry.expires > now);
  const slot = (store, key) => `${store}/${key}`;
  const liveEntry = (store, key) => {
    const entry = data[slot(store, key)];
    return live(entry) ? entry : null;
  };
  const indexesFor = (key) =>
    indexes.filter((def) =>
      matchesCollection(def.collection, collectionOf(key)),
    );
  const findIndex = (name) => {
    const def = indexes.find((d) => d.name === name);
    if (!def) throw invalid(`No index named ${name}`);
    return def;
  };

  function liveRows(store, now = Date.now()) {
    const head = `${store}/`;
    return Object.entries(data)
      .filter(([k, entry]) => k.startsWith(head) && live(entry, now))
      .map(([k, entry]) => ({ key: k.slice(head.length), entry }));
  }

  const memberValues = (def, key, entry) =>
    entry.encrypted || !matchesCollection(def.collection, collectionOf(key))
      ? undefined
      : fieldValues(def, entry.value);

  // equals must give exactly the index fields (kv-index-keys equalsPartition).
  function equalsValues(def, equals) {
    const empty =
      equals === undefined ||
      (isPlainObject(equals) && !Object.keys(equals).length);
    if (def.fields.length === 0 && empty) return [];
    const exact =
      isPlainObject(equals) &&
      Object.keys(equals).length === def.fields.length &&
      def.fields.every((f) => own(equals, f));
    if (!exact)
      throw invalid(
        `equals must give exactly these fields: ${def.fields.join(", ") || "(none)"}`,
      );
    const values = def.fields.map((f) => encodeScalar(equals[f]));
    if (values.some((v) => v === undefined))
      throw invalid("equals values must be JSON scalars");
    return values;
  }

  function members(store, def, values) {
    return liveRows(store).filter(({ key, entry }) => {
      const held = memberValues(def, key, entry);
      return held !== undefined && sameValues(held, values);
    });
  }

  // ---- Writes. Each operation is checked, then all are staged, then written.
  function conflict(op, details, reason, current) {
    return new KVError(
      "CONFLICT",
      `The condition on ${op.key} failed (${reason})`,
      {
        ...details,
        key: op.key,
        reason,
        ...(current ? { currentVersion: current.version } : {}),
      },
    );
  }

  function checkVersion(op, details, store, version) {
    const current = liveEntry(store, op.key);
    if (current && current.version === version) return;
    if (current) throw conflict(op, details, "version", current);
    throw conflict(
      op,
      details,
      data[slot(store, op.key)] ? "expired" : "missing",
    );
  }

  function checkConditions(store, op, details) {
    if (op.type === "check")
      return checkVersion(op, details, store, op.version);
    if (op.ifVersion !== undefined)
      return checkVersion(op, details, store, op.ifVersion);
    const current = liveEntry(store, op.key);
    if (op.ifAbsent === true && current)
      throw conflict(op, details, "exists", current);
  }

  // Index refusals come before anything is read (transact, putOp rules).
  function checkIndexRules(op, details) {
    const defs = indexesFor(op.key);
    if (!defs.length) return;
    if (op.type === "increment")
      throw invalid(
        "increment is not available in a collection with indexes",
        details,
      );
    if (op.type !== "set") return;
    if (op.encrypted === true)
      throw new KVError(
        "INDEX_FIELD_ENCRYPTED",
        "A collection with indexes cannot hold encrypted values",
        details,
      );
    if (op.ttl !== undefined && defs.some((d) => d.count))
      throw new KVError(
        "COUNT_WITH_TTL",
        "A collection with a count index cannot hold keys with ttl",
        details,
      );
  }

  function newEntry(old, value, now, { encrypted, expires }) {
    return {
      value,
      expires,
      version: nextVersion(),
      ...(encrypted ? { encrypted: true } : {}),
      createdAt: old ? old.createdAt : now,
      updatedAt: now,
    };
  }

  function stagedIncrement(store, op, details, now) {
    const old = liveEntry(store, op.key);
    const { value, reason } = nextCount(old, op.amount);
    if (reason) throw conflict(op, details, reason, old);
    return newEntry(old, value, now, { expires: old ? old.expires : null });
  }

  function stagedEntry(store, op, details, now) {
    if (op.type === "delete") return null;
    if (op.type === "increment")
      return stagedIncrement(store, op, details, now);
    const options = {
      encrypted: op.encrypted === true,
      expires: op.ttl ? now + op.ttl * 1000 : null,
    };
    return newEntry(liveEntry(store, op.key), op.value, now, options);
  }

  // The state after the transaction, without the keys that later set
  // operations claim (they are checked at their own operation).
  function stateFor(store, staged, ops, i) {
    const later = new Set(
      ops
        .slice(i + 1)
        .filter((o) => o.type === "set")
        .map((o) => o.key),
    );
    const state = new Map(liveRows(store).map((r) => [r.key, r.entry]));
    for (const [key, entry] of staged)
      entry ? state.set(key, entry) : state.delete(key);
    for (const key of [...later, ops[i].key]) state.delete(key);
    return state;
  }

  function checkUnique(store, staged, ops, i, details) {
    const op = ops[i];
    const defs = indexesFor(op.key).filter((d) => d.unique);
    if (op.type !== "set" || !defs.length) return;
    const state = stateFor(store, staged, ops, i);
    for (const def of defs) {
      const values = fieldValues(def, staged.get(op.key).value);
      const owner =
        values &&
        [...state].find(([key, entry]) =>
          sameValues(memberValues(def, key, entry), values),
        );
      if (owner)
        throw new KVError(
          "UNIQUE_VIOLATION",
          `Another key holds this value of index ${def.name}`,
          {
            ...details,
            index: def.name,
            existingKey: owner[0],
          },
        );
    }
  }

  // Runs operations as one all-or-nothing write. single: a plain set/delete,
  // whose errors carry no operation index.
  async function apply(store, ops, single = false) {
    const now = Date.now();
    const detailsOf = (i) => (single ? {} : { operation: i });
    ops.forEach((op, i) => checkIndexRules(op, detailsOf(i)));
    ops.forEach((op, i) => checkConditions(store, op, detailsOf(i)));
    const staged = new Map();
    ops.forEach((op, i) => {
      if (op.type !== "check")
        staged.set(op.key, stagedEntry(store, op, detailsOf(i), now));
    });
    ops.forEach((op, i) => checkUnique(store, staged, ops, i, detailsOf(i)));
    const versions = {};
    for (const [key, entry] of staged) {
      if (entry) {
        data[slot(store, key)] = entry;
        versions[key] = entry.version;
      } else delete data[slot(store, key)];
    }
    await persist();
    return versions;
  }

  function replayOf(store, options, ops) {
    if (!options.idempotencyKey) return undefined;
    const record = idempotency.get(`${store}\n${options.idempotencyKey}`);
    if (!record || Date.now() - record.at > 86_400_000) return undefined;
    if (record.operations !== JSON.stringify(ops))
      throw invalid("This idempotencyKey was used for different operations");
    return { versions: { ...record.versions }, replayed: true };
  }

  async function transact(storeId, operations, options = {}) {
    const store = checkStore(storeId);
    checkTransactArgs(operations, options);
    const ops = JSON.parse(JSON.stringify(operations));
    const replay = replayOf(store, options, ops);
    if (replay) return replay;
    const seen = new Set();
    ops.forEach((op, i) => checkOperation(op, i, seen));
    const versions = await apply(store, ops);
    if (options.idempotencyKey)
      idempotency.set(`${store}\n${options.idempotencyKey}`, {
        operations: JSON.stringify(ops),
        versions: { ...versions },
        at: Date.now(),
      });
    return { versions, replayed: false };
  }

  // The backend drops a ttl that is not a positive integer (buildPutBody).
  const putTtl = (ttl) => (Number.isInteger(ttl) && ttl > 0 ? ttl : undefined);

  async function set(storeId, key, value, options) {
    const store = checkStore(storeId);
    checkWriteOptions("set", options);
    const o = safeOptions(options);
    checkCondition(o);
    const op = {
      type: "set",
      key: String(key),
      value: storedForm(value),
      ttl: putTtl(o.ttl),
    };
    checkTtl(op.ttl);
    if (o.secret === true) op.encrypted = true;
    if (o.ifAbsent !== undefined) op.ifAbsent = o.ifAbsent;
    if (o.ifVersion !== undefined) op.ifVersion = o.ifVersion;
    const versions = await apply(store, [op], true);
    return hasCondition(o) ? { version: versions[op.key] } : true;
  }

  // Format 2: an unconditional delete of a missing key returns false.
  async function remove(storeId, key, options) {
    const store = checkStore(storeId);
    checkWriteOptions("delete", options);
    const o = safeOptions(options);
    const op = { type: "delete", key: String(key) };
    if (o.ifVersion !== undefined) {
      checkCondition({ ifVersion: o.ifVersion });
      op.ifVersion = o.ifVersion;
    } else if (!liveEntry(store, op.key)) return false;
    await apply(store, [op], true);
    return true;
  }

  // Single increment: ttl applies on creation or after expiry; a value that
  // is not a safe integer is VALIDATION (format 2).
  async function increment(storeId, key, amount = 1, options = {}) {
    const store = checkStore(storeId);
    checkIncrementArgs(key, amount, options);
    if (indexesFor(key).length)
      throw invalid("increment is not available in a collection with indexes");
    const now = Date.now();
    const old = liveEntry(store, key);
    const { value, reason } = nextCount(old, amount);
    if (reason) throw invalid(`The counter cannot be incremented (${reason})`);
    const created = options.ttl ? now + options.ttl * 1000 : null;
    data[slot(store, key)] = newEntry(old, value, now, {
      expires: old ? old.expires : created,
    });
    await persist();
    return value;
  }

  // ---- Reads and lists.
  function indexRows(store, options) {
    const def = findIndex(options.index);
    const values = equalsValues(def, options.equals);
    const lo =
      options.after === undefined
        ? undefined
        : boundPosition(def, options.after, "lo");
    const hi =
      options.before === undefined
        ? undefined
        : boundPosition(def, options.before, "hi");
    return members(store, def, values)
      .map((r) => ({ ...r, pos: sortPart(def, r.entry.value) + SEP + r.key }))
      .filter((r) => inRange(r.pos, lo, hi));
  }

  function keyRows(store, options) {
    const rows = liveRows(store).map((r) => ({ ...r, pos: r.key }));
    if (options.collection === undefined)
      return rows.filter((r) => r.key.startsWith(options.prefix ?? ""));
    return rows.filter(
      (r) =>
        collectionOf(r.key) === options.collection &&
        idInBounds(idOf(r.key), options),
    );
  }

  const QUERY_FIELDS = [
    "index",
    "equals",
    "collection",
    "prefix",
    "startsWith",
    "after",
    "before",
    "reverse",
    "where",
    "type",
  ];

  async function list(storeId, options) {
    const store = checkStore(storeId);
    const o = validateQueryOptions(options);
    const rows = (
      o.index === undefined ? keyRows(store, o) : indexRows(store, o)
    ).filter(
      (r) => typeMatches(r.entry, o.type) && whereMatches(r.entry, o.where),
    );
    const query = JSON.stringify([
      store,
      ...QUERY_FIELDS.map((f) => o[f] ?? null),
    ]);
    const page = pageOf(rows, o, query);
    const indexed = o.collection !== undefined || o.index !== undefined;
    return indexed ? { ...page, indexed: true } : page;
  }

  return {
    async get(storeId, key, skipDecode = false) {
      const entry = liveEntry(checkStore(storeId), String(key));
      if (!entry || entry.value === null) return null;
      if (skipDecode)
        return typeof entry.value === "string"
          ? entry.value
          : JSON.stringify(entry.value);
      return decodeStoredValue(entry.value);
    },
    async getEntry(storeId, key) {
      const entry = liveEntry(checkStore(storeId), String(key));
      return entry ? toEntry(String(key), entry) : null;
    },
    async getMany(storeId, keys) {
      const store = checkStore(storeId);
      checkBatchKeys(keys);
      return keys.map((key) => {
        const entry = liveEntry(store, key);
        return entry ? toEntry(key, entry) : null;
      });
    },
    async getBy(storeId, index, equals) {
      const store = checkStore(storeId);
      checkIndexArgs(index, equals, 1);
      const def = findIndex(index);
      if (!def.unique) throw invalid(`Index ${index} is not unique`);
      const [owner] = members(store, def, equalsValues(def, equals));
      return owner ? toEntry(owner.key, owner.entry) : null;
    },
    async count(storeId, options) {
      const store = checkStore(storeId);
      if (!isPlainObject(options))
        throw invalid("count takes { index, equals }");
      checkIndexArgs(options.index, options.equals, 0);
      const def = findIndex(options.index);
      if (!def.count)
        throw invalid(`Index ${options.index} is not a count index`);
      return members(store, def, equalsValues(def, options.equals)).length;
    },
    set,
    delete: remove,
    increment,
    list,
    atomic(storeId) {
      checkStore(storeId);
      return createAtomic((operations, options) =>
        transact(storeId, operations, options),
      );
    },
    transact,
  };
}

// The indexes of the orbit store in quant/meta.json ([] when none).
export async function indexesFromMeta(path) {
  const meta = JSON.parse(await readFile(path, "utf8"));
  const orbit = (meta.kv_stores ?? []).find((s) => s.name === "orbit");
  return Array.isArray(orbit?.indexes) ? orbit.indexes : [];
}
