import { expect, test } from "bun:test";
import { createAdminUploadListing, type AdminUploadListing } from "../src/client/admin-uploads";
import type { AdminUploadsResponse, UploadRecord } from "../src/shared/types";

const upload = (id: string): UploadRecord => ({
  id, filename: `${id}.jpg`, bytes: 10, width: 1, height: 1, contentType: "image/jpeg",
  createdAt: "2026-11-08T00:00:00.000Z", status: "pending", variants: [],
});
const page = (ids: string[], nextCursor: string | null, total = 3): AdminUploadsResponse => ({
  uploads: ids.map(upload), nextCursor, total,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("unfinished-upload pages retain ordering, suppress repeated clicks and remain retryable", async () => {
  let state!: AdminUploadListing;
  let calls = 0;
  const request = deferred<AdminUploadsResponse>();
  const listing = createAdminUploadListing(async (cursor) => {
    expect(cursor).toBe("next");
    calls++;
    return request.promise;
  }, (next) => { state = next; });
  listing.reset(page(["a"], "next"));
  const loading = listing.loadMore();
  await listing.loadMore();
  expect(calls).toBe(1);
  request.resolve(page(["a", "b", "c"], null));
  await loading;
  expect(state.uploads.map((value) => value.id)).toEqual(["a", "b", "c"]);
  expect(state.total).toBe(3);
  expect(state.loading).toBe(false);
  await listing.loadMore();
  expect(calls).toBe(1);
});

test("a refresh or sign-out aborts pagination and ignores late completion", async () => {
  let state!: AdminUploadListing;
  let signal!: AbortSignal;
  const request = deferred<AdminUploadsResponse>();
  const listing = createAdminUploadListing(async (_, nextSignal) => {
    signal = nextSignal;
    return request.promise;
  }, (next) => { state = next; });
  listing.reset(page(["a"], "next"));
  const loading = listing.loadMore();
  listing.reset();
  expect(signal.aborted).toBe(true);
  request.resolve(page(["private-old-record"], null));
  await loading;
  expect(state.uploads).toEqual([]);
  expect(state.loading).toBe(false);
});

test("failed pages keep the cursor for retry and disposal suppresses late errors", async () => {
  let state!: AdminUploadListing;
  let calls = 0;
  const request = deferred<AdminUploadsResponse>();
  const listing = createAdminUploadListing(async () => {
    calls++;
    if (calls === 1) throw new Error("Network unavailable");
    return request.promise;
  }, (next) => { state = next; });
  listing.reset(page(["a"], "next"));
  await expect(listing.loadMore()).rejects.toThrow("Network unavailable");
  expect(state.nextCursor).toBe("next");
  expect(state.uploads.map((value) => value.id)).toEqual(["a"]);
  expect(state.error).toBe("Network unavailable");
  const retry = listing.loadMore();
  listing.dispose();
  request.reject(new Error("Late network failure"));
  await retry;
  expect(state.error).toBe("");
});

test("removing an unfinished upload invalidates an older page and updates its count", async () => {
  let state!: AdminUploadListing;
  const request = deferred<AdminUploadsResponse>();
  const listing = createAdminUploadListing(async () => request.promise, (next) => { state = next; });
  listing.reset(page(["a", "b"], "next"));
  const loading = listing.loadMore();
  listing.remove("a");
  request.resolve(page(["a", "c"], null));
  await loading;
  expect(state.uploads.map((value) => value.id)).toEqual(["b"]);
  expect(state.total).toBe(2);
  expect(state.nextCursor).toBe("next");
  expect(state.loading).toBe(false);
});
