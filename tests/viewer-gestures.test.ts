import { describe, expect, test } from "bun:test";
import { createViewerGestures } from "../src/client/viewer-gestures";

class FakeSurface {
  readonly ownerDocument = { defaultView: null };
  readonly listeners = new Map<string, EventListener[]>();
  readonly captures: number[] = [];
  readonly released: number[] = [];

  constructor(readonly width = 300, readonly height = 200) {}

  addEventListener(type: string, listener: EventListener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height } as DOMRect;
  }
  setPointerCapture(id: number) { this.captures.push(id); }
  releasePointerCapture(id: number) { this.released.push(id); }
  dispatch(type: string, event: object) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as unknown as Event);
  }
}

const makePointer = (input: Partial<PointerEvent> & Pick<PointerEvent, "pointerId" | "clientX" | "clientY">) => ({
  pointerType: "touch",
  isPrimary: true,
  target: null,
  preventDefault() {},
  ...input,
}) as PointerEvent;

function fixture() {
  const surface = new FakeSurface();
  const img = {
    offsetWidth: 300,
    offsetHeight: 200,
    draggable: true,
    style: { transform: "", transformOrigin: "" },
    getBoundingClientRect: () => ({ width: 300, height: 200 }) as DOMRect,
  } as unknown as HTMLImageElement;
  const calls = { previous: 0, next: 0, zoom: [] as boolean[] };
  const gestures = createViewerGestures(surface as unknown as HTMLElement, () => img, {
    onPrevious: () => calls.previous++,
    onNext: () => calls.next++,
    onZoomChange: (zoomed) => calls.zoom.push(zoomed),
  });
  const down = (id: number, x: number, y: number) => surface.dispatch("pointerdown", makePointer({ pointerId: id, clientX: x, clientY: y }));
  const move = (id: number, x: number, y: number) => surface.dispatch("pointermove", makePointer({ pointerId: id, clientX: x, clientY: y }));
  const up = (id: number, x: number, y: number) => surface.dispatch("pointerup", makePointer({ pointerId: id, clientX: x, clientY: y }));
  return { surface, img, calls, gestures, down, move, up };
}

describe("viewer gestures", () => {
  test("swipes in either direction to navigate and ignores vertical drags", () => {
    const f = fixture();
    f.down(1, 250, 90);
    f.move(1, 170, 94);
    f.up(1, 170, 94);
    f.down(2, 50, 90);
    f.move(2, 130, 96);
    f.up(2, 130, 96);
    f.down(3, 140, 150);
    f.move(3, 80, 80);
    f.up(3, 80, 80);

    expect(f.calls).toEqual({ previous: 1, next: 1, zoom: [] });
    f.gestures.dispose();
  });

  test("zooms on request and bounds image panning", () => {
    const f = fixture();
    f.gestures.toggleZoom();
    expect(f.img.style.transform).toBe("translate(0px, 0px) scale(2)");
    f.down(1, 120, 80);
    f.move(1, 1000, 80);
    expect(f.img.style.transform).toBe("translate(150px, 0px) scale(2)");
    f.up(1, 1000, 80);
    f.gestures.toggleZoom();
    expect(f.img.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(f.calls.zoom).toEqual([true, false]);
    f.gestures.dispose();
  });

  test("double click toggles zoom", () => {
    const f = fixture();
    const event = { target: null, preventDefault() {} } as MouseEvent;
    f.surface.dispatch("dblclick", event);
    expect(f.img.style.transform).toBe("translate(0px, 0px) scale(2)");
    f.surface.dispatch("dblclick", event);
    expect(f.img.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(f.calls.zoom).toEqual([true, false]);
    f.gestures.dispose();
  });

  test("panBy supports keyboard movement and still clamps at image bounds", () => {
    const f = fixture();
    f.gestures.panBy(64, 0);
    expect(f.img.style.transform).toBe("");
    f.gestures.toggleZoom();
    f.gestures.panBy(64, -32);
    expect(f.img.style.transform).toBe("translate(64px, -32px) scale(2)");
    f.gestures.panBy(10_000, -10_000);
    expect(f.img.style.transform).toBe("translate(150px, -100px) scale(2)");
    f.gestures.dispose();
  });

  test("pinch scales around its center and a cancelled pointer cannot swipe", () => {
    const f = fixture();
    f.down(1, 100, 100);
    f.down(2, 200, 100);
    f.move(2, 300, 100);
    expect(f.img.style.transform).toBe("translate(50px, 0px) scale(2)");
    f.up(1, 100, 100);
    f.move(2, 340, 100);
    expect(f.img.style.transform).toBe("translate(90px, 0px) scale(2)");
    f.surface.dispatch("pointercancel", makePointer({ pointerId: 2, clientX: 340, clientY: 100 }));
    expect(f.calls.next).toBe(0);
    expect(f.calls.previous).toBe(0);
    f.gestures.reset();
    expect(f.img.style.transform).toBe("");
    expect(f.calls.zoom.at(-1)).toBe(false);
    f.gestures.dispose();
  });

  test("disposal removes listeners and restores existing image transforms", () => {
    const f = fixture();
    f.img.style.transform = "rotate(2deg)";
    f.img.style.transformOrigin = "top left";
    // The image is first claimed when a gesture changes its scale.
    f.gestures.toggleZoom();
    expect(f.img.draggable).toBe(false);
    f.gestures.dispose();
    expect(f.img.style.transform).toBe("rotate(2deg)");
    expect(f.img.style.transformOrigin).toBe("top left");
    expect(f.img.draggable).toBe(true);
    expect([...f.surface.listeners.values()].every((listeners) => listeners.length === 0)).toBe(true);
  });
});
