import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  photoGridColumnCount,
  photoGridVisibleRows,
  photoGridWindow,
} from "../src/client/photo-grid-layout";

test("virtual columns follow the CSS breakpoint setting without implicit tracks", () => {
  assert.equal(photoGridColumnCount("2"), 2);
  assert.equal(photoGridColumnCount("3"), 3);
  assert.equal(photoGridColumnCount("4"), 4);
  assert.equal(photoGridColumnCount(""), 3);
});

test("large-grid window keeps a fixed overscan and pins only the focused row", () => {
  const current = photoGridWindow({
    itemCount: 600,
    columns: 3,
    rowHeight: 300,
    rowGap: 34,
    gridTop: 100,
    scrollY: 12_500,
    viewportHeight: 900,
    overscanRows: 5,
  });
  assert.deepEqual(current, { start: 32, end: 45 });
  assert.deepEqual(photoGridVisibleRows(current, 0), [0, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44]);
  assert.equal(photoGridVisibleRows(current).length, 13);
});

test("grid window clamps at the gallery boundaries", () => {
  assert.deepEqual(photoGridWindow({
    itemCount: 12,
    columns: 3,
    rowHeight: 260,
    rowGap: 34,
    gridTop: 100,
    scrollY: 0,
    viewportHeight: 700,
    overscanRows: 5,
  }), { start: 0, end: 4 });

  assert.deepEqual(photoGridWindow({
    itemCount: 12,
    columns: 3,
    rowHeight: 260,
    rowGap: 34,
    gridTop: 100,
    scrollY: 9_000,
    viewportHeight: 700,
    overscanRows: 5,
  }), { start: 3, end: 4 });
});
