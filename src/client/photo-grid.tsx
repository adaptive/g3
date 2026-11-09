import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";
import type { Photo } from "../shared/types";
import {
  photoGridColumnCount,
  photoGridVisibleRows,
  photoGridWindow,
} from "./photo-grid-layout";

const VIRTUALIZE_AFTER = 144;
const OVERSCAN_ROWS = 5;
const INITIAL_ROWS = 12;

export interface PhotoGridHandle {
  /** Scroll the photo into view and return keyboard focus to its open button. */
  focusPhoto(photoId: string): void;
}

export interface PhotoGridProps<T extends Photo> {
  items: T[];
  children: (item: T, index: Accessor<number>) => JSX.Element;
  ref?: (handle: PhotoGridHandle) => void;
}

/** Renders a normal small grid and bounds DOM for large, already-paginated galleries. */
export function PhotoGrid<T extends Photo>(props: PhotoGridProps<T>) {
  let grid: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let animationFrame = 0;
  let scrollFrame = 0;
  let focusFrames: number[] = [];
  let focusRestoreFrame = 0;
  let focusRevision = 0;
  let preservedFocus: HTMLElement | null = null;
  let disposed = false;
  let observedWidth = 0;
  let rowGap = 34;
  const [columns, setColumns] = createSignal(3);
  const [showAll, setShowAll] = createSignal(false);
  const [range, setRange] = createSignal({ start: 0, end: INITIAL_ROWS });
  const [rowHeight, setRowHeight] = createSignal(290);
  const [focusedIndex, setFocusedIndex] = createSignal<number>();

  const virtualized = () => props.items.length > VIRTUALIZE_AFTER && !showAll();
  const rowCount = () => Math.ceil(props.items.length / Math.max(1, columns()));
  const stride = () => Math.max(1, rowHeight() + rowGap);
  const focusedRow = () => {
    const index = focusedIndex();
    return index === undefined ? undefined : Math.floor(index / Math.max(1, columns()));
  };
  const visibleRows = createMemo(() =>
    photoGridVisibleRows(range(), focusedRow()),
  );
  // Return the original Photo objects to Solid's <For>; it reuses DOM when an
  // item stays in the window as rows above it are added or removed.
  const visiblePhotos = createMemo<T[]>(() => {
    const result: T[] = [];
    const count = Math.max(1, columns());
    for (const row of visibleRows()) {
      const start = row * count;
      const end = Math.min(props.items.length, start + count);
      for (let index = start; index < end; index++) result.push(props.items[index]);
    }
    return result;
  });
  const itemIndexes = createMemo(() =>
    new Map(props.items.map((photo, index) => [photo.id, index])),
  );

  const cancelFocusPreservation = () => {
    focusRevision++;
    preservedFocus = null;
    if (focusRestoreFrame) cancelAnimationFrame(focusRestoreFrame);
    focusRestoreFrame = 0;
  };

  /** Keep the active photo control stable across keyed-list row reconciliation. */
  const preserveFocusAcrossMutation = (mutation: () => void) => {
    const active = document.activeElement instanceof HTMLElement &&
      grid?.contains(document.activeElement)
      ? document.activeElement
      : null;
    if (!active) {
      mutation();
      return;
    }

    preservedFocus = active;
    const revision = ++focusRevision;
    mutation();
    if (focusRestoreFrame) cancelAnimationFrame(focusRestoreFrame);
    const restore = (allowFrameFallback: boolean) => {
      if (revision !== focusRevision) return;
      const target = preservedFocus;
      // Restore only when reconciliation dropped focus to the document. An
      // actual Tab or click to another control must keep its newly focused node.
      if (!target || !document.hasFocus()) {
        preservedFocus = null;
        return;
      }
      if (document.activeElement === target) {
        preservedFocus = null;
        return;
      }
      const focusWasDropped = document.activeElement === document.body ||
        document.activeElement === document.documentElement;
      if (!focusWasDropped) {
        preservedFocus = null;
        return;
      }
      if (grid?.contains(target)) {
        preservedFocus = null;
        target.focus({ preventScroll: true });
      } else if (allowFrameFallback) {
        focusRestoreFrame = requestAnimationFrame(() => {
          focusRestoreFrame = 0;
          restore(false);
        });
      } else preservedFocus = null;
    };
    // Solid updates the keyed list synchronously; restore immediately after its
    // reconciliation, with one frame for browsers that defer the DOM move.
    queueMicrotask(() => restore(true));
  };

  const handleOutsidePointerDown = (event: PointerEvent) => {
    if (grid?.contains(event.target as Node)) return;
    cancelFocusPreservation();
    setFocusedIndex(undefined);
  };
  const handleWindowBlur = () => {
    cancelFocusPreservation();
    setFocusedIndex(undefined);
  };

  const estimateRowHeight = () => {
    if (!grid) return;
    const width = grid.clientWidth;
    const count = Math.max(1, columns());
    const columnGap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
    const cardWidth = Math.max(1, (width - columnGap * (count - 1)) / count);
    // Cards have a 4:3 image and a short filename/action row.
    const height = Math.ceil(cardWidth * 0.75 + 58);
    setRowHeight(height);
    grid.style.setProperty("--photo-grid-row-height", `${height}px`);
  };

  const measureColumns = () => {
    if (!grid) return;
    const style = getComputedStyle(grid);
    rowGap = Number.parseFloat(style.rowGap) || 0;
    preserveFocusAcrossMutation(() => {
      setColumns(photoGridColumnCount(style.getPropertyValue("--photo-grid-columns")));
    });
  };

  const sampleRowHeight = () => {
    if (!grid || !virtualized()) return;
    const cards = grid.querySelectorAll<HTMLElement>(".photo-grid-card");
    let tallest = 0;
    for (const card of cards) {
      const image = card.querySelector<HTMLElement>(".photo-open");
      const info = card.querySelector<HTMLElement>(".photo-info");
      const naturalHeight = (image?.getBoundingClientRect().height ?? 0) +
        (info?.getBoundingClientRect().height ?? 0);
      tallest = Math.max(tallest, naturalHeight);
    }
    if (tallest > 0 && Math.abs(tallest - rowHeight()) > 1) {
      const height = Math.ceil(tallest);
      setRowHeight(height);
      grid.style.setProperty("--photo-grid-row-height", `${height}px`);
      scheduleWindow();
    }
  };

  const updateWindow = () => {
    if (!grid || !virtualized()) return;
    const style = getComputedStyle(grid);
    rowGap = Number.parseFloat(style.rowGap) || 0;
    preserveFocusAcrossMutation(() => {
      setColumns(photoGridColumnCount(style.getPropertyValue("--photo-grid-columns")));

      const top = grid.getBoundingClientRect().top + window.scrollY;
      const next = photoGridWindow({
        itemCount: props.items.length,
        columns: columns(),
        rowHeight: rowHeight(),
        rowGap,
        gridTop: top,
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
        overscanRows: OVERSCAN_ROWS,
      });
      setRange((current) =>
        current.start === next.start && current.end === next.end ? current : next,
      );
    });
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(sampleRowHeight);
  };

  const scheduleWindow = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateWindow();
    });
  };

  function focusButton(photoId: string) {
    if (!grid) return;
    for (const card of grid.querySelectorAll<HTMLElement>("[data-photo-id]")) {
      if (card.dataset.photoId !== photoId) continue;
      card.querySelector<HTMLElement>("[data-photo-open]")?.focus({ preventScroll: true });
      return;
    }
  }

  const handle: PhotoGridHandle = {
    focusPhoto(photoId) {
      if (disposed || !grid?.isConnected) return;
      const index = props.items.findIndex((photo) => photo.id === photoId);
      if (index < 0) return;
      if (!virtualized()) {
        focusFrames.push(requestAnimationFrame(() => {
          if (!disposed) focusButton(photoId);
        }));
        return;
      }

      const row = Math.floor(index / Math.max(1, columns()));
      setRange({
        start: Math.max(0, row - 1),
        end: Math.min(rowCount(), row + INITIAL_ROWS - 1),
      });
      setFocusedIndex(index);
      const targetTop = (grid?.getBoundingClientRect().top ?? 0) + window.scrollY + row * stride();
      window.scrollTo({
        top: Math.max(0, targetTop - window.innerHeight * 0.28),
        behavior: "instant",
      });
      focusFrames.push(requestAnimationFrame(() => {
        if (disposed || !grid?.isConnected) return;
        focusFrames.push(requestAnimationFrame(() => {
          if (disposed || !grid?.isConnected) return;
        focusButton(photoId);
        scheduleWindow();
        }));
      }));
    },
  };
  props.ref?.(handle);

  onMount(() => {
    measureColumns();
    estimateRowHeight();
    updateWindow();
    observedWidth = grid?.getBoundingClientRect().width ?? 0;
    resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - observedWidth) < 1) return;
      observedWidth = width;
      measureColumns();
      estimateRowHeight();
      scheduleWindow();
    });
    if (grid) resizeObserver.observe(grid);
    window.addEventListener("scroll", scheduleWindow, { passive: true });
    window.addEventListener("resize", scheduleWindow, { passive: true });
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    window.addEventListener("blur", handleWindowBlur);
  });

  // Load-more appends pages without changing the scroll/resize listeners.
  createEffect(() => {
    props.items.length;
    if (virtualized()) scheduleWindow();
  });

  onCleanup(() => {
    disposed = true;
    resizeObserver?.disconnect();
    window.removeEventListener("scroll", scheduleWindow);
    window.removeEventListener("resize", scheduleWindow);
    document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    window.removeEventListener("blur", handleWindowBlur);
    cancelFocusPreservation();
    cancelAnimationFrame(animationFrame);
    cancelAnimationFrame(scrollFrame);
    for (const frame of focusFrames) cancelAnimationFrame(frame);
  });

  return (
    <>
      <Show when={virtualized()}>
        <div class="photo-grid-window-controls">
          <span>
            Showing {Math.min(props.items.length, range().start * columns() + 1)}–
            {Math.min(props.items.length, range().end * columns())} of {props.items.length} loaded photographs
          </span>
          <button
            type="button"
            class="button button-outline"
            onClick={() => {
              const focusedId = props.items[range().start * columns()]?.id;
              setShowAll(true);
              if (focusedId) focusFrames.push(requestAnimationFrame(() => {
                if (!disposed) focusButton(focusedId);
              }));
            }}
          >
            Show all {props.items.length} loaded photographs
          </button>
        </div>
      </Show>
      <div
        ref={grid}
        class={`photo-grid${virtualized() ? " photo-grid--windowed" : ""}`}
        style={{
          "grid-template-rows": virtualized()
            ? `repeat(${rowCount()}, var(--photo-grid-row-height, 290px))`
            : undefined,
        }}
        aria-label={`Photographs, ${props.items.length} loaded`}
        onFocusIn={(event) => {
          const card = (event.target as HTMLElement).closest<HTMLElement>("[data-photo-id]");
          const index = props.items.findIndex((photo) => photo.id === card?.dataset.photoId);
          if (index < 0) return;
          const row = Math.floor(index / Math.max(1, columns()));
          const current = range();
          const updateRange = virtualized() &&
            (row >= current.end - 2 || row <= current.start + 1);
          if (focusedIndex() === index && !updateRange) return;
          preserveFocusAcrossMutation(() => {
            setFocusedIndex(index);
            if (updateRange) {
              setRange({
                start: Math.max(0, row - OVERSCAN_ROWS),
                end: Math.min(rowCount(), row + OVERSCAN_ROWS + 1),
              });
              animationFrame = requestAnimationFrame(sampleRowHeight);
            }
          });
        }}
        onFocusOut={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && !event.currentTarget.contains(next)) {
            cancelFocusPreservation();
            setFocusedIndex(undefined);
            return;
          }
          if (
            !next &&
            preservedFocus &&
            (event.target === preservedFocus || preservedFocus.contains(event.target as Node))
          ) return;
          if (!next) setFocusedIndex(undefined);
        }}
      >
        <Show
          when={virtualized()}
          fallback={
            <For each={props.items}>
              {(photo, index) => (
                <article class="photo-card" data-photo-id={photo.id}>
                  {props.children(photo, index)}
                </article>
              )}
            </For>
          }
        >
          <For each={visiblePhotos()}>
            {(photo) => {
              const index = () => itemIndexes().get(photo.id) ?? 0;
              const itemRow = () => Math.floor(index() / Math.max(1, columns()));
              return (
                <article
                  class="photo-card photo-grid-card"
                  data-photo-id={photo.id}
                  style={{
                    "grid-row": String(itemRow() + 1),
                    "grid-column": String((index() % Math.max(1, columns())) + 1),
                  }}
                >
                  {props.children(photo, index)}
                </article>
              );
            }}
          </For>
        </Show>
      </div>
    </>
  );
}

