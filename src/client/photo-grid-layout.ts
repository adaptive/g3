export interface PhotoGridWindow {
  start: number;
  end: number;
}

export function photoGridColumnCount(value: string): number {
  const columns = Number.parseInt(value, 10);
  return Number.isInteger(columns) && columns >= 1 && columns <= 6 ? columns : 3;
}

export function photoGridWindow(args: {
  itemCount: number;
  columns: number;
  rowHeight: number;
  rowGap: number;
  gridTop: number;
  scrollY: number;
  viewportHeight: number;
  overscanRows?: number;
}): PhotoGridWindow {
  const columns = Math.max(1, Math.floor(args.columns));
  const rows = Math.ceil(args.itemCount / columns);
  if (!rows) return { start: 0, end: 0 };

  const stride = Math.max(1, args.rowHeight + args.rowGap);
  const overscan = Math.max(1, Math.floor(args.overscanRows ?? 4));
  const firstVisible = Math.floor(Math.max(0, args.scrollY - args.gridTop) / stride);
  const lastVisible = Math.ceil(
    Math.max(0, args.scrollY + args.viewportHeight - args.gridTop) / stride,
  );
  let start = Math.max(0, Math.min(rows - 1, firstVisible - overscan));
  let end = Math.max(start + 1, Math.min(rows, lastVisible + overscan));

  return { start, end };
}

export function photoGridVisibleRows(window: PhotoGridWindow, pinnedRow?: number): number[] {
  const rows = Array.from({ length: Math.max(0, window.end - window.start) },
    (_, index) => window.start + index);
  if (pinnedRow !== undefined && pinnedRow >= 0 && !rows.includes(pinnedRow)) {
    rows.push(pinnedRow);
    rows.sort((left, right) => left - right);
  }
  return rows;
}

