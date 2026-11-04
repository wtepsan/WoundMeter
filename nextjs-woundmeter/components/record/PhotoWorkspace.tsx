"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Brush,
  Eraser,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  MousePointer2,
  MoveHorizontal,
  MoveVertical,
  PencilLine,
  Redo2,
  RotateCcw,
  Scan,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import {
  applyBrush,
  resampleByArcLength,
  samePolygon,
  simplifyPolygon,
  strokeStamps,
  type Bounds,
  type Point,
} from "@/lib/boundary-mask";

/** One way to show the photo. Canonical views share the rectified pixel grid the boundary is measured on. */
export type PhotoView = { key: string; label: string; src: string; width: number; height: number; canonical: boolean };
/** A measured dimension drawn on the photo: its end points (canonical pixels) and its size label. */
export type SizeLine = { line: number[][]; label: string };
type Axis = "x" | "y";

const SIZE_COLOUR: Record<Axis, string> = { y: "#22D3EE", x: "#FACC15" };
const SIZE_LINES_KEY = "woundmeter.sizeLines";

function readSizeLinePreference(): Record<Axis, boolean> {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SIZE_LINES_KEY) ?? "null") as Partial<Record<Axis, boolean>> | null;
    return { x: saved?.x !== false, y: saved?.y !== false };
  } catch {
    return { x: true, y: true };
  }
}

/**
 * Draws one dimension with end ticks. Its size label continues the line just past the wound outline
 * (`box`, in screen pixels): below (else above) a Y line, right of (else left of) an X line. It never
 * covers the wound, never sits at the end of the other line, and stays inside the photo.
 */
function drawSizeLine(ctx: CanvasRenderingContext2D, axis: Axis, { line, label }: SizeLine, scale: number, width: number, height: number,
  box: { left: number; top: number; right: number; bottom: number }) {
  if (line.length !== 2) return;
  const [[x1, y1], [x2, y2]] = line;
  const a = [x1 * scale, y1 * scale];
  const b = [x2 * scale, y2 * scale];
  const tick = 5;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    for (const [px, py] of [a, b]) {
      if (axis === "y") { ctx.moveTo(px - tick, py); ctx.lineTo(px + tick, py); } else { ctx.moveTo(px, py - tick); ctx.lineTo(px, py + tick); }
    }
  };
  ctx.save();
  ctx.lineCap = "round";
  path();
  ctx.strokeStyle = "rgba(15,23,42,0.7)";
  ctx.lineWidth = 4.5;
  ctx.stroke();
  path();
  ctx.strokeStyle = SIZE_COLOUR[axis];
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = "600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const w = ctx.measureText(label).width + 12;
  const h = 22;
  const gap = 8;
  let lx: number;
  let ly: number;
  if (axis === "y") {
    lx = (a[0] + b[0]) / 2 - w / 2;
    ly = box.bottom + gap;
    if (ly + h > height - 2) ly = box.top - gap - h;
  } else {
    ly = (a[1] + b[1]) / 2 - h / 2;
    lx = box.right + gap;
    if (lx + w > width - 2) lx = box.left - gap - w;
  }
  lx = Math.max(2, Math.min(width - w - 2, lx));
  ly = Math.max(2, Math.min(height - h - 2, ly));
  ctx.fillStyle = "rgba(15,23,42,0.88)";
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(lx, ly, w, h, 6);
  else ctx.rect(lx, ly, w, h);
  ctx.fill();
  ctx.fillStyle = SIZE_COLOUR[axis];
  ctx.textBaseline = "middle";
  ctx.fillText(label, lx + 6, ly + h / 2 + 0.5);
  ctx.restore();
}
type Tool = "view" | "points" | "brush" | "erase";

const MAX_ZOOM = 6;
const POINT_EDIT_LIMIT = 160;
const PROVENANCE_COLOUR: Record<string, string> = { ai_predicted: "#F97316", human_corrected: "#14B8A6", human_accepted: "#22C55E" };

const round = (points: number[][]): Point[] => points.map(([x, y]) => [Math.round(x), Math.round(y)]);

function tracePath(ctx: CanvasRenderingContext2D, points: number[][], scale: number) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * scale, y * scale) : ctx.lineTo(x * scale, y * scale)));
  ctx.closePath();
}

