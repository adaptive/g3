import assert from "node:assert/strict";
import { test } from "bun:test";
import { createPhotoVariantEncoder } from "../src/client/image-encoding";

function canvasHarness(
  encode: (type: string, width: number, height: number) => Blob | null = (type) => new Blob(["image"], { type }),
  html = false,
) {
  const calls: Array<{ type: string; width: number; height: number; quality?: number }> = [];
  const surfaces: Array<{ width: number; height: number }> = [];
  const draws: number[][] = [];
  const factory = (width: number, height: number) => {
    const surface = {
      width, height,
      getContext: () => ({ drawImage: (_bitmap: ImageBitmap, ...size: number[]) => draws.push(size) }),
    };
    surfaces.push(surface);
    const makeBlob = (type: string, quality?: number) => {
      calls.push({ type, width: surface.width, height: surface.height, quality });
      return encode(type, surface.width, surface.height);
    };
    return Object.assign(surface, html
      ? { toBlob: (callback: BlobCallback, type: string, quality?: number) => callback(makeBlob(type, quality)) }
      : { convertToBlob: async ({ type, quality }: ImageEncodeOptions) => makeBlob(type!, quality) });
  };
  const encoder = createPhotoVariantEncoder(factory as unknown as (width: number, height: number) => OffscreenCanvas);
  return { encoder, calls, surfaces, draws };
}

const bitmap = { width: 4000, height: 3000 } as ImageBitmap;

test("unsupported native AVIF is probed once and thumbnails are actual WebP at 640px", async () => {
  const { encoder, calls, surfaces, draws } = canvasHarness((type) =>
    new Blob(["encoded"], { type: type === "image/avif" ? "image/png" : type }));
  assert.equal((await encoder.encode(bitmap, "thumbnail")).type, "image/webp");
  assert.equal((await encoder.encode(bitmap, "thumbnail")).type, "image/webp");
  assert.deepEqual(calls.map(({ type, width, height }) => [type, width, height]), [
    ["image/avif", 1, 1], ["image/webp", 1, 1],
    ["image/webp", 640, 480], ["image/webp", 640, 480],
  ]);
  assert.deepEqual(draws, [[0, 0, 640, 480], [0, 0, 640, 480]]);
  assert.ok(surfaces.every((surface) => surface.width === 1 && surface.height === 1));
});

test("native AVIF is used when the encoder actually returns AVIF", async () => {
  const { encoder, calls } = canvasHarness();
  assert.equal((await encoder.encode(bitmap, "thumbnail")).type, "image/avif");
  assert.deepEqual(calls.map(({ type }) => type), ["image/avif", "image/avif"]);
});

test("a failed full-sized encoder falls through to JPEG without relabeling PNG bytes", async () => {
  const { encoder, calls } = canvasHarness((type, width) => {
    if (type === "image/avif") return new Blob(["png"], { type: "image/png" });
    if (type === "image/webp" && width > 1) throw new Error("Encoder failed");
    return new Blob(["encoded"], { type });
  });
  assert.equal((await encoder.encode(bitmap, "thumbnail")).type, "image/jpeg");
  await encoder.encode(bitmap, "thumbnail");
  assert.equal(calls.filter(({ type }) => type === "image/webp").length, 2);
  assert.equal(calls.filter(({ type }) => type === "image/avif").length, 1);
});

test("window canvas fallback uses the same codec checks and does not upscale small photos", async () => {
  const { encoder, draws } = canvasHarness((type) => new Blob(["encoded"], {
    type: type === "image/avif" ? "image/png" : type,
  }), true);
  assert.equal((await encoder.encode({ width: 100, height: 50 } as ImageBitmap, "thumbnail")).type, "image/webp");
  assert.deepEqual(draws, [[0, 0, 100, 50]]);
});

test("preview stays JPEG at 2560px and releases canvas on encoding failure", async () => {
  const { encoder, calls, draws, surfaces } = canvasHarness();
  assert.equal((await encoder.encode(bitmap, "preview")).type, "image/jpeg");
  assert.deepEqual(calls, [{ type: "image/jpeg", width: 2560, height: 1920, quality: 0.82 }]);
  assert.deepEqual(draws, [[0, 0, 2560, 1920]]);
  assert.ok(surfaces.every((surface) => surface.width === 1 && surface.height === 1));
  const failure = canvasHarness(() => new Blob(["png"], { type: "image/png" }));
  await assert.rejects(failure.encoder.encode(bitmap, "preview"), /as JPEG/);
  assert.ok(failure.surfaces.every((surface) => surface.width === 1 && surface.height === 1));
});
