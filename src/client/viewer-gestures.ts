export interface ViewerGestureOptions {
  onPrevious(): void;
  onNext(): void;
  onZoomChange?: (zoomed: boolean) => void;
}

export interface ViewerGestures {
  toggleZoom(): void;
  panBy(dx: number, dy: number): void;
  reset(): void;
  dispose(): void;
}

interface Point {
  x: number;
  y: number;
}

interface PointerPoint extends Point {
  id: number;
  startedAt: number;
  originX: number;
  originY: number;
}

const MIN_SWIPE = 52;
const MAX_SWIPE_DURATION = 700;
const MAX_SCALE = 4;

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Attach swipe, pan and pinch gestures to a viewer's image surface. */
export function createViewerGestures(
  surface: HTMLElement,
  image: () => HTMLImageElement | null,
  options: ViewerGestureOptions,
): ViewerGestures {
  const pointers = new Map<number, PointerPoint>();
  const view = surface.ownerDocument.defaultView;
  let scale = 1;
  let x = 0;
  let y = 0;
  let pinching = false;
  let moved = false;
  let pinchDistance = 0;
  let pinchScale = 1;
  let pinchImagePoint: Point = { x: 0, y: 0 };
  let panOrigin: Point = { x: 0, y: 0 };
  let activeImage: HTMLImageElement | null = null;
  let originalDraggable = true;
  let originalTransform = "";
  let originalTransformOrigin = "";

  const getImageSize = (target: HTMLImageElement) => ({
    width: target.offsetWidth || target.getBoundingClientRect().width,
    height: target.offsetHeight || target.getBoundingClientRect().height,
  });

  const switchImage = () => {
    const next = image();
    if (next === activeImage) return next;
    if (activeImage) {
      activeImage.style.transform = originalTransform;
      activeImage.style.transformOrigin = originalTransformOrigin;
      activeImage.draggable = originalDraggable;
    }
    activeImage = next;
    if (activeImage) {
      originalTransform = activeImage.style.transform;
      originalTransformOrigin = activeImage.style.transformOrigin;
      originalDraggable = activeImage.draggable;
      activeImage.draggable = false;
    }
    scale = 1;
    x = 0;
    y = 0;
    return next;
  };

  const clampPan = (target: HTMLImageElement) => {
    const bounds = surface.getBoundingClientRect();
    const size = getImageSize(target);
    const maxX = Math.max(0, (size.width * scale - bounds.width) / 2);
    const maxY = Math.max(0, (size.height * scale - bounds.height) / 2);
    x = Math.max(-maxX, Math.min(maxX, x));
    y = Math.max(-maxY, Math.min(maxY, y));
  };

  const paint = () => {
    const target = switchImage();
    if (!target) return;
    clampPan(target);
    target.style.transformOrigin = "center center";
    target.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };

  const setScale = (next: number, focal?: Point) => {
    const target = switchImage();
    if (!target) return;
    const bounds = surface.getBoundingClientRect();
    const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    const nextScale = Math.max(1, Math.min(MAX_SCALE, next));
    const focus = focal ?? center;
    const imagePoint = {
      x: (focus.x - center.x - x) / scale,
      y: (focus.y - center.y - y) / scale,
    };
    x = focus.x - center.x - imagePoint.x * nextScale;
    y = focus.y - center.y - imagePoint.y * nextScale;
    scale = nextScale;
    paint();
    options.onZoomChange?.(scale > 1);
  };

  const reset = () => {
    switchImage();
    scale = 1;
    x = 0;
    y = 0;
    pointers.clear();
    pinching = false;
    moved = false;
    if (activeImage) {
      activeImage.style.transform = originalTransform;
      activeImage.style.transformOrigin = originalTransformOrigin;
    }
    options.onZoomChange?.(false);
  };

  const toggleZoom = () => {
    setScale(scale > 1 ? 1 : 2);
  };

  const panBy = (dx: number, dy: number) => {
    const target = switchImage();
    if (!target || scale <= 1) return;
    x += dx;
    y += dy;
    paint();
  };

  const beginPinch = () => {
    const pair = [...pointers.values()];
    if (pair.length < 2) return;
    const target = switchImage();
    if (!target) return;
    pinching = true;
    moved = true;
    pinchDistance = Math.max(1, distance(pair[0]!, pair[1]!));
    pinchScale = scale;
    const pinchOrigin = midpoint(pair[0]!, pair[1]!);
    const bounds = surface.getBoundingClientRect();
    const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    pinchImagePoint = {
      x: (pinchOrigin.x - center.x - x) / scale,
      y: (pinchOrigin.y - center.y - y) / scale,
    };
  };

  const ignoreTarget = (target: EventTarget | null) =>
    typeof Element !== "undefined" && target instanceof Element &&
      !!target.closest("button, a, input, select, textarea, [role=button]");

  const onPointerDown = (event: PointerEvent) => {
    if (ignoreTarget(event.target) || (event.pointerType === "mouse" && !event.isPrimary)) return;
    if (pointers.has(event.pointerId) || pointers.size >= 2) return;
    const point: PointerPoint = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: event.clientX,
      originY: event.clientY,
      startedAt: Date.now(),
    };
    pointers.set(event.pointerId, point);
    if (pointers.size === 1) {
      moved = false;
      panOrigin = { x, y };
    } else if (pointers.size === 2) {
      beginPinch();
    }
    surface.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    if (pointers.size >= 2 && pinching) {
      const pair = [...pointers.values()];
      const currentDistance = Math.max(1, distance(pair[0]!, pair[1]!));
      const nextScale = Math.max(1, Math.min(MAX_SCALE, pinchScale * currentDistance / pinchDistance));
      const focus = midpoint(pair[0]!, pair[1]!);
      const bounds = surface.getBoundingClientRect();
      const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      scale = nextScale;
      x = focus.x - center.x - pinchImagePoint.x * scale;
      y = focus.y - center.y - pinchImagePoint.y * scale;
      paint();
      options.onZoomChange?.(scale > 1);
      event.preventDefault();
      return;
    }
    if (scale > 1) {
      x = panOrigin.x + point.x - point.originX;
      y = panOrigin.y + point.y - point.originY;
      paint();
      event.preventDefault();
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    const wasPinching = pinching;
    const hadMultiple = pointers.size > 1;
    pointers.delete(event.pointerId);
    surface.releasePointerCapture?.(event.pointerId);
    if (hadMultiple || wasPinching) {
      pinching = pointers.size >= 2;
      moved = true;
      if (pointers.size === 1) {
        const remaining = [...pointers.values()][0]!;
        remaining.originX = remaining.x;
        remaining.originY = remaining.y;
        panOrigin = { x, y };
      }
      return;
    }
    if (scale > 1) return;
    const dx = point.x - point.originX;
    const dy = point.y - point.originY;
    const duration = Date.now() - point.startedAt;
    if (!moved && duration <= MAX_SWIPE_DURATION && Math.abs(dx) >= MIN_SWIPE && Math.abs(dx) >= Math.abs(dy) * 1.3) {
      if (dx < 0) options.onNext();
      else options.onPrevious();
    }
    moved = false;
  };

  const onPointerCancel = () => {
    pointers.clear();
    pinching = false;
    moved = false;
  };

  const onDoubleClick = (event: MouseEvent) => {
    if (ignoreTarget(event.target)) return;
    event.preventDefault();
    toggleZoom();
  };

  const onResize = () => paint();

  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerup", onPointerUp);
  surface.addEventListener("pointercancel", onPointerCancel);
  surface.addEventListener("dblclick", onDoubleClick);
  view?.addEventListener("resize", onResize);

  return {
    toggleZoom,
    panBy,
    reset,
    dispose() {
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerCancel);
      surface.removeEventListener("dblclick", onDoubleClick);
      view?.removeEventListener("resize", onResize);
      if (activeImage) {
        activeImage.style.transform = originalTransform;
        activeImage.style.transformOrigin = originalTransformOrigin;
        activeImage.draggable = originalDraggable;
      }
    },
  };
}
