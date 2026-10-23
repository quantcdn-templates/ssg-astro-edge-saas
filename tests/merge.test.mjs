import test from "node:test";
import assert from "node:assert/strict";
import { mergePage, placeProject } from "../src/scripts/merge.js";

const p = (id, updatedAt, status = "active") => ({ id, updatedAt, status });
const active = (project) => project.status === "active";

test("a page merge keeps a locally held project that is newer than the fetched copy", () => {
  const saved = p("a", "2026-10-23T10:00:05.000Z");
  const page = [p("a", "2026-10-23T10:00:00.000Z"), p("b", "2026-10-23T09:00:00.000Z")];
  const merged = mergePage([], page, [saved], active);
  assert.deepEqual(merged, [saved, page[1]]);
});

test("a page merge takes the fetched copy when it is newer or the same age", () => {
  const page = [p("a", "2026-10-23T10:00:05.000Z")];
  assert.deepEqual(mergePage([], page, [p("a", "2026-10-23T10:00:00.000Z")]), page);
  const same = [p("a", "2026-10-23T10:00:05.000Z")];
  assert.equal(mergePage([], same, [p("a", "2026-10-23T10:00:05.000Z")])[0], same[0]);
});

test("a newer local copy that left the filter is not shown", () => {
  // Saved as complete, but the eventual active list still returns it as active.
  const saved = p("a", "2026-10-23T10:00:05.000Z", "complete");
  const merged = mergePage([], [p("a", "2026-10-23T10:00:00.000Z")], [saved], active);
  assert.deepEqual(merged, []);
});

test("the newest of several held copies wins, and a later page appends", () => {
  const old = p("a", "2026-10-23T10:00:00.000Z");
  const fresh = p("a", "2026-10-23T10:00:09.000Z");
  const first = [p("z", "2026-10-23T08:00:00.000Z")];
  const merged = mergePage(first, [old], [fresh, old]);
  assert.deepEqual(merged, [first[0], fresh]);
});

test("placeProject replaces the earlier copy, or removes it when keep is false", () => {
  const list = [p("a", "1"), p("b", "1")];
  const saved = p("a", "2");
  assert.deepEqual(placeProject(list, saved), [list[1], saved]);
  assert.deepEqual(placeProject(list, saved, false), [list[1]]);
});
