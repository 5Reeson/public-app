import type { Readable } from 'node:stream'

const TARGET_MAGIC = Buffer.from('CMS1', 'ascii')
const CANDIDATE_MAGIC = Buffer.from('CMK8', 'ascii')
const PROTOCOL_VERSION = 1
const AES_BLOCK_BYTES = 16
const MAX_TARGET_BLOCKS = 16
const TARGET_FRAME_BYTES = 8 + AES_BLOCK_BYTES * MAX_TARGET_BLOCKS
const CANDIDATE_FRAME_BYTES = 48

export interface Wechat4StoreKeyCandidate {
  key: Buffer
  targetIndex: number
  sourceMode: 'direct' | 'prefix-16' | 'suffix-16' | 'hex-decoded'
}

export interface ReadWechat4StoreKeyOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export function encodeWechat4StoreTargetFrame(blocks: readonly Uint8Array[]): Buffer {
  if (
    blocks.length === 0 ||
    blocks.length > MAX_TARGET_BLOCKS ||
    blocks.some((block) => block.byteLength !== AES_BLOCK_BYTES)
  ) {
    throw new TypeError('Store target frame requires 1-16 AES blocks')
  }
  const frame = Buffer.alloc(TARGET_FRAME_BYTES)
  TARGET_MAGIC.copy(frame, 0)
  frame[4] = PROTOCOL_VERSION
  frame[5] = blocks.length
  for (const [index, block] of blocks.entries()) frame.set(block, 8 + index * AES_BLOCK_BYTES)
  return frame
}

export function clearWechat4StoreKeyCandidate(candidate: Wechat4StoreKeyCandidate): void {
  candidate.key.fill(0)
  candidate.targetIndex = -1
}

export async function readWechat4StoreKeyCandidate(
  stream: Readable,
  options: ReadWechat4StoreKeyOptions = {},
): Promise<Wechat4StoreKeyCandidate> {
  return await new Promise<Wechat4StoreKeyCandidate>((resolve, reject) => {
    const frame = Buffer.alloc(CANDIDATE_FRAME_BYTES)
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
    const onError = () => fail('Store key pipe failed')
    const onEnd = () => {
      if (received !== CANDIDATE_FRAME_BYTES) {
        fail('Store key pipe closed before a complete frame')
      }
    }
    const onClose = onEnd
    const onData = (chunk: Buffer) => {
      if (received + chunk.length > CANDIDATE_FRAME_BYTES) {
        chunk.fill(0)
        return fail('Store key pipe exceeded the frame limit')
      }
      chunk.copy(frame, received)
      received += chunk.length
      chunk.fill(0)
      if (received !== CANDIDATE_FRAME_BYTES) return

      const targetIndex = frame[5]!
      const keyLength = frame[6]!
      const sourceModeValue = frame[7]!
      const sourceModes = ['direct', 'prefix-16', 'suffix-16', 'hex-decoded'] as const
      const sourceMode = sourceModes[sourceModeValue - 1]
      if (
        !frame.subarray(0, 4).equals(CANDIDATE_MAGIC) ||
        frame[4] !== PROTOCOL_VERSION ||
        targetIndex >= MAX_TARGET_BLOCKS ||
        ![16, 24, 32].includes(keyLength) ||
        sourceMode === undefined ||
        (sourceMode !== 'direct' && keyLength !== 16) ||
        frame.subarray(8 + keyLength).some((byte) => byte !== 0)
      ) {
        frame.fill(0)
        return finish(() => reject(new Error('Store key pipe returned an invalid frame')))
      }
      const key = Buffer.from(frame.subarray(8, 8 + keyLength))
      frame.fill(0)
      finish(() => resolve({ key, targetIndex, sourceMode }))
    }
    const timer = setTimeout(() => fail('Store key pipe timed out'), options.timeoutMs ?? 30_000)

    if (options.signal?.aborted) return onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('close', onClose)
    stream.once('error', onError)
  })
}
