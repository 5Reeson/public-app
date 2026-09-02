import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'

export const WECHAT4_READINESS_MARKER = Buffer.from('CMRDY001', 'ascii')

export interface NativeProcessEntry {
  pid: number
  processGroupId: number
  executablePath: string
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child)
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
}

export async function assertTemporaryAppOperationPaths(input: {
  originalAppPath: string
  sessionRoot: string
  copiedAppPath: string
  probePath: string
}): Promise<void> {
  const [originalApp, sessionRoot, copiedApp, probe] = await Promise.all([
    realpath(input.originalAppPath),
    realpath(input.sessionRoot),
    realpath(input.copiedAppPath),
    realpath(input.probePath),
  ])
  if (
    originalApp === copiedApp ||
    !isWithin(sessionRoot, copiedApp) ||
    !isWithin(sessionRoot, probe)
  ) {
    throw new Error('Gate F refused paths outside the current private session')
  }
  if (basename(copiedApp) !== 'WeChat.app') {
    throw new Error('Gate F copied app path did not match the session boundary')
  }

  const [sessionDetails, copiedDetails, probeDetails] = await Promise.all([
    stat(sessionRoot),
    lstat(copiedApp),
    lstat(probe),
  ])
  if (!sessionDetails.isDirectory() || (sessionDetails.mode & 0o077) !== 0) {
    throw new Error('Gate F session directory must be private')
  }
  if (!copiedDetails.isDirectory() || copiedDetails.isSymbolicLink()) {
    throw new Error('Gate F copied app must be a real directory')
  }
  if (!probeDetails.isFile() || probeDetails.isSymbolicLink()) {
    throw new Error('Gate F readiness probe must be a regular file')
  }
}

export const assertGateFOperationPaths = assertTemporaryAppOperationPaths

export function parseNativeProcessTable(output: string): NativeProcessEntry[] {
  const entries: NativeProcessEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match) continue
    const pid = Number(match[1])
    const processGroupId = Number(match[2])
    const executablePath = match[3]!
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(processGroupId)) continue
    entries.push({ pid, processGroupId, executablePath })
  }
  return entries
}

export function processesInsideApp(
  entries: readonly NativeProcessEntry[],
  appPath: string,
): NativeProcessEntry[] {
  const normalizedApp = resolve(appPath)
  return entries.filter((entry) => {
    const executable = resolve(entry.executablePath)
    return isWithin(normalizedApp, executable)
  })
}

export function commonWechatProcesses(
  entries: readonly NativeProcessEntry[],
): NativeProcessEntry[] {
  const names = new Set([
    'WeChat',
    'WeChatAppEx',
    'WeChatOCR',
    'WeChat Helper',
    'WeChat Helper (GPU)',
    'WeChat Helper (Plugin)',
    'WeChat Helper (Renderer)',
  ])
  return entries.filter((entry) => names.has(basename(entry.executablePath)))
}

export async function readWechat4Readiness(
  stream: Readable,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  return await new Promise<void>((resolveReadiness, reject) => {
    const marker = Buffer.alloc(WECHAT4_READINESS_MARKER.length)
    let received = 0
    let settled = false
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      stream.removeListener('data', onData)
      stream.removeListener('error', onError)
      stream.removeListener('end', onEnd)
      marker.fill(0)
      operation()
    }
    const fail = (message: string) => finish(() => reject(new Error(message)))
    const onAbort = () =>
      finish(() => reject(options.signal?.reason ?? new DOMException('Canceled', 'AbortError')))
    const onError = () => fail('Gate F readiness pipe failed')
    const onEnd = () => fail('Gate F readiness pipe closed early')
    const onData = (chunk: Buffer) => {
      const remaining = marker.length - received
      if (chunk.length > remaining) {
        chunk.fill(0)
        return fail('Gate F readiness pipe exceeded its fixed marker')
      }
      chunk.copy(marker, received)
      received += chunk.length
      chunk.fill(0)
      if (received !== marker.length) return
      if (!marker.equals(WECHAT4_READINESS_MARKER)) {
        return fail('Gate F readiness marker was invalid')
      }
      finish(resolveReadiness)
    }
    const timer = setTimeout(
      () => fail('Gate F readiness marker timed out'),
      options.timeoutMs ?? 10_000,
    )

    if (options.signal?.aborted) return onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('end', onEnd)
  })
}

export const WECHAT4_MARKER_BYTES = 8
const WECHAT4_MARKER_PATTERN = /^CM[A-Z0-9]{6}$/
const WECHAT4_MARKER_LIMIT = 4096

export interface Wechat4MarkerCollection {
  markers: string[]
  invalidMarkerObserved: boolean
  trailingBytes: number
  limitReached: boolean
}

/**
 * State markers are fixed 8-byte non-secret ASCII words. Parsing never throws:
 * the marker channel is diagnostic-only, so malformed input is surfaced as data
 * instead of failing the surrounding operation.
 */
export function parseWechat4Markers(buffer: Buffer): Wechat4MarkerCollection {
  const markers: string[] = []
  let invalidMarkerObserved = false
  const fullMarkers = Math.floor(buffer.length / WECHAT4_MARKER_BYTES)
  for (let index = 0; index < fullMarkers; index += 1) {
    if (markers.length >= WECHAT4_MARKER_LIMIT) {
      return {
        markers,
        invalidMarkerObserved,
        trailingBytes: buffer.length - index * WECHAT4_MARKER_BYTES,
        limitReached: true,
      }
    }
    const marker = buffer
      .subarray(index * WECHAT4_MARKER_BYTES, (index + 1) * WECHAT4_MARKER_BYTES)
      .toString('ascii')
    if (!WECHAT4_MARKER_PATTERN.test(marker)) {
      invalidMarkerObserved = true
      continue
    }
    markers.push(marker)
  }
  return {
    markers,
    invalidMarkerObserved,
    trailingBytes: buffer.length % WECHAT4_MARKER_BYTES,
    limitReached: false,
  }
}

export async function collectWechat4Markers(
  stream: Readable,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Wechat4MarkerCollection> {
  return await new Promise<Wechat4MarkerCollection>((resolveCollection) => {
    const chunks: Buffer[] = []
    let receivedBytes = 0
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('close', onEnd)
      stream.removeListener('error', onError)
      const parsed = parseWechat4Markers(Buffer.concat(chunks))
      for (const chunk of chunks) chunk.fill(0)
      resolveCollection(parsed)
    }
    const onAbort = () => finish()
    const onError = () => finish()
    const onEnd = () => finish()
    const onData = (chunk: Buffer) => {
      if (receivedBytes >= WECHAT4_MARKER_LIMIT * WECHAT4_MARKER_BYTES) {
        chunk.fill(0)
        return
      }
      chunks.push(Buffer.from(chunk))
      receivedBytes += chunk.length
      chunk.fill(0)
    }
    const timer = setTimeout(finish, options.timeoutMs ?? 30_000)

    if (options.signal?.aborted) return finish()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('close', onEnd)
    stream.once('error', onError)
  })
}
