import { describe, expect, it } from 'vitest'

import {
  boxSelectionScrollDelta,
  hasCrossedBoxSelectionThreshold,
  intersectRectangles,
  rectanglesIntersect,
  viewportPointInScrollContent,
} from '../../src/renderer/src/components/boxSelection.js'

describe('box selection', () => {
  it('maps viewport coordinates into scroll content exactly once', () => {
    expect(viewportPointInScrollContent(140, 720, 0, 900)).toEqual({ x: 140, y: 1620 })
  })

  it('keeps a click separate from a box-selection drag', () => {
    expect(hasCrossedBoxSelectionThreshold(10, 10, 13, 13, 5)).toBe(false)
    expect(hasCrossedBoxSelectionThreshold(10, 10, 16, 10, 5)).toBe(true)
  })

  it('includes tiles crossed by the selection rectangle', () => {
    expect(
      rectanglesIntersect(
        { top: 10, right: 80, bottom: 80, left: 10 },
        { top: 60, right: 120, bottom: 120, left: 60 },
      ),
    ).toBe(true)
  })

  it('clips the visual selection to the visible picker area', () => {
    expect(
      intersectRectangles(
        { top: 100, right: 600, bottom: 1800, left: 100 },
        { top: 700, right: 520, bottom: 1200, left: 160 },
      ),
    ).toEqual({ top: 700, right: 520, bottom: 1200, left: 160 })
  })

  it('does not include tiles that only touch the selection edge', () => {
    expect(
      rectanglesIntersect(
        { top: 10, right: 60, bottom: 60, left: 10 },
        { top: 60, right: 120, bottom: 120, left: 60 },
      ),
    ).toBe(false)
  })

  it('accelerates scrolling near the viewport edges', () => {
    expect(boxSelectionScrollDelta(400, 800)).toBe(0)
    expect(boxSelectionScrollDelta(764, 800)).toBe(9)
    expect(boxSelectionScrollDelta(800, 800)).toBe(18)
    expect(boxSelectionScrollDelta(36, 800)).toBe(-9)
    expect(boxSelectionScrollDelta(0, 800)).toBe(-18)
  })

  it('caps scrolling when the pointer leaves the viewport', () => {
    expect(boxSelectionScrollDelta(900, 800)).toBe(18)
    expect(boxSelectionScrollDelta(-100, 800)).toBe(-18)
  })
})
