import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Writable } from 'node:stream'

import {
  parseWechat4HelperResponse,
  WECHAT4_HELPER_MAX_LINE_BYTES,
  type Wechat4HelperRequest,
  type Wechat4HelperResponse,
} from './helper-protocol.js'
import {
  parseWechat4PersonalEmoticonCatalog,
  type Wechat4PersonalEmoticon,
} from './personal-emoticon-catalog.js'
import {
  parseWechat4StoreEmoticonCatalog,
  type Wechat4StoreEmoticon,
} from './store-emoticon-catalog.js'

const MAX_CATALOG_BYTES = 16 * 1024 * 1024

export interface Wechat4HelperRunnerOptions {
  executable: string
  arguments?: string[]
  timeoutMs?: number
  terminationGraceMs?: number
  signal?: AbortSignal
}

interface InternalRunnerOptions extends Wechat4HelperRunnerOptions {
  candidateFrame?: Buffer
  collectCatalog?: boolean
}

interface InternalRunnerResult {
  response: Wechat4HelperResponse
  catalog?: Buffer
}

async function runHelper(
  request: Wechat4HelperRequest,
  options: InternalRunnerOptions,
): Promise<InternalRunnerResult> {
  const serialized = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > WECHAT4_HELPER_MAX_LINE_BYTES) {
    throw new Error('WeChat 4 helper request exceeded the protocol limit')
  }

  return await new Promise<InternalRunnerResult>((resolve, reject) => {
    const stdio: 'pipe'[] = options.collectCatalog
      ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
      : options.candidateFrame
        ? ['pipe', 'pipe', 'pipe', 'pipe']
        : ['pipe', 'pipe', 'pipe']
    const child = spawn(options.executable, options.arguments ?? [], {
      stdio,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    }) as ChildProcessWithoutNullStreams
    const stdout: Buffer[] = []
    const catalog: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let catalogBytes = 0
    let settled = false
    let terminationReason: Error | undefined
    let killTimer: NodeJS.Timeout | undefined

    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      try {
        operation()
      } finally {
        for (const chunk of stdout) chunk.fill(0)
        for (const chunk of catalog) chunk.fill(0)
      }
    }
    const terminate = (reason: Error) => {
      if (terminationReason || settled) return
      terminationReason = reason
      if (child.exitCode === null) child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, options.terminationGraceMs ?? 250)
    }
    const onAbort = () => {
      const reason = options.signal?.reason
      terminate(reason instanceof Error ? reason : new DOMException('Canceled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      terminate(new Error('WeChat 4 helper timed out'))
    }, options.timeoutMs ?? 60_000)

    child.on('error', () => finish(() => reject(new Error('WeChat 4 helper could not start'))))
    child.stdin.on('error', () => undefined)
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > WECHAT4_HELPER_MAX_LINE_BYTES + 1) {
        chunk.fill(0)
        terminate(new Error('WeChat 4 helper response exceeded the protocol limit'))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      // Deliberately discard stderr. Only its bounded size affects process handling; raw native
      // diagnostics must never cross into renderer errors or logs.
      stderrBytes += chunk.length
      chunk.fill(0)
      if (stderrBytes > 16 * 1024) {
        terminate(new Error('WeChat 4 helper stderr exceeded the limit'))
      }
    })
    const catalogOutput = options.collectCatalog ? child.stdio[4] : undefined
    if (options.collectCatalog) {
      if (!catalogOutput || typeof catalogOutput === 'number' || !('on' in catalogOutput)) {
        terminate(new Error('WeChat 4 helper catalog pipe was not created'))
      } else {
        catalogOutput.on('data', (chunk: Buffer) => {
          catalogBytes += chunk.length
          if (catalogBytes > MAX_CATALOG_BYTES) {
            chunk.fill(0)
            terminate(new Error('WeChat 4 helper catalog exceeded the protocol limit'))
            return
          }
          catalog.push(Buffer.from(chunk))
          chunk.fill(0)
        })
        catalogOutput.once('error', () => {
          terminate(new Error('WeChat 4 helper catalog pipe failed'))
        })
      }
    }
    child.on('close', (code) => {
      finish(() => {
        if (terminationReason) return reject(terminationReason)
        if (code !== 0) return reject(new Error(`WeChat 4 helper exited with code ${code ?? -1}`))
        const lines = Buffer.concat(stdout).toString('utf8').split(/\r?\n/).filter(Boolean)
        if (lines.length !== 1) return reject(new Error('WeChat 4 helper returned invalid framing'))
        try {
          resolve({
            response: parseWechat4HelperResponse(lines[0]!),
            ...(options.collectCatalog ? { catalog: Buffer.concat(catalog) } : {}),
          })
        } catch (error) {
          reject(error)
        }
      })
    })

    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    if (!terminationReason && options.candidateFrame) {
      const candidateInput = child.stdio[3]
      if (!candidateInput || typeof candidateInput === 'number' || !('end' in candidateInput)) {
        terminate(new Error('WeChat 4 helper candidate pipe was not created'))
      } else {
        const writable = candidateInput as Writable
        writable.on('error', () => terminate(new Error('WeChat 4 helper candidate pipe failed')))
        writable.end(options.candidateFrame)
      }
    }
    if (!terminationReason) child.stdin.end(serialized)
    else child.stdin.destroy()
  })
}

