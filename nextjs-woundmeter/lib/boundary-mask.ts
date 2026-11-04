// Brush and eraser editing for a wound boundary. Edits are applied to a binary mask in canonical
// (rectified) pixels and turned back into one polygon; the server re-measures that polygon with
// the validated algorithm, so every figure shown comes from the server, never from this file.

export type Point = [number, number];
/** Inner measurement window: left, top, right (exclusive), bottom (exclusive). */
export type Bounds = [number, number, number, number];
export type BrushStamp = { x: number; y: number; radius: number; add: boolean };

/** A binary mask covering only `[left, top] … [left + width, top + height)` of the canonical image. */
export type Grid = { left: number; top: number; width: number; height: number; data: Uint8Array };

/** Even-odd scanline fill at pixel centres, like the server's polygon rasterisation. */
export function fillPolygon(grid: Grid, points: number[][]): void {
  if (points.length < 3) return;
  const { left, top, width, height, data } = grid;
  const crossings: number[] = [];
  for (let row = 0; row < height; row += 1) {
    const y = top + row + 0.5;
    crossings.length = 0;
    for (let i = 0; i < points.length; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - left - 0.5));
      const to = Math.min(width - 1, Math.floor(crossings[k + 1] - left - 0.5));
      for (let col = from; col <= to; col += 1) data[row * width + col] = 1;
    }
  }
}

export function stampDisc(grid: Grid, stamp: BrushStamp): void {
  const { left, top, width, height, data } = grid;
  const r = Math.max(0.5, stamp.radius);
  const r2 = r * r;
  const cx = stamp.x - left;
  const cy = stamp.y - top;
  for (let row = Math.max(0, Math.floor(cy - r)); row <= Math.min(height - 1, Math.ceil(cy + r)); row += 1) {
    const dy = row + 0.5 - cy;
    for (let col = Math.max(0, Math.floor(cx - r)); col <= Math.min(width - 1, Math.ceil(cx + r)); col += 1) {
      const dx = col + 0.5 - cx;
      if (dx * dx + dy * dy <= r2) data[row * width + col] = stamp.add ? 1 : 0;
    }
  }
}

/** Stamps spaced along a stroke so fast pointer moves leave no gaps. */
export function strokeStamps(path: Point[], radius: number, add: boolean): BrushStamp[] {
  const stamps: BrushStamp[] = [];
  const spacing = Math.max(1, radius / 3);
  path.forEach(([x, y], index) => {
    if (index === 0) {
      stamps.push({ x, y, radius, add });
      return;
    }
    const [px, py] = path[index - 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / spacing));
    for (let s = 1; s <= steps; s += 1) stamps.push({ x: px + ((x - px) * s) / steps, y: py + ((y - py) * s) / steps, radius, add });
  });
  return stamps;
}

/** Removes one-pixel bridges and spurs (opening, 3×3), which would make the traced outline touch itself. */
function open3x3(grid: Grid): Grid {
  const { width, height, data } = grid;
  const pass = (source: Uint8Array, keep: (count: number) => boolean) => {
    const out = new Uint8Array(source.length);
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const r = row + dy;
            const c = col + dx;
            if (r >= 0 && r < height && c >= 0 && c < width && source[r * width + c]) count += 1;
          }
        }
        out[row * width + col] = keep(count) ? 1 : 0;
      }
    }
    return out;
  };
  const eroded = pass(data, (count) => count === 9);
  return { ...grid, data: pass(eroded, (count) => count > 0) };
}

/** Largest 8-connected region and how many separate regions there were. */
export function largestRegion(grid: Grid): { grid: Grid; regions: number } {
  const { width, height, data } = grid;
  const labels = new Int32Array(data.length);
  const queue = new Int32Array(data.length);
  let regions = 0;
  let best = 0;
  let bestSize = 0;
  for (let start = 0; start < data.length; start += 1) {
    if (!data[start] || labels[start]) continue;
    regions += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = regions;
    while (head < tail) {
      const index = queue[head++];
      const row = Math.floor(index / width);
      const col = index - row * width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const r = row + dy;
          const c = col + dx;
          if (r < 0 || r >= height || c < 0 || c >= width) continue;
          const next = r * width + c;
          if (data[next] && !labels[next]) {
            labels[next] = regions;
            queue[tail++] = next;
          }
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      best = regions;
    }
  }
  const out = new Uint8Array(data.length);
  if (best) for (let i = 0; i < data.length; i += 1) out[i] = labels[i] === best ? 1 : 0;
  return { grid: { ...grid, data: out }, regions };
}

