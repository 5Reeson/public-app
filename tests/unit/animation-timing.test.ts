import { describe, expect, it } from 'vitest'

import { normalizeAnimationTiming } from '../../src/main/packs/animation-timing.js'

describe('normalizeAnimationTiming', () => {
  it('repairs 1ms and 7ms frames by borrowing from a longer frame', () => {
    expect(normalizeAnimationTiming([1, 7, 92])).toEqual({
      delays: [11, 11, 78],
      keptFrameIndexes: [0, 1, 2],
      originalDurationMs: 100,
      durationMs: 100,
      adjusted: true,
      droppedFrameCount: 0,
    })
  })

  it('keeps exactly 8ms frames valid by moving them to the encoder-safe delay', () => {
    expect(normalizeAnimationTiming([8, 8, 24])).toMatchObject({
      delays: [11, 11, 18],
      durationMs: 40,
      adjusted: true,
      droppedFrameCount: 0,
    })
  })

  it('repairs multiple consecutive short frames while preserving total duration', () => {
    expect(normalizeAnimationTiming([1, 2, 7, 100])).toMatchObject({
      delays: [11, 11, 11, 77],
      originalDurationMs: 110,
      durationMs: 110,
      adjusted: true,
    })
  })

  it('preserves every zero-delay GIF frame using the player-compatible fallback', () => {
    expect(normalizeAnimationTiming(Array(40).fill(0), { zeroDelayMs: 100 })).toMatchObject({
      delays: Array(40).fill(100),
      keptFrameIndexes: Array.from({ length: 40 }, (_, index) => index),
      originalDurationMs: 4_000,
      durationMs: 4_000,
      adjusted: true,
      droppedFrameCount: 0,
    })
  })

  it('merges the shortest frame when the original duration cannot support every frame', () => {
    expect(normalizeAnimationTiming([1, 1, 20])).toMatchObject({
      delays: [11, 11],
      keptFrameIndexes: [1, 2],
      originalDurationMs: 22,
      durationMs: 22,
      droppedFrameCount: 1,
    })
  })

  it('repairs timing at the 10 second boundary without extending duration', () => {
    expect(normalizeAnimationTiming([7, 9_993])).toMatchObject({
      delays: [11, 9_989],
      originalDurationMs: 10_000,
      durationMs: 10_000,
    })
  })

  it('rejects animations whose original duration exceeds 10 seconds', () => {
    expect(() => normalizeAnimationTiming([8, 9_993])).toThrow(/10 秒/)
  })
})
