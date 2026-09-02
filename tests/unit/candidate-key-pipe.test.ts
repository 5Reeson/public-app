import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import {
  clearCandidateDatabaseKey,
  encodeSyntheticCandidateFrame,
  readCandidateDatabaseKey,
} from '../../src/main/sources/wechat4/candidate-key-pipe.js'

describe('candidate key anonymous pipe framing', () => {
  it('accepts one fixed-size emoticon frame and supports explicit buffer clearing', async () => {
    const stream = new PassThrough()
    const expectedKey = Buffer.alloc(32, 0x42)
    const frame = encodeSyntheticCandidateFrame({
      salt: Buffer.alloc(16, 0x24),
      key: expectedKey,
    })
    const reading = readCandidateDatabaseKey(stream)
    stream.write(frame)

    const candidate = await reading

    expect(frame.equals(Buffer.alloc(56))).toBe(true)
    expect(candidate).toEqual({
      role: 'emoticon',
      salt: Buffer.alloc(16, 0x24),
      key: expectedKey,
    })
    clearCandidateDatabaseKey(candidate)
    expect(candidate.key.equals(Buffer.alloc(32))).toBe(true)
    expect(candidate.salt.equals(Buffer.alloc(16))).toBe(true)
  })

  it('rejects malformed and oversized frames without returning candidate bytes', async () => {
    const malformed = new PassThrough()
    const malformedRead = readCandidateDatabaseKey(malformed)
    malformed.write(Buffer.alloc(56, 0x7f))
    await expect(malformedRead).rejects.toThrow(/invalid frame/i)

    const oversized = new PassThrough()
    const oversizedRead = readCandidateDatabaseKey(oversized)
    oversized.write(Buffer.alloc(57))
    await expect(oversizedRead).rejects.toThrow(/frame limit/i)

    const duplicate = new PassThrough()
    const duplicateRead = readCandidateDatabaseKey(duplicate)
    const validFrame = encodeSyntheticCandidateFrame({
      salt: Buffer.alloc(16, 0x22),
      key: Buffer.alloc(32, 0x44),
    })
    duplicate.write(Buffer.concat([validFrame, validFrame]))
    validFrame.fill(0)
    await expect(duplicateRead).rejects.toThrow(/frame limit/i)
  })

  it('honors cancellation while no key is available', async () => {
    const stream = new PassThrough()
    const controller = new AbortController()
    const reading = readCandidateDatabaseKey(stream, { signal: controller.signal })
    controller.abort(new DOMException('Canceled by test', 'AbortError'))
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects a pipe that closes without a complete frame', async () => {
    const stream = new PassThrough()
    const reading = readCandidateDatabaseKey(stream)
    stream.write(Buffer.alloc(8))
    stream.destroy()
    await expect(reading).rejects.toThrow(/closed before a complete frame/i)
  })
})