// Clockwise Moore neighbourhood, starting west.
const MOORE: Point[] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];

/** Outer boundary pixels of the (single) region, in canonical coordinates; holes are ignored. */
export function traceOuterBoundary(grid: Grid): Point[] {
  const { left, top, width, height, data } = grid;
  const at = (c: number, r: number) => c >= 0 && r >= 0 && c < width && r < height && data[r * width + c] === 1;
  let start = -1;
  for (let i = 0; i < data.length && start < 0; i += 1) if (data[i]) start = i;
  if (start < 0) return [];
  const sr = Math.floor(start / width);
  const sc = start - sr * width;
  type State = { c: number; r: number; from: number };
  // From pixel (c, r), whose empty neighbour in direction `from` we came past, turn clockwise to the next region pixel.
  const step = ({ c, r, from }: State): State | null => {
    for (let k = 1; k <= 8; k += 1) {
      const dir = (from + k) % 8;
      const nc = c + MOORE[dir][0];
      const nr = r + MOORE[dir][1];
      if (!at(nc, nr)) continue;
      const back = (dir + 7) % 8; // The empty neighbour checked just before, seen from the new pixel.
      const dx = MOORE[back][0] - MOORE[dir][0];
      const dy = MOORE[back][1] - MOORE[dir][1];
      return { c: nc, r: nr, from: MOORE.findIndex(([x, y]) => x === dx && y === dy) };
    }
    return null;
  };
  // The first pixel in scan order has an empty west neighbour.
  const first = step({ c: sc, r: sr, from: 0 });
  const path: Point[] = [[sc, sr]];
  if (!first) return path.map(([x, y]) => [x + left, y + top]);
  let state = first;
  // Jacob's stopping rule: finish when the trace is about to repeat its first move.
  for (let guard = 0; guard < data.length * 8; guard += 1) {
    if (state.c === sc && state.r === sr) {
      const next = step(state);
      if (!next || (next.c === first.c && next.r === first.r)) break;
      path.push([sc, sr]);
      state = next;
      continue;
    }
    path.push([state.c, state.r]);
    const next = step(state);
    if (!next) break;
    state = next;
  }
  return path.map(([x, y]) => [x + left, y + top]);
}

function perpendicular(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / length;
}

function simplifyChain(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  let index = 0;
  let max = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = perpendicular(points[i], points[0], points[points.length - 1]);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [points[0], points[points.length - 1]];
  const head = simplifyChain(points.slice(0, index + 1), epsilon);
  return [...head.slice(0, -1), ...simplifyChain(points.slice(index), epsilon)];
}