export async function runWechat4Helper(
  request: Wechat4HelperRequest,
  options: Wechat4HelperRunnerOptions,
): Promise<Wechat4HelperResponse> {
  return (await runHelper(request, options)).response
}

export async function runWechat4HelperWithCandidateFrame(
  request: Wechat4HelperRequest & { method: 'validateCandidateFd' | 'schemaOverviewFd' },
  candidateFrame: Buffer,
  options: Wechat4HelperRunnerOptions,
): Promise<Wechat4HelperResponse> {
  try {
    if (candidateFrame.length !== 56) {
      throw new Error('WeChat 4 candidate frame must be exactly 56 bytes')
    }
    return (await runHelper(request, { ...options, candidateFrame })).response
  } finally {
    candidateFrame.fill(0)
  }
}

export interface Wechat4PersonalEmoticonHelperResult {
  response: Wechat4HelperResponse
  records: Wechat4PersonalEmoticon[]
}

/** fd 3 carries the candidate frame; sensitive selected rows return only over anonymous fd 4. */
export async function runWechat4HelperForPersonalEmoticons(
  request: Wechat4HelperRequest & { method: 'personalEmoticonsFd' },
  candidateFrame: Buffer,
  options: Wechat4HelperRunnerOptions,
): Promise<Wechat4PersonalEmoticonHelperResult> {
  let catalog: Buffer | undefined
  try {
    if (candidateFrame.length !== 56) {
      throw new Error('WeChat 4 candidate frame must be exactly 56 bytes')
    }
    const result = await runHelper(request, {
      ...options,
      candidateFrame,
      collectCatalog: true,
    })
    catalog = result.catalog
    if (!catalog) throw new Error('WeChat 4 helper catalog pipe returned no data')
    const records = result.response.ok ? parseWechat4PersonalEmoticonCatalog(catalog) : []
    return { response: result.response, records }
  } finally {
    candidateFrame.fill(0)
    catalog?.fill(0)
  }
}

export interface Wechat4StoreEmoticonHelperResult {
  response: Wechat4HelperResponse
  records: Wechat4StoreEmoticon[]
}

/** fd 3 carries the candidate frame; store container ranges return only over anonymous fd 4. */
export async function runWechat4HelperForStoreEmoticons(
  request: Wechat4HelperRequest & { method: 'storeEmoticonsFd' },
  candidateFrame: Buffer,
  options: Wechat4HelperRunnerOptions,
): Promise<Wechat4StoreEmoticonHelperResult> {
  let catalog: Buffer | undefined
  try {
    if (candidateFrame.length !== 56) {
      throw new Error('WeChat 4 candidate frame must be exactly 56 bytes')
    }
    const result = await runHelper(request, {
      ...options,
      candidateFrame,
      collectCatalog: true,
    })
    catalog = result.catalog
    if (!catalog) throw new Error('WeChat 4 helper catalog pipe returned no data')
    const records = result.response.ok ? parseWechat4StoreEmoticonCatalog(catalog) : []
    return { response: result.response, records }
  } finally {
    candidateFrame.fill(0)
    catalog?.fill(0)
  }
}
