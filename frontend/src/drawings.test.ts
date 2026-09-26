import { describe, it, expect } from 'vitest'
import {
  distToSegment,
  pointNearSegment,
  pointNearRect,
  pointNearHLine,
  measure,
  drawingsKey,
  serializeDrawings,
  parseDrawings,
  validateDrawing,
  loadDrawings,
  saveDrawings,
  newDrawingId,
  type Drawing,
} from './drawings'

// These run under vitest's default node environment (no DOM). Everything tested
// here is pure — the canvas/mouse wiring in PriceChart is verified live in the
// preview, but every decision it delegates to is pinned down below.

describe('distToSegment', () => {
  it('is the perpendicular drop onto the segment body', () => {
    // Horizontal segment from (0,0) to (10,0); point straight above the middle.
    expect(distToSegment({ x: 5, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(4)
  })
  it('clamps past an endpoint (distance to the nearer end, not the infinite line)', () => {
    // Point beyond the right end: on the infinite line its distance is 0, but
    // clamped to the segment it's the 5px gap to the endpoint (10,0).
    expect(distToSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5)
  })
  it('returns 0 for a point lying on the segment', () => {
    expect(distToSegment({ x: 3, y: 3 }, { x: 0, y: 0 }, { x: 6, y: 6 })).toBeCloseTo(0)
  })
  it('handles a degenerate (zero-length) segment as distance to the point', () => {
    expect(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5)
  })
})

describe('pointNearSegment', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 10, y: 0 }
  it('is true within tolerance and false beyond it', () => {
    expect(pointNearSegment({ x: 5, y: 5 }, a, b, 6)).toBe(true)
    expect(pointNearSegment({ x: 5, y: 5 }, a, b, 4)).toBe(false)
  })
})

describe('pointNearRect (selection follows the outline, not the fill)', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 100, y: 60 }
  it('is true near any edge', () => {
    expect(pointNearRect({ x: 50, y: 2 }, a, b, 4)).toBe(true) // top edge
    expect(pointNearRect({ x: 98, y: 30 }, a, b, 4)).toBe(true) // right edge
    expect(pointNearRect({ x: 50, y: 58 }, a, b, 4)).toBe(true) // bottom edge
    expect(pointNearRect({ x: 2, y: 30 }, a, b, 4)).toBe(true) // left edge
  })
  it('is true near a corner', () => {
    expect(pointNearRect({ x: 1, y: 1 }, a, b, 4)).toBe(true)
  })
  it('is FALSE in the hollow middle', () => {
    expect(pointNearRect({ x: 50, y: 30 }, a, b, 4)).toBe(false)
  })
  it('is false far outside', () => {
    expect(pointNearRect({ x: 200, y: 200 }, a, b, 4)).toBe(false)
  })
  it('works regardless of which corners are passed (a/b order)', () => {
    expect(pointNearRect({ x: 50, y: 2 }, b, a, 4)).toBe(true)
  })
})

describe('pointNearHLine', () => {
  it('is a vertical tolerance band around the line', () => {
    expect(pointNearHLine(103, 100, 4)).toBe(true)
    expect(pointNearHLine(106, 100, 4)).toBe(false)
  })
})

describe('measure', () => {
  const H = 3600
  it('reads an up move: price delta, % of the FROM price, and whole bars', () => {
    const m = measure({ time: 0, price: 100 }, { time: 3 * H, price: 110 }, H)
    expect(m.dPrice).toBeCloseTo(10)
    expect(m.dPct).toBeCloseTo(10)
    expect(m.bars).toBe(3)
    expect(m.direction).toBe('up')
  })
  it('reads a down move and keeps bar count positive even if b is earlier', () => {
    const m = measure({ time: 5 * H, price: 100 }, { time: 2 * H, price: 90 }, H)
    expect(m.dPrice).toBeCloseTo(-10)
    expect(m.direction).toBe('down')
    expect(m.bars).toBe(3)
  })
  it('is flat when prices are equal (and % is 0)', () => {
    const m = measure({ time: 0, price: 100 }, { time: H, price: 100 }, H)
    expect(m.direction).toBe('flat')
    expect(m.dPct).toBe(0)
  })
  it('never divides by zero when the FROM price is 0', () => {
    expect(measure({ time: 0, price: 0 }, { time: H, price: 5 }, H).dPct).toBe(0)
  })
  it('returns 0 bars for a non-positive bar duration', () => {
    expect(measure({ time: 0, price: 1 }, { time: H, price: 2 }, 0).bars).toBe(0)
  })
})