/** Douglas–Peucker for a closed outline; integer, distinct, consecutive-duplicate-free vertices. */
export function simplifyPolygon(points: number[][], epsilon = 1): Point[] {
  const ring = points.map(([x, y]) => [Math.round(x), Math.round(y)] as Point)
    .filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
  if (ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1]) ring.pop();
  if (ring.length < 4) return ring;
  let far = 0;
  let distance = -1;
  ring.forEach(([x, y], i) => {
    const d = Math.hypot(x - ring[0][0], y - ring[0][1]);
    if (d > distance) {
      distance = d;
      far = i;
    }
  });
  const first = simplifyChain(ring.slice(0, far + 1), epsilon);
  const second = simplifyChain([...ring.slice(far), ring[0]], epsilon);
  const merged = [...first.slice(0, -1), ...second.slice(0, -1)];
  const seen = new Set<string>();
  return merged.filter(([x, y]) => {
    const key = `${x},${y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Grid covering the polygon and stamps (plus margin), clipped to the measurement window. */
export function gridFor(points: number[][], stamps: BrushStamp[], bounds: Bounds): Grid {
  const xs = [...points.map((p) => p[0]), ...stamps.flatMap((s) => [s.x - s.radius, s.x + s.radius])];
  const ys = [...points.map((p) => p[1]), ...stamps.flatMap((s) => [s.y - s.radius, s.y + s.radius])];
  const [l, t, r, b] = bounds;
  const left = Math.max(l, Math.floor(Math.min(...xs)) - 2);
  const top = Math.max(t, Math.floor(Math.min(...ys)) - 2);
  const right = Math.min(r, Math.ceil(Math.max(...xs)) + 3);
  const bottom = Math.min(b, Math.ceil(Math.max(...ys)) + 3);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  return { left, top, width, height, data: new Uint8Array(width * height) };
}

/**
 * Applies brush/eraser stamps to a boundary and returns the outline of the largest remaining
 * region. `droppedRegions` counts separate pieces that were left out (only one region is measured).
 */
export function applyBrush(points: number[][], stamps: BrushStamp[], bounds: Bounds, epsilon = 1): { polygon: Point[]; droppedRegions: number } {
  if (!stamps.length && points.length < 3) return { polygon: [], droppedRegions: 0 };
  const grid = gridFor(points, stamps, bounds);
  fillPolygon(grid, points);
  stamps.forEach((stamp) => stampDisc(grid, stamp));
  const { grid: region, regions } = largestRegion(open3x3(grid));
  const polygon = simplifyPolygon(traceOuterBoundary(region), epsilon)
    .filter(([x, y]) => x >= bounds[0] && x < bounds[2] && y >= bounds[1] && y < bounds[3]);
  return { polygon: polygon.length >= 3 ? polygon : [], droppedRegions: Math.max(0, regions - 1) };
}

/** Shoelace area in canonical px² — for tests and sanity checks only, never shown as a measurement. */
export function polygonAreaPx(points: number[][]): number {
  let sum = 0;
  points.forEach(([x1, y1], i) => {
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  });
  return Math.abs(sum) / 2;
}

/** Evenly spaced vertices along the outline (for point editing of a dense contour). */
export function resampleByArcLength(points: number[][], count: number): Point[] {
  if (points.length < 3) return points.map(([x, y]) => [Math.round(x), Math.round(y)]);
  const lengths = points.map(([x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length];
    return Math.hypot(nx - x, ny - y);
  });
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total < 1e-6) return simplifyPolygon(points);
  const out: Point[] = [];
  let segment = 0;
  let travelled = 0;
  for (let k = 0; k < count; k += 1) {
    const target = (k * total) / count;
    while (segment < points.length - 1 && travelled + lengths[segment] < target) {
      travelled += lengths[segment];
      segment += 1;
    }
    const [x1, y1] = points[segment];
    const [x2, y2] = points[(segment + 1) % points.length];
    const t = lengths[segment] > 1e-9 ? (target - travelled) / lengths[segment] : 0;
    out.push([Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t)]);
  }
  return simplifyPolygon(out, 0);
}

export function samePolygon(a: number[][] | null | undefined, b: number[][] | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return a === b || (!a?.length && !b?.length);
  return a.every(([x, y], i) => x === b[i][0] && y === b[i][1]);
}

/**
 * Longest vertical (Y) and horizontal (X) runs inside an outline, in the server's line format.
 * Only positions the lines of older measurements saved without them; the sizes shown beside the
 * lines are always the server's stored values.
 */
export function axisChords(points: number[][]): { length_line_px: number[][]; width_line_px: number[][] } | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const left = Math.floor(Math.min(...xs));
  const top = Math.floor(Math.min(...ys));
  const grid: Grid = { left, top, width: Math.ceil(Math.max(...xs)) - left + 2, height: Math.ceil(Math.max(...ys)) - top + 2,
    data: new Uint8Array(0) };
  grid.data = new Uint8Array(grid.width * grid.height);
  fillPolygon(grid, points);
  const longest = (count: number, at: (i: number) => number) => {
    let best = { length: 0, start: 0 };
    let start = -1;
    for (let i = 0; i <= count; i += 1) {
      const on = i < count && at(i) === 1;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        if (i - start > best.length) best = { length: i - start, start };
        start = -1;
      }
    }
    return best;
  };
  let vertical = { length: 0, start: 0, index: 0 };
  for (let col = 0; col < grid.width; col += 1) {
    const run = longest(grid.height, (row) => grid.data[row * grid.width + col]);
    if (run.length > vertical.length) vertical = { ...run, index: col };
  }
  let horizontal = { length: 0, start: 0, index: 0 };
  for (let row = 0; row < grid.height; row += 1) {
    const run = longest(grid.width, (col) => grid.data[row * grid.width + col]);
    if (run.length > horizontal.length) horizontal = { ...run, index: row };
  }
  if (!vertical.length || !horizontal.length) return null;
  return {
    length_line_px: [[left + vertical.index + 0.5, top + vertical.start], [left + vertical.index + 0.5, top + vertical.start + vertical.length]],
    width_line_px: [[left + horizontal.start, top + horizontal.index + 0.5], [left + horizontal.start + horizontal.length, top + horizontal.index + 0.5]],
  };
}
