export const MIN_ANIMATION_FRAME_DURATION_MS = 8
// libwebp interprets encoded frame delays of 10ms or less as 100ms. Repair to
// 11ms so the validated duration survives the actual WebP encoding round trip.
export const NORMALIZED_ANIMATION_FRAME_DURATION_MS = 11
// GIF allows a zero delay, but common players treat it as an unspecified delay
// rather than a request to discard the frame. 100ms is a conservative default
// that preserves the full sequence without turning malformed GIFs into a flash.
export const DEFAULT_ZERO_DELAY_GIF_FRAME_DURATION_MS = 100
export const MAX_ANIMATION_DURATION_MS = 10_000

export interface NormalizedAnimationTiming {
  delays: number[]
  keptFrameIndexes: number[]
  originalDurationMs: number
  durationMs: number
  adjusted: boolean
  droppedFrameCount: number
}

/**
 * Normalizes ordinary malformed animation timing without introducing a second
 * media toolchain. Short frames first borrow time from the longest frames. If
 * the original duration cannot support every frame at the encoder-safe 11ms,
 * the shortest frames are deterministically merged until two frames remain.
 */
export function normalizeAnimationTiming(
  delays: number[],
  options: { zeroDelayMs?: number } = {},
): NormalizedAnimationTiming {
  if (
    delays.length < 2 ||
    delays.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 65_535)
  ) {
    throw new Error('动画帧时长数据无效')
  }
  const effectiveDelays = delays.map((delay) =>
    delay === 0 && options.zeroDelayMs !== undefined ? options.zeroDelayMs : delay,
  )
  const originalDurationMs = sum(effectiveDelays)
  if (originalDurationMs > MAX_ANIMATION_DURATION_MS) {
    throw new Error('动画总时长超过 10 秒')
  }

  const frames = effectiveDelays.map((delay, index) => ({ delay, originalIndex: index }))
  while (
    frames.length > 2 &&
    sum(frames.map((frame) => frame.delay)) < frames.length * NORMALIZED_ANIMATION_FRAME_DURATION_MS
  ) {
    let shortestIndex = 0
    for (let index = 1; index < frames.length; index += 1) {
      if (frames[index]!.delay < frames[shortestIndex]!.delay) shortestIndex = index
    }
    const [removed] = frames.splice(shortestIndex, 1)
    const neighborIndex = shortestIndex === 0 ? 0 : shortestIndex - 1
    frames[neighborIndex]!.delay += removed!.delay
  }

  const normalized = frames.map((frame) =>
    Math.max(frame.delay, NORMALIZED_ANIMATION_FRAME_DURATION_MS),
  )
  let borrowed = sum(normalized) - sum(frames.map((frame) => frame.delay))
  const donorIndexes = frames
    .map((frame, index) => ({
      index,
      available: Math.max(0, frame.delay - NORMALIZED_ANIMATION_FRAME_DURATION_MS),
    }))
    .filter((donor) => donor.available > 0)
    .sort((left, right) => right.available - left.available || left.index - right.index)
  for (const donor of donorIndexes) {
    if (borrowed === 0) break
    const amount = Math.min(donor.available, borrowed)
    normalized[donor.index]! -= amount
    borrowed -= amount
  }

  const durationMs = sum(normalized)
  if (durationMs > MAX_ANIMATION_DURATION_MS) {
    throw new Error('规范化后的动画总时长超过 10 秒')
  }
  const keptFrameIndexes = frames.map((frame) => frame.originalIndex)
  return {
    delays: normalized,
    keptFrameIndexes,
    originalDurationMs,
    durationMs,
    adjusted:
      keptFrameIndexes.length !== delays.length ||
      normalized.some((delay, index) => delay !== effectiveDelays[keptFrameIndexes[index]!]!) ||
      effectiveDelays.some((delay, index) => delay !== delays[index]),
    droppedFrameCount: delays.length - keptFrameIndexes.length,
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
