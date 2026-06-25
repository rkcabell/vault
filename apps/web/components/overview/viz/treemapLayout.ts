// Squarified treemap layout (Bruls, Huizing & van Wijk), extracted so both the
// per-file storage treemap (VizTreemap) and the per-category storage graph
// (VizCategoryTreemap) share one gapless layout implementation.
//
// Each item's area is proportional to its (already-dampened) weight; rows are
// committed greedily to keep aspect ratios close to square, filling the bounds
// completely with no gaps.

export interface Bounds { x: number; y: number; w: number; h: number }

// --- Tile weighting --------------------------------------------------------
// A squarified treemap subdivides the container with ZERO gaps. To stop a few
// huge items from dominating (and reducing the rest to slivers), each tile's
// AREA can be a dampened function of its weight: area ∝ weight^exp, with a floor
// so the smallest tiles stay visible. exp=1 keeps true proportions.
export function tileWeights(weights: number[], sizeAreaExp: number, minAreaFrac: number): number[] {
  const raw = weights.map(w => Math.pow(Math.max(w, 1), sizeAreaExp));
  // reduce, not Math.max(...raw): the spread overflows the stack on large arrays.
  const max   = raw.reduce((m, w) => (w > m ? w : m), 0);
  const floor = max * minAreaFrac;
  return raw.map(w => Math.max(w, floor));
}

function worstRatio(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  if (sum === 0 || side === 0) return Infinity;
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

function layoutRow<T>(row: number[], items: T[], startIdx: number, bounds: Bounds, isH: boolean): Array<T & Bounds> {
  const total = row.reduce((a, b) => a + b, 0);
  const strip = isH ? total / bounds.h : total / bounds.w;
  let pos = 0;
  return row.map((area, i) => {
    const item = items[startIdx + i]!;
    const frac = area / total;
    const node: T & Bounds = isH
      ? { ...item, x: bounds.x, y: bounds.y + pos, w: strip, h: frac * bounds.h }
      : { ...item, x: bounds.x + pos, y: bounds.y, w: frac * bounds.w, h: strip };
    pos += isH ? frac * bounds.h : frac * bounds.w;
    return node;
  });
}

/** Lay items out as a gapless squarified treemap. `weights` drives tile area
 *  and must be the same length as `items` (use `tileWeights` to dampen/floor). */
export function squarifyLayout<T>(items: T[], weights: number[], bounds: Bounds): Array<T & Bounds> {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ ...items[0]!, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }];

  const totalArea   = bounds.w * bounds.h;
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const normalized  = weights.map(w => (w / totalWeight) * totalArea);
  const result: Array<T & Bounds> = [];

  function layout(normed: number[], startIdx: number, rect: Bounds) {
    if (normed.length === 0) return;
    if (normed.length === 1) {
      result.push({ ...items[startIdx]!, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      return;
    }
    const isH  = rect.w >= rect.h;
    const side = isH ? rect.h : rect.w;
    let row: number[] = [];
    let rowStart = 0;

    for (let i = 0; i < normed.length; i++) {
      const candidate = [...row, normed[i]!];
      if (row.length === 0 || worstRatio(candidate, side) <= worstRatio(row, side)) {
        row = candidate;
      } else {
        result.push(...layoutRow(row, items, startIdx + rowStart, rect, isH));
        const rowTotal = row.reduce((a, b) => a + b, 0);
        const strip    = isH ? rowTotal / rect.h : rowTotal / rect.w;
        const newRect: Bounds = isH
          ? { x: rect.x + strip, y: rect.y, w: rect.w - strip, h: rect.h }
          : { x: rect.x, y: rect.y + strip, w: rect.w, h: rect.h - strip };
        rowStart += row.length;
        layout(normed.slice(i), startIdx + i, newRect);
        return;
      }
    }
    if (row.length > 0) result.push(...layoutRow(row, items, startIdx + rowStart, rect, isH));
  }

  layout(normalized, 0, bounds);
  return result;
}
