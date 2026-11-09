import assert from "node:assert/strict";
import { test } from "bun:test";
import { PHOTO_VARIANT_SETTINGS } from "../src/client/image";
import {
  createImageWorkerRunner,
  type ImageWorkerPort,
  type ImageWorkerRequest,
  type ImageWorkerResponse,
} from "../src/client/image-worker-client";

class FakeWorker implements ImageWorkerPort {
  sent: ImageWorkerRequest[] = [];
  terminated = false;
  messages = new Set<(event: MessageEvent<ImageWorkerResponse>) => void>();
  errors = new Set<(event: ErrorEvent) => void>();

  postMessage(message: ImageWorkerRequest) {
    this.sent.push(message);
  }

  addEventListener(type: "message", listener: (event: MessageEvent<ImageWorkerResponse>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "message" | "error", listener: ((event: MessageEvent<ImageWorkerResponse>) => void) | ((event: ErrorEvent) => void)) {
    if (type === "message") this.messages.add(listener as (event: MessageEvent<ImageWorkerResponse>) => void);
    else this.errors.add(listener as (event: ErrorEvent) => void);
  }

  removeEventListener(type: "message", listener: (event: MessageEvent<ImageWorkerResponse>) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "message" | "error", listener: ((event: MessageEvent<ImageWorkerResponse>) => void) | ((event: ErrorEvent) => void)) {
    if (type === "message") this.messages.delete(listener as (event: MessageEvent<ImageWorkerResponse>) => void);
    else this.errors.delete(listener as (event: ErrorEvent) => void);
  }

  terminate() {
    this.terminated = true;
  }

  reply(data: ImageWorkerResponse) {
    const event = { data } as MessageEvent<ImageWorkerResponse>;
    for (const listener of this.messages) listener(event);
  }
}

test("worker returns preview and thumbnail blobs while reusing one worker", async () => {
  const worker = new FakeWorker();
  let creations = 0;
  const runner = createImageWorkerRunner(() => {
    creations += 1;
    return worker;
  });
  const source = new Blob(["original pixels"]);
  const pending = runner.process(source);
  assert.equal(worker.sent.length, 1);
  assert.equal(worker.sent[0].blob, source);

  const preview = new Blob(["preview"], { type: "image/jpeg" });
  const thumbnail = new Blob(["thumbnail"], { type: "image/jpeg" });
  worker.reply({
    type: "success",
    requestId: worker.sent[0].requestId,
    preview,
    thumbnail,
    width: 3200,
    height: 2400,
  });
  assert.deepEqual(await pending, {
    type: "success",
    result: { preview, thumbnail, width: 3200, height: 2400 },
  });

  const next = runner.process(source);
  worker.reply({
    type: "fallback",
    requestId: worker.sent[1].requestId,
    reason: "OffscreenCanvas unavailable",
  });
  assert.deepEqual(await next, {
    type: "fallback",
    reason: "OffscreenCanvas unavailable",
  });
  assert.equal(creations, 1);
  runner.dispose();
  assert.equal(worker.terminated, true);
});

test("cancel aborts the active job and terminates its worker", async () => {
  const worker = new FakeWorker();
  const runner = createImageWorkerRunner(() => worker);
  const controller = new AbortController();
  const pending = runner.process(new Blob(["image"]), controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(worker.terminated, true);
});

test("worker errors fall back to the window image path", async () => {
  const worker = new FakeWorker();
  const runner = createImageWorkerRunner(() => worker);
  const pending = runner.process(new Blob(["image"]));
  for (const listener of worker.errors)
    listener({ message: "Worker module could not be loaded." } as ErrorEvent);
  assert.deepEqual(await pending, {
    type: "fallback",
    reason: "Worker module could not be loaded.",
  });
  assert.equal(worker.terminated, true);
  assert.equal((await runner.process(new Blob(["another image"]))).type, "fallback");
  assert.equal(worker.sent.length, 1, "an unavailable worker should not be retried for every photo");
});

test("missing worker canvas support falls back for the whole queue and releases the worker", async () => {
  const worker = new FakeWorker();
  const runner = createImageWorkerRunner(() => worker);
  const pending = runner.process(new Blob(["image"]));
  worker.reply({ type: "fallback", requestId: worker.sent[0].requestId, reason: "No worker canvas" });
  assert.deepEqual(await pending, { type: "fallback", reason: "No worker canvas" });
  assert.equal(worker.terminated, true);
  assert.deepEqual(await runner.process(new Blob(["next image"])), { type: "fallback", reason: "No worker canvas" });
  assert.equal(worker.sent.length, 1);
});

test("cancelling a photo allows a fresh worker to process the next attempt", async () => {
  const workers: FakeWorker[] = [];
  const runner = createImageWorkerRunner(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const first = runner.process(new Blob(["first"]));
  runner.cancelActive();
  await assert.rejects(first, { name: "AbortError" });
  const second = runner.process(new Blob(["second"]));
  workers[1].reply({
    type: "success", requestId: workers[1].sent[0].requestId,
    preview: new Blob(), thumbnail: new Blob(), width: 10, height: 10,
  });
  assert.equal((await second).type, "success");
  assert.equal(workers.length, 2);
  runner.dispose();
});

test("image variants use lower preview quality while preserving their existing sizes", () => {
  assert.deepEqual(PHOTO_VARIANT_SETTINGS, {
    preview: { maxEdge: 2560, quality: 0.82 },
    thumbnail: { maxEdge: 640, quality: 0.78 },
  });
});