describe('drawingsKey', () => {
  it('namespaces per symbol and timeframe', () => {
    expect(drawingsKey('BTC/USDT', '1h')).toBe('tt.drawings.BTC/USDT.1h')
    expect(drawingsKey('ETH/USDT', '15m')).toBe('tt.drawings.ETH/USDT.15m')
  })
})

const sample: Drawing[] = [
  { id: 'a', kind: 'trend', a: { time: 1, price: 10 }, b: { time: 2, price: 20 }, color: '#fff' },
  { id: 'b', kind: 'hline', price: 42, color: '#f0b90b' },
  { id: 'c', kind: 'rect', a: { time: 3, price: 5 }, b: { time: 9, price: 8 }, color: '#3b82f6' },
]

describe('serialize / parse round trip', () => {
  it('preserves every kind exactly', () => {
    expect(parseDrawings(serializeDrawings(sample))).toEqual(sample)
  })
})

describe('parseDrawings is defensive about untrusted storage', () => {
  it('returns [] for null / empty / bad JSON / non-array', () => {
    expect(parseDrawings(null)).toEqual([])
    expect(parseDrawings('')).toEqual([])
    expect(parseDrawings('{not json')).toEqual([])
    expect(parseDrawings('{}')).toEqual([])
    expect(parseDrawings('42')).toEqual([])
  })
  it('keeps the valid subset and drops junk entries', () => {
    const raw = JSON.stringify([
      sample[0],
      { id: 'x', kind: 'bogus', color: '#fff' }, // unknown kind
      { kind: 'hline', price: 1, color: '#fff' }, // missing id
      { id: 'y', kind: 'hline', color: '#fff' }, // missing price
      { id: 'z', kind: 'trend', a: { time: 1, price: NaN }, b: { time: 2, price: 3 }, color: '#fff' }, // NaN coord
      sample[1],
    ])
    expect(parseDrawings(raw)).toEqual([sample[0], sample[1]])
  })
  it('strips any extra fields (rebuilds a clean object)', () => {
    const raw = JSON.stringify([{ ...sample[1], evil: 'x', extra: 99 }])
    expect(parseDrawings(raw)).toEqual([sample[1]])
  })
})

describe('validateDrawing', () => {
  it('accepts each valid kind', () => {
    expect(validateDrawing(sample[0])).toEqual(sample[0])
    expect(validateDrawing(sample[1])).toEqual(sample[1])
    expect(validateDrawing(sample[2])).toEqual(sample[2])
  })
  it('rejects empty id, missing/overlong color, and non-objects', () => {
    expect(validateDrawing({ ...sample[1], id: '' })).toBeNull()
    expect(validateDrawing({ ...sample[1], color: '' })).toBeNull()
    expect(validateDrawing({ ...sample[1], color: 'x'.repeat(40) })).toBeNull()
    expect(validateDrawing(null)).toBeNull()
    expect(validateDrawing('nope')).toBeNull()
  })
})

describe('localStorage wrappers stay safe without a DOM', () => {
  it('loadDrawings returns [] and saveDrawings does not throw under node', () => {
    expect(loadDrawings('BTC/USDT', '1h')).toEqual([])
    expect(() => saveDrawings('BTC/USDT', '1h', sample)).not.toThrow()
  })
})

describe('newDrawingId', () => {
  it('is a non-empty string and effectively unique per call', () => {
    const a = newDrawingId()
    const b = newDrawingId()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(1)
    expect(a).not.toBe(b)
  })
})


