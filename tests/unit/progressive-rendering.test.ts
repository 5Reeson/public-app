import { describe, expect, it } from 'vitest'

import { nextProgressiveCount } from '../../src/renderer/src/components/useProgressiveCount.js'

describe('progressive rendering', () => {
  it('adds one bounded batch at a time', () => {
    expect(nextProgressiveCount(72, 928, 48)).toBe(120)
    expect(nextProgressiveCount(900, 928, 48)).toBe(928)
  })

  it('does not exceed an empty or already-complete result', () => {
    expect(nextProgressiveCount(0, 0, 48)).toBe(0)
    expect(nextProgressiveCount(10, 10, 10)).toBe(10)
  })
})
