import assert from "node:assert/strict";
import { test } from "bun:test";
import { createUploadBatchRefresh } from "../src/client/upload-refresh";
import type { UploadStatus, UploadTask } from "../src/client/uploads";

const task = (id: string, status: UploadStatus): UploadTask => ({
  id, status, file: new File(["fixture"], `${id}.jpg`), progress: 0,
});
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("a multi-photo batch reconciles once after all work has settled", async () => {
  let calls = 0;
  const observer = createUploadBatchRefresh(async () => { calls++; });
  observer.update([task("a", "processing"), task("b", "queued")]);
  observer.update([task("a", "complete"), task("b", "uploading")]);
  assert.equal(calls, 0);
  observer.update([task("a", "complete"), task("b", "complete")]);
  await tick();
  observer.update([task("a", "complete"), task("b", "complete")]);
  assert.equal(calls, 1);
  observer.dispose();
});

test("cancelled and failed tasks do not prevent reconciliation of successful photos", async () => {
  let calls = 0;
  const observer = createUploadBatchRefresh(async () => { calls++; });
  observer.update([task("a", "complete"), task("b", "processing")]);
  observer.update([task("a", "complete"), task("b", "cancelled"), task("c", "error")]);
  assert.equal(calls, 1);
  await tick();
  observer.update([task("b", "queued"), task("c", "error")]);
  observer.update([task("b", "complete"), task("c", "error")]);
  assert.equal(calls, 2);
  observer.dispose();
});

test("later batches wait for an active reconciliation and coalesce into one follow-up", async () => {
  let finish!: () => void;
  let calls = 0;
  const observer = createUploadBatchRefresh(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
  });
  observer.update([task("a", "complete")]);
  observer.update([task("a", "complete"), task("b", "complete")]);
  observer.update([task("a", "complete"), task("b", "complete"), task("c", "complete")]);
  assert.equal(calls, 1);
  finish();
  await tick();
  assert.equal(calls, 2);
  observer.dispose();
});

test("disposal prevents follow-up refreshes and an all-error batch makes no request", async () => {
  let finish!: () => void;
  let calls = 0;
  const observer = createUploadBatchRefresh(async () => {
    calls++;
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  observer.update([task("a", "error")]);
  assert.equal(calls, 0);
  observer.update([task("a", "complete")]);
  observer.update([task("a", "complete"), task("b", "complete")]);
  observer.dispose();
  finish();
  await tick();
  observer.update([task("c", "complete")]);
  assert.equal(calls, 1);
});
