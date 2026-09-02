import type { Readable } from 'node:stream'

const MAGIC = Buffer.from('CMK1', 'ascii')
const FRAME_BYTES = 56
const PROTOCOL_VERSION = 1
const EMOTICON_ROLE = 1

export interface CandidateDatabaseKey {
  role: 'emoticon'
  salt: Buffer
  key: Buffer
}

export interface ReadCandidateKeyOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export function encodeSyntheticCandidateFrame(input: {
  salt: Uint8Array
  key: Uint8Array
}): Buffer {
  if (input.salt.byteLength !== 16) throw new TypeError('Candidate salt must be 16 bytes')
  if (input.key.byteLength !== 32) throw new TypeError('Candidate key must be 32 bytes')
  const frame = Buffer.alloc(FRAME_BYTES)
  MAGIC.copy(frame, 0)
  frame[4] = PROTOCOL_VERSION
  frame[5] = EMOTICON_ROLE
  frame.writeUInt16BE(0, 6)
  frame.set(input.salt, 8)
  frame.set(input.key, 24)
  return frame
}

export function clearCandidateDatabaseKey(candidate: CandidateDatabaseKey): void {
  candidate.key.fill(0)
  candidate.salt.fill(0)
}

export async function readCandidateDatabaseKey(
  stream: Readable,
  options: ReadCandidateKeyOptions = {},
): Promise<CandidateDatabaseKey> {
  return await new Promise<CandidateDatabaseKey>((resolve, reject) => {
    const frame = Buffer.alloc(FRAME_BYTES)
    let received = 0
    let settled = false

    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('close', onClose)
      stream.removeListener('error', onError)
      operation()
    }
    const fail = (message: string) => {
      frame.fill(0)
      finish(() => reject(new Error(message)))
    }
    const onAbort = () => {
      frame.fill(0)
      finish(() => reject(options.signal?.reason ?? new DOMException('Canceled', 'AbortError')))
    }
    const onError = () => fail('Candidate key pipe failed')
    const onEnd = () => {
      if (received !== FRAME_BYTES) fail('Candidate key pipe closed before a complete frame')
    }
    const onClose = () => {
      if (received !== FRAME_BYTES) fail('Candidate key pipe closed before a complete frame')
    }
    const onData = (chunk: Buffer) => {
      if (received + chunk.length > FRAME_BYTES) {
        chunk.fill(0)
        return fail('Candidate key pipe exceeded the frame limit')
      }
      chunk.copy(frame, received)
      received += chunk.length
      chunk.fill(0)
      if (received !== FRAME_BYTES) return

      if (
        !frame.subarray(0, 4).equals(MAGIC) ||
        frame[4] !== PROTOCOL_VERSION ||
        frame[5] !== EMOTICON_ROLE ||
        frame.readUInt16BE(6) !== 0
      ) {
        frame.fill(0)
        return finish(() => reject(new Error('Candidate key pipe returned an invalid frame')))
      }
      const salt = Buffer.from(frame.subarray(8, 24))
      const key = Buffer.from(frame.subarray(24, 56))
      frame.fill(0)
      finish(() => resolve({ role: 'emoticon', salt, key }))
    }
    const timer = setTimeout(
      () => fail('Candidate key pipe timed out'),
      options.timeoutMs ?? 30_000,
    )

    if (options.signal?.aborted) return onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('close', onClose)
    stream.once('error', onError)
  })
}
