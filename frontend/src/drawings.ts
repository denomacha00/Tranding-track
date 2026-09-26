// Chart drawing tools — the data model and all the *pure* math behind them.
// Everything here is deterministic and framework-free so it can be unit-tested
// to the letter; the actual canvas rendering and mouse wiring live in
// PriceChart.tsx, but every geometric decision it makes (what did the user
// click on? how far is this line? what does this measurement read?) is a call
// into one of these functions. Anchors are stored in DATA space — a price and
// a candle open time (unix seconds) — never pixels, so a drawing stays pinned
// to the same bar/price as you pan, zoom, or reload.

// A single anchor in data space.
export type Pt = { time: number; price: number }

// A user-drawn object. Three kinds, each carrying only what it needs:
//  - trend: a segment between two anchors
//  - hline: a full-width horizontal line at one price (time-independent)
//  - rect:  an axis-aligned box between two opposite corners
// `color` is a CSS color string; `id` is a stable unique key for React + hit
// selection.
export type Drawing =
  | { id: string; kind: 'trend'; a: Pt; b: Pt; color: string }
  | { id: string; kind: 'hline'; price: number; color: string }
  | { id: string; kind: 'rect'; a: Pt; b: Pt; color: string }

// The active toolbar tool. 'cursor' selects/deletes; the rest place drawings.
export type Tool = 'cursor' | 'trend' | 'hline' | 'rect'

// A point in pixel (screen) space, used only for hit-testing against what the
// user actually sees. PriceChart projects each drawing's data anchors to these
// before calling the hit helpers below.
export type Px = { x: number; y: number }

// --- Geometry (pure pixel-space math) -------------------------------------

// Shortest distance from point p to the line SEGMENT ab (not the infinite
// line): projects p onto ab, clamps the projection to the segment, and returns
// the distance to that clamped foot. Degenerate segment (a===b) → distance to a.
export function distToSegment(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const fx = a.x + t * dx
  const fy = a.y + t * dy
  return Math.hypot(p.x - fx, p.y - fy)
}

// Is p within `tol` px of segment ab?
export function pointNearSegment(p: Px, a: Px, b: Px, tol: number): boolean {
  return distToSegment(p, a, b) <= tol
}

// Is p within `tol` px of the BORDER of the axis-aligned rectangle with
// opposite corners a and b? (Selection follows the drawn outline, like
// TradingView — clicking the hollow middle doesn't grab a huge box.)
export function pointNearRect(p: Px, a: Px, b: Px, tol: number): boolean {
  const tl = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }
  const br = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }
  const tr = { x: br.x, y: tl.y }
  const bl = { x: tl.x, y: br.y }
  return (
    pointNearSegment(p, tl, tr, tol) ||
    pointNearSegment(p, tr, br, tol) ||
    pointNearSegment(p, br, bl, tol) ||
    pointNearSegment(p, bl, tl, tol)
  )
}

// Is p within `tol` px (vertically) of a full-width horizontal line at y=lineY?
export function pointNearHLine(py: number, lineY: number, tol: number): boolean {
  return Math.abs(py - lineY) <= tol
}

// --- Measurement ----------------------------------------------------------

export type Measure = {
  dPrice: number
  dPct: number
  bars: number
  direction: 'up' | 'down' | 'flat'
}

// Read a trend/rect's two anchors as a measurement: absolute price change, %
// change relative to the FROM price, and the whole number of bars spanned
// (from the bar duration in seconds). All derived, never guessed.
export function measure(a: Pt, b: Pt, barSeconds: number): Measure {
  const dPrice = b.price - a.price
  const dPct = a.price !== 0 ? (dPrice / a.price) * 100 : 0
  const bars = barSeconds > 0 ? Math.round(Math.abs(b.time - a.time) / barSeconds) : 0
  const direction = dPrice > 0 ? 'up' : dPrice < 0 ? 'down' : 'flat'
  return { dPrice, dPct, bars, direction }
}

// --- Persistence (per symbol + timeframe) ---------------------------------

// localStorage key for one symbol/timeframe's drawings. Kept stable so a
// symbol's lines survive reloads and don't bleed across markets/timeframes.
export function drawingsKey(symbol: string, timeframe: string): string {
  return `tt.drawings.${symbol}.${timeframe}`
}

export function serializeDrawings(drawings: Drawing[]): string {
  return JSON.stringify(drawings)
}

// Validate one untrusted value into a Drawing, or null. Rebuilds a clean object
// (drops any extra fields) so nothing odd from storage reaches the renderer.
export function validateDrawing(v: unknown): Drawing | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  if (typeof o.color !== 'string' || !o.color || o.color.length > 32) return null
  const pt = (q: unknown): Pt | null => {
    if (!q || typeof q !== 'object') return null
    const r = q as Record<string, unknown>
    return Number.isFinite(r.time) && Number.isFinite(r.price)
      ? { time: r.time as number, price: r.price as number }
      : null
  }
  if (o.kind === 'trend' || o.kind === 'rect') {
    const a = pt(o.a)
    const b = pt(o.b)
    if (a && b) return { id: o.id, kind: o.kind, a, b, color: o.color }
    return null
  }
  if (o.kind === 'hline') {
    if (Number.isFinite(o.price)) return { id: o.id, kind: 'hline', price: o.price as number, color: o.color }
    return null
  }
  return null
}

// Parse a raw localStorage string into a clean Drawing[]. Any corruption — bad
// JSON, not an array, junk entries — is dropped silently; you get [] or the
// valid subset, never a throw.
export function parseDrawings(raw: string | null): Drawing[] {
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: Drawing[] = []
  for (const item of data) {
    const d = validateDrawing(item)
    if (d) out.push(d)
  }
  return out
}

// Thin localStorage wrappers, guarded so they're safe under SSR/tests (no
// localStorage global) and never throw on a full/blocked quota.
export function loadDrawings(symbol: string, timeframe: string): Drawing[] {
  if (typeof localStorage === 'undefined') return []
  try {
    return parseDrawings(localStorage.getItem(drawingsKey(symbol, timeframe)))
  } catch {
    return []
  }
}

export function saveDrawings(symbol: string, timeframe: string, drawings: Drawing[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(drawingsKey(symbol, timeframe), serializeDrawings(drawings))
  } catch {}
}

// A short, unique-enough id for a new drawing. Not cryptographic — just stable
// and collision-resistant for a handful of local drawings.
export function newDrawingId(): string {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}