function nearestEdge(points: number[][], x: number, y: number): { index: number; distance: number } {
  let best = { index: -1, distance: Infinity };
  points.forEach(([x1, y1], i) => {
    const [x2, y2] = points[(i + 1) % points.length];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 1e-9 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq)) : 0;
    const distance = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
    if (distance < best.distance) best = { index: i + 1, distance };
  });
  return best;
}

/**
 * The record's photo and boundary editor: view switching, overlay, zoom/pan, full screen, and
 * point/brush/eraser editing with undo and redo. It never measures; the parent sends the edited
 * polygon to the server, which measures it with the validated algorithm.
 */
export function PhotoWorkspace({
  views,
  bounds,
  boundary,
  aiBoundary,
  provenance,
  pixelsPerMm,
  editable,
  editMode = false,
  onStartEdit,
  editHeader,
  editHint,
  busy = false,
  resetKey,
  onEdit,
  load,
  sizeLines,
  legend,
  children,
}: {
  views: PhotoView[];
  bounds: Bounds | null;
  /** The saved boundary in use (canonical pixels). */
  boundary: number[][];
  /** The selected AI suggestion, for "Reset to AI suggestion" and the dashed comparison outline. */
  aiBoundary?: number[][] | null;
  provenance: "ai_predicted" | "human_corrected" | "human_accepted";
  pixelsPerMm?: number | null;
  editable: boolean;
  /** Editing is a mode: the tools appear after Edit boundary and close with the parent's Done or Cancel. */
  editMode?: boolean;
  onStartEdit?: () => void;
  /** Shown above the editing tools while editing (title, region choice, Cancel and Done). */
  editHeader?: ReactNode;
  /** Replaces the default hint beside Edit boundary. */
  editHint?: string;
  busy?: boolean;
  /** Changing it discards local edits (after a save or reload). */
  resetKey: string;
  /** The unsaved polygon, or null when nothing differs from the saved boundary. */
  onEdit?: (points: Point[] | null) => void;
  /** Loads an outline (an AI suggestion) into the editor as an undoable edit; a new key loads again. */
  load?: { key: string; points: Point[] } | null;
  /** Y (length) and X (width) lines with their sizes; omitted while the figures are being recalculated. */
  sizeLines?: Partial<Record<Axis, SizeLine | null>> | null;
  legend?: ReactNode;
  children?: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const editPanelRef = useRef<HTMLDivElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const images = useRef(new Map<string, HTMLImageElement>());
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const [viewKey, setViewKey] = useState(views[0]?.key ?? "");
  const view = views.find((v) => v.key === viewKey) ?? views[0];
  const [overlay, setOverlay] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [space, setSpace] = useState({ width: 0, height: 0 });

  const [tool, setTool] = useState<Tool>("view");
  const [points, setPoints] = useState<Point[] | null>(null);
  const [past, setPast] = useState<Point[][]>([]);
  const [future, setFuture] = useState<Point[][]>([]);
  const [brushMm, setBrushMm] = useState(4);
  const [stroke, setStroke] = useState<{ path: Point[]; add: boolean } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Which size lines are shown is a per-viewer preference, remembered in this browser only.
  const [showLines, setShowLines] = useState<Record<Axis, boolean>>({ x: true, y: true });
  useEffect(() => setShowLines(readSizeLinePreference()), []);
  const toggleLine = (axis: Axis) => setShowLines((current) => {
    const next = { ...current, [axis]: !current[axis] };
    try {
      window.localStorage.setItem(SIZE_LINES_KEY, JSON.stringify(next));
    } catch { /* storage unavailable: the choice lasts for this page */ }
    return next;
  });

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "pan" | "pinch"; x: number; y: number; scrollX: number; scrollY: number; distance: number; zoom: number } | null>(null);
  const anchor = useRef<{ fx: number; fy: number; ax: number; ay: number } | null>(null);

  const base = useMemo(() => round(boundary), [boundary]);
  const current = points ?? base;
  const editing = points !== null;
  const dirty = editing && !samePolygon(points, base);
  const canEdit = editable && Boolean(view?.canonical && bounds);
  const ppm = pixelsPerMm && pixelsPerMm > 0 ? pixelsPerMm : 10;
  const brushRadius = (brushMm * ppm) / 2;

  const resetEditor = useCallback(() => {
    setPoints(null);
    setPast([]);
    setFuture([]);
    setTool("view");
    setStroke(null);
    setNotice(null);
    setConfirmClear(false);
  }, []);
  // A save or reload starts from the newly saved boundary.
  useEffect(() => resetEditor(), [resetKey, resetEditor]);
  // Entering edit mode picks a tool without changing the outline; leaving it discards anything unsaved.
  useEffect(() => {
    if (editMode) {
      setTool(base.length >= 3 && base.length <= POINT_EDIT_LIMIT ? "points" : "brush");
      // Editing can start from an AI suggestion further down; bring Done and Cancel into view.
      editPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      resetEditor();
      // Done or Cancel removed the focused button with the panel; keyboard users continue from Edit boundary.
      if (wasEditing.current) {
        window.requestAnimationFrame(() => {
          if (!document.activeElement || document.activeElement === document.body) editButtonRef.current?.focus({ preventScroll: true });
        });
      }
    }
    wasEditing.current = editMode;
    // Only the mode switch triggers this; the outline at that moment decides the first tool.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode]);

  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!load || load.key === loadedKey.current) return;
    loadedKey.current = load.key;
    setPast((p) => [...p.slice(-40), points ?? base]);
    setFuture([]);
    setPoints(load.points);
    setNotice(null);
    // Only a new load key triggers this; current edits are captured in the history above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  useEffect(() => onEditRef.current?.(dirty ? points : null), [dirty, points]);

  // Load each view's image once.
  useEffect(() => {
    if (!view) return;
    const cached = images.current.get(view.src);
    if (cached?.complete && cached.naturalWidth) {
      setLoaded(view.src);
      return;
    }
    const image = cached ?? new Image();
    image.onload = () => setLoaded(view.src);
    image.onerror = () => setFailed(view.src);
    if (!cached) {
      image.src = view.src;
      images.current.set(view.src, image);
    }
  }, [view]);

  // Fit the photo to the space available (taller limit when expanded).
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      // Beside the record form (two columns) the photo leaves room for its controls and the measurement
      // panel below it, so area, length, width and perimeter stay on screen with the photo (1440×900: 380 px).
      const besideForm = window.matchMedia("(min-width: 1100px)").matches;
      setSpace({
        width: element.clientWidth,
        height: expanded ? window.innerHeight - 150
          : besideForm ? Math.max(280, Math.min(window.innerHeight - 520, 760)) : Math.min(window.innerHeight * 0.72, 820),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [expanded]);

  const fitWidth = view && space.width ? Math.max(120, Math.min(space.width, (space.height * view.width) / view.height)) : 0;
  const cssWidth = Math.round(fitWidth * zoom);
  const cssHeight = view ? Math.round((cssWidth * view.height) / view.width) : 0;
  const scale = view ? cssWidth / view.width : 1;

  const zoomTo = useCallback((next: number, clientX?: number, clientY?: number) => {
    const element = scrollRef.current;
    const clamped = Math.max(1, Math.min(MAX_ZOOM, Number(next.toFixed(2))));
    if (element) {
      const rect = element.getBoundingClientRect();
      const ax = clientX === undefined ? element.clientWidth / 2 : clientX - rect.left;
      const ay = clientY === undefined ? element.clientHeight / 2 : clientY - rect.top;
      const content = canvasRef.current?.getBoundingClientRect();
      if (content && content.width) {
        anchor.current = { fx: (clientX ?? rect.left + ax) - content.left, fy: (clientY ?? rect.top + ay) - content.top, ax, ay };
        anchor.current.fx /= content.width;
        anchor.current.fy /= content.height;
      }
    }
    setZoom(clamped);
  }, []);

  // Keep the point under the cursor (or the centre) fixed while zooming.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const a = anchor.current;
    if (!element || !a) return;
    anchor.current = null;
    const offsetX = Math.max(0, (element.clientWidth - cssWidth) / 2);
    const offsetY = Math.max(0, (element.clientHeight - cssHeight) / 2);
    element.scrollLeft = a.fx * cssWidth + offsetX - a.ax;
    element.scrollTop = a.fy * cssHeight + offsetY - a.ay;
  }, [cssWidth, cssHeight]);

  // Trackpad pinch and Ctrl/Cmd + wheel zoom (needs a non-passive listener).
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomTo(zoom * Math.exp(-event.deltaY / 300), event.clientX, event.clientY);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoom, zoomTo]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setExpanded(false);
    document.addEventListener("keydown", onKey);
    document.body.classList.add("photo-expanded-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("photo-expanded-open");
    };
  }, [expanded]);

  const commit = useCallback((next: Point[]) => {
    setPast((p) => [...p.slice(-40), current]);
    setFuture([]);
    setPoints(next);
  }, [current]);

  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [current, ...f]);
    setNotice(null);
    setPoints(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, current]);
    setNotice(null);
    setPoints(future[0]);
    setFuture((f) => f.slice(1));
  };

  const chooseTool = (next: Tool) => {
    setConfirmClear(false);
    if (next !== "view" && points === null) {
      // Point editing needs a manageable number of handles; the change is undoable.
      if (next === "points" && base.length > POINT_EDIT_LIMIT) {
        setPast([base]);
        setPoints(resampleByArcLength(base, 64));
        setNotice("The outline was simplified to 64 points for point editing. Undo restores the full outline.");
      } else {
        setPoints(base);
      }
    } else if (next === "points" && current.length > POINT_EDIT_LIMIT) {
      commit(resampleByArcLength(current, 64));
      setNotice("The outline was simplified to 64 points for point editing. Undo restores the full outline.");
    }
    setTool(next);
  };

  /** Scales the outline about its centre, kept inside the measurement window. */
  const scaleBoundary = (factor: number) => {
    if (!bounds || current.length < 3) return;
    const cx = current.reduce((sum, p) => sum + p[0], 0) / current.length;
    const cy = current.reduce((sum, p) => sum + p[1], 0) / current.length;
    commit(simplifyPolygon(current.map(([x, y]) => [
      Math.max(bounds[0], Math.min(bounds[2] - 1, cx + (x - cx) * factor)),
      Math.max(bounds[1], Math.min(bounds[3] - 1, cy + (y - cy) * factor)),
    ]), 0));
  };

  const toCanonical = (clientX: number, clientY: number, clamp: boolean): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas || !view || !bounds) return null;
    const rect = canvas.getBoundingClientRect();
    let x = ((clientX - rect.left) / rect.width) * view.width;
    let y = ((clientY - rect.top) / rect.height) * view.height;
    if (clamp) {
      x = Math.max(bounds[0], Math.min(bounds[2] - 1, x));
      y = Math.max(bounds[1], Math.min(bounds[3] - 1, y));
    }
    return [Math.round(x), Math.round(y)];
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const element = scrollRef.current;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2 && element) {
      // Two fingers: pinch to zoom and pan; abandon any stroke in progress.
      const [a, b] = [...pointers.current.values()];
      setStroke(null);
      setDragIndex(null);
      gesture.current = { kind: "pinch", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, scrollX: element.scrollLeft, scrollY: element.scrollTop,
        distance: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      return;
    }
    if (pointers.current.size > 1) return;
    const panning = tool === "view" || event.button === 1 || !canEdit;
    if (panning) {
      if (element) gesture.current = { kind: "pan", x: event.clientX, y: event.clientY, scrollX: element.scrollLeft, scrollY: element.scrollTop, distance: 0, zoom };
      return;
    }
    if (busy) return;
    if (tool === "brush" || tool === "erase") {
      const at = toCanonical(event.clientX, event.clientY, false);
      if (at) setStroke({ path: [at], add: tool === "brush" });
      return;
    }
    const at = toCanonical(event.clientX, event.clientY, true);
    if (!at) return;
    const reach = 12 / scale;
    if (current.length < 3) {
      // Drawing a new outline point by point.
      commit([...current, at]);
      return;
    }
    let nearest = -1;
    let distance = Infinity;
    current.forEach(([x, y], i) => {
      const d = Math.hypot(x - at[0], y - at[1]);
      if (d < distance) {
        distance = d;
        nearest = i;
      }
    });
    if ((event.shiftKey || event.altKey) && distance <= reach && current.length > 4) {
      commit(current.filter((_, i) => i !== nearest));
      return;
    }
    if (distance <= reach) {
      commit(current);
      setDragIndex(nearest);
      return;
    }
    const edge = nearestEdge(current, at[0], at[1]);
    if (edge.distance <= 10 / scale) {
      const next = [...current];
      next.splice(edge.index, 0, at);
      commit(next);
      setDragIndex(edge.index);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const element = scrollRef.current;
    const g = gesture.current;
    if (g && element) {
      if (g.kind === "pinch" && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        zoomTo(g.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, g.distance)), mx, my);
        element.scrollLeft -= mx - g.x;
        element.scrollTop -= my - g.y;
        g.x = mx;
        g.y = my;
      } else if (g.kind === "pan") {
        element.scrollLeft = g.scrollX - (event.clientX - g.x);
        element.scrollTop = g.scrollY - (event.clientY - g.y);
      }
      return;
    }
    if (tool === "brush" || tool === "erase") setHover(toCanonical(event.clientX, event.clientY, false));
    if (stroke) {
      const at = toCanonical(event.clientX, event.clientY, false);
      if (at) setStroke((s) => (s ? { ...s, path: [...s.path, at] } : s));
    } else if (dragIndex !== null) {
      const at = toCanonical(event.clientX, event.clientY, true);
      if (at) setPoints((p) => (p ? p.map((point, i) => (i === dragIndex ? at : point)) : p));
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2 && gesture.current?.kind === "pinch") gesture.current = null;
    if (pointers.current.size === 0) gesture.current = null;
    if (dragIndex !== null) setDragIndex(null);
    if (stroke && bounds) {
      const { polygon, droppedRegions } = applyBrush(current, strokeStamps(stroke.path, brushRadius, stroke.add), bounds);
      setStroke(null);
      commit(polygon);
      setNotice(droppedRegions
        ? `Only one connected region can be measured; ${droppedRegions === 1 ? "a separate piece was" : `${droppedRegions} separate pieces were`} left out. Undo to restore.`
        : !polygon.length ? "No boundary remains. Paint the wound with the brush, or click to place points." : null);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    } else if (!mod && (event.key === "+" || event.key === "=")) zoomTo(zoom * 1.25);
    else if (!mod && event.key === "-") zoomTo(zoom / 1.25);
    else if (!mod && event.key === "0") setZoom(1);
  };

  // Draw synchronously on every change; images are cached, so this stays cheap while dragging.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const image = view ? images.current.get(view.src) : undefined;
    if (!canvas || !view || !image || loaded !== view.src || !cssWidth) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.drawImage(image, 0, 0, cssWidth, cssHeight);
    if (!overlay || !view.canonical) return;

    if (aiBoundary && aiBoundary.length > 2 && !samePolygon(round(aiBoundary), editing ? current : base)) {
      ctx.save();
      tracePath(ctx, aiBoundary, scale);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.75;
      ctx.stroke();
      ctx.restore();
    }

    if (stroke) {
      // Preview the stroke exactly as it will be applied: fill, then add or erase discs.
      const layer = document.createElement("canvas");
      layer.width = canvas.width;
      layer.height = canvas.height;
      const l = layer.getContext("2d");
      if (l) {
        l.setTransform(dpr, 0, 0, dpr, 0, 0);
        l.fillStyle = "#14B8A6";
        if (current.length > 2) {
          tracePath(l, current, scale);
          l.fill();
        }
        l.globalCompositeOperation = stroke.add ? "source-over" : "destination-out";
        strokeStamps(stroke.path, brushRadius, stroke.add).forEach(({ x, y, radius }) => {
          l.beginPath();
          l.arc(x * scale, y * scale, radius * scale, 0, Math.PI * 2);
          l.fill();
        });
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
      }
    } else if (current.length > 2) {
      ctx.save();
      tracePath(ctx, current, scale);
      if (editing) {
        ctx.fillStyle = "rgba(20,184,166,0.22)";
        ctx.fill();
        ctx.strokeStyle = "#2DD4BF";
        ctx.lineWidth = 2.25;
      } else {
        ctx.strokeStyle = PROVENANCE_COLOUR[provenance] ?? PROVENANCE_COLOUR.ai_predicted;
        ctx.lineWidth = 3;
      }
      ctx.stroke();
      ctx.restore();
    }

    if (tool === "points" && current.length <= POINT_EDIT_LIMIT) {
      current.forEach(([x, y], i) => {
        ctx.beginPath();
        ctx.arc(x * scale, y * scale, i === dragIndex ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === dragIndex ? "#F97316" : "#FFFFFF";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#0F172A";
        ctx.stroke();
      });
    }

    // Size lines follow the figures shown; hidden mid-stroke, when the outline is changing under the pointer.
    if (sizeLines && !stroke && dragIndex === null) {
      const outline = current.length > 2 ? current : [...(sizeLines.x?.line ?? []), ...(sizeLines.y?.line ?? [])];
      const box = {
        left: Math.min(...outline.map((p) => p[0])) * scale, right: Math.max(...outline.map((p) => p[0])) * scale,
        top: Math.min(...outline.map((p) => p[1])) * scale, bottom: Math.max(...outline.map((p) => p[1])) * scale,
      };
      (["y", "x"] as const).forEach((axis) => {
        const size = sizeLines[axis];
        if (size && showLines[axis]) drawSizeLine(ctx, axis, size, scale, cssWidth, cssHeight, box);
      });
    }

    if ((tool === "brush" || tool === "erase") && hover) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(hover[0] * scale, hover[1] * scale, brushRadius * scale, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#0F172A";
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = tool === "brush" ? "#FFFFFF" : "#FCA5A5";
      ctx.stroke();
      ctx.restore();
    }
  }, [loaded, view, cssWidth, cssHeight, scale, overlay, aiBoundary, current, base, editing, stroke, tool, hover, dragIndex, brushRadius, provenance, sizeLines, showLines]);

  if (!view) return null;
  const editTools: Array<{ key: Tool; label: string; icon: React.ElementType; hint: string }> = [
    { key: "points", label: "Points", icon: MousePointer2, hint: "Drag a point to move it. Click the outline to add a point. Shift-click a point to remove it." },
    { key: "brush", label: "Brush", icon: Brush, hint: "Paint to add wound area." },
    { key: "erase", label: "Eraser", icon: Eraser, hint: "Paint to remove area from the boundary." },
  ];
  const activeHint = !editMode ? null : tool === "view" ? "Choose Points, Brush or Eraser. Drag to pan when zoomed."
    : editTools.find((t) => t.key === tool)?.hint;

  return (
    <div ref={wrapRef} className={`photo-workspace${expanded ? " is-expanded" : ""}`} role="region" aria-label="Photo and boundary">
      <div className="photo-toolbar" role="toolbar" aria-label="Photo tools">
        {views.length > 1 && (
          <div className="segmented" role="group" aria-label="Photo shown">
            {views.map((v) => (
              <button key={v.key} type="button" aria-pressed={v.key === view.key} onClick={() => setViewKey(v.key)}>{v.label}</button>
            ))}
          </div>
        )}
        <button type="button" className="tool-button toggle" aria-pressed={overlay} disabled={!view.canonical}
          onClick={() => setOverlay((value) => !value)} title={overlay ? "Hide boundary" : "Show boundary"}>
          {overlay ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}<span>Boundary</span>
        </button>
        {sizeLines !== undefined && (
          <div className="tool-group" role="group" aria-label="Size lines">
            {([["y", "Length line (Y)", MoveVertical], ["x", "Width line (X)", MoveHorizontal]] as const).map(([axis, name, Icon]) => (
              <button key={axis} type="button" className={`tool-button toggle size-${axis}`} aria-label={name} title={`${showLines[axis] ? "Hide" : "Show"} ${name.toLowerCase()}`}
                aria-pressed={showLines[axis]} disabled={!overlay || !view.canonical || !sizeLines?.[axis]} onClick={() => toggleLine(axis)}>
                <Icon aria-hidden="true" /><span aria-hidden="true">{axis.toUpperCase()}</span>
              </button>
            ))}
          </div>
        )}
        <span className="toolbar-spacer" />
        <div className="tool-group" role="group" aria-label="Zoom">
          <button type="button" className="tool-button icon" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => zoomTo(zoom / 1.25)}><ZoomOut aria-hidden="true" /></button>
          <span className="zoom-readout" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" className="tool-button icon" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => zoomTo(zoom * 1.25)}><ZoomIn aria-hidden="true" /></button>
          <button type="button" className="tool-button icon" aria-label="Fit to screen" disabled={zoom === 1} onClick={() => setZoom(1)}><Scan aria-hidden="true" /></button>
          {expanded ? (
            <button type="button" className="tool-button exit-expanded" title="Exit full screen (Esc)" onClick={() => setExpanded(false)}>
              <Minimize2 aria-hidden="true" /><span>Exit full screen</span>
            </button>
          ) : (
            <button type="button" className="tool-button icon" aria-label="Full screen" title="Full screen" onClick={() => setExpanded(true)}>
              <Maximize2 aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {editable && !editMode && (
        <div className="edit-entry">
          <button ref={editButtonRef} type="button" className="button secondary" disabled={!canEdit || busy} onClick={onStartEdit}>
            <PencilLine aria-hidden="true" /> Edit boundary
          </button>
          <span className="fine-print">{!canEdit ? "Switch to a rectified view to edit the boundary." : editHint ?? "Check that the outline follows the wound edge. Edit it if it doesn't."}</span>
        </div>
      )}

      {editable && editMode && (
        <div className="edit-panel" ref={editPanelRef}>
          {editHeader}
          <div className="edit-toolbar" role="toolbar" aria-label="Boundary editing">
            <div className="tool-group" role="group" aria-label="Editing tool">
              {editTools.map(({ key, label, icon: Icon }) => (
                <button key={key} type="button" className="tool-button" aria-pressed={tool === key} disabled={!canEdit || busy}
                  onClick={() => chooseTool(tool === key ? "view" : key)}>
                  <Icon aria-hidden="true" /><span>{label}</span>
                </button>
              ))}
            </div>
            {tool === "points" && (
              <div className="tool-group" role="group" aria-label="Scale boundary">
                <button type="button" className="tool-button" disabled={busy || current.length < 3} onClick={() => scaleBoundary(1.04)}>Expand 4%</button>
                <button type="button" className="tool-button" disabled={busy || current.length < 3} onClick={() => scaleBoundary(0.96)}>Shrink 4%</button>
              </div>
            )}
            {(tool === "brush" || tool === "erase") && (
              <label className="brush-size">
                <span>Size</span>
                <input type="range" min={1} max={20} step={1} value={brushMm} onChange={(e) => setBrushMm(Number(e.target.value))} />
                <span className="mono">{brushMm} mm</span>
              </label>
            )}
            <span className="toolbar-spacer" />
            <div className="tool-group" role="group" aria-label="History">
              <button type="button" className="tool-button icon" aria-label="Undo" title="Undo (Ctrl/Cmd+Z)" disabled={!past.length || busy} onClick={undo}><Undo2 aria-hidden="true" /></button>
              <button type="button" className="tool-button icon" aria-label="Redo" title="Redo (Shift+Ctrl/Cmd+Z)" disabled={!future.length || busy} onClick={redo}><Redo2 aria-hidden="true" /></button>
              <button type="button" className="tool-button" disabled={!canEdit || busy || !aiBoundary || aiBoundary.length < 3}
                onClick={() => {
                  if (points === null) setPoints(base);
                  commit(round(aiBoundary ?? []));
                  setNotice(null);
                }}>
                <RotateCcw aria-hidden="true" /><span>Reset to AI</span>
              </button>
              {confirmClear ? (
                <span className="confirm-inline" role="group" aria-label="Clear the boundary?">
                  <button type="button" className="tool-button danger" onClick={() => {
                    if (points === null) setPoints(base);
                    commit([]);
                    setConfirmClear(false);
                    setTool("brush");
                    setNotice("Boundary cleared. Paint the wound with the brush, or use Points and click to place points.");
                  }}>Clear boundary</button>
                  <button type="button" className="tool-button" onClick={() => setConfirmClear(false)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className="tool-button" disabled={!canEdit || busy || current.length === 0} onClick={() => setConfirmClear(true)}>
                  <Trash2 aria-hidden="true" /><span>Clear</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className={`photo-stage${zoom > 1 ? " is-zoomed" : ""} tool-${tool}`}
        style={{ height: expanded ? space.height : cssHeight ? Math.min(cssHeight, space.height) : undefined }}
        tabIndex={0}
        role="group"
        aria-label={`${view.label} photo${editMode ? ". Ctrl or Cmd plus Z undoes an edit; plus and minus zoom." : ""}`}
        onKeyDown={onKeyDown}
      >
        {failed === view.src ? (
          <p className="photo-error">This image could not be loaded. Reload the record to refresh its private link.</p>
        ) : (
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setHover(null)}
            style={{ touchAction: "none" }}
            aria-label={view.canonical ? "Rectified wound photo with the wound boundary drawn on top" : "Original wound photo as captured"}
          />
        )}
      </div>

      <div className="photo-caption">
        {!view.canonical ? <span>The boundary is measured on the rectified photo; the original is shown as captured.</span> : legend}
        {activeHint && <span className="fine-print">{activeHint}</span>}
        {notice && <span className="photo-notice" role="status">{notice}</span>}
      </div>
      {children}
    </div>
  );
}
