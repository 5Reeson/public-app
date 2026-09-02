import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

const DEFAULT_GRACE_MS = 1_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000

export interface ProcessGroupLaunchOptions {
  executable: string
  arguments?: string[]
  cwd?: string
  environment?: Record<string, string>
  anonymousInputDescriptors?: number[]
  anonymousOutputDescriptors?: number[]
  /** Synthetic childless fixtures only; a real app must never weaken full-group termination. */
  allowLeaderSignalFallback?: boolean
  terminationGraceMs?: number
}

export interface ProcessGroupRunOptions extends ProcessGroupLaunchOptions {
  signal?: AbortSignal
  operationTimeoutMs?: number
}

export class ProcessGroupTimeoutError extends Error {
  constructor() {
    super('Temporary helper process group timed out')
    this.name = 'ProcessGroupTimeoutError'
  }
}

function signalGroup(groupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupId, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function groupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

async function waitForGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (groupExists(groupId)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, timeoutMs)))
  }
  return true
}

export class ManagedProcessGroup {
  readonly pid: number
  readonly input: Writable
  readonly controlOutput: Readable
  readonly candidateKeyPipe: Readable
  readonly anonymousInputs: ReadonlyMap<number, Writable>
  readonly anonymousOutputs: ReadonlyMap<number, Readable>

  private readonly child: ChildProcessWithoutNullStreams
  private readonly terminationGraceMs: number
  private readonly exitPromise: Promise<void>
  private readonly allowLeaderSignalFallback: boolean
  private terminating?: Promise<void>

  private constructor(
    child: ChildProcessWithoutNullStreams,
    terminationGraceMs: number,
    anonymousInputDescriptors: number[],
    anonymousOutputDescriptors: number[],
    allowLeaderSignalFallback: boolean,
  ) {
    if (child.pid === undefined) throw new Error('Temporary helper process did not receive a PID')
    const keyPipe = child.stdio[3]
    if (!keyPipe || typeof keyPipe === 'number' || !('on' in keyPipe)) {
      throw new Error('Temporary helper candidate-key pipe was not created')
    }
    this.child = child
    this.pid = child.pid
    this.input = child.stdin
    this.controlOutput = child.stdout
    this.candidateKeyPipe = keyPipe as Readable
    const anonymousInputs = new Map<number, Writable>()
    for (const descriptor of anonymousInputDescriptors) {
      const input = child.stdio[descriptor]
      if (!input || typeof input === 'number' || !('end' in input)) {
        throw new Error(`Temporary helper fd ${descriptor} input pipe was not created`)
      }
      anonymousInputs.set(descriptor, input as Writable)
    }
    this.anonymousInputs = anonymousInputs
    const anonymousOutputs = new Map<number, Readable>()
    for (const descriptor of anonymousOutputDescriptors) {
      const output = child.stdio[descriptor]
      if (!output || typeof output === 'number' || !('on' in output)) {
        throw new Error(`Temporary helper fd ${descriptor} output pipe was not created`)
      }
      anonymousOutputs.set(descriptor, output as Readable)
    }
    this.anonymousOutputs = anonymousOutputs
    this.terminationGraceMs = terminationGraceMs
    this.allowLeaderSignalFallback = allowLeaderSignalFallback
    this.exitPromise = new Promise((resolve) => child.once('close', () => resolve()))
    child.stderr.resume()
  }

  static async launch(options: ProcessGroupLaunchOptions): Promise<ManagedProcessGroup> {
    if (process.platform === 'win32') {
      throw new Error('Independent process groups require a POSIX host')
    }
    const anonymousInputDescriptors = [...new Set(options.anonymousInputDescriptors ?? [])].sort(
      (left, right) => left - right,
    )
    const anonymousOutputDescriptors = [...new Set(options.anonymousOutputDescriptors ?? [])].sort(
      (left, right) => left - right,
    )
    const allAnonymousDescriptors = [...anonymousInputDescriptors, ...anonymousOutputDescriptors]
    if (
      allAnonymousDescriptors.some(
        (descriptor) => !Number.isInteger(descriptor) || descriptor < 4 || descriptor > 16,
      ) ||
      new Set(allAnonymousDescriptors).size !== allAnonymousDescriptors.length
    ) {
      throw new Error('Anonymous descriptors must be unique integers between 4 and 16')
    }
    const highestDescriptor = Math.max(3, ...allAnonymousDescriptors)
    const stdio: Array<'pipe' | 'ignore'> = ['pipe', 'pipe', 'pipe', 'pipe']
    for (let descriptor = 4; descriptor <= highestDescriptor; descriptor += 1) {
      stdio[descriptor] = allAnonymousDescriptors.includes(descriptor) ? 'pipe' : 'ignore'
    }

    const child = spawn(options.executable, options.arguments ?? [], {
      cwd: options.cwd,
      detached: true,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C',
        CN_MEMES_CANDIDATE_KEY_FD: '3',
        ...options.environment,
      },
      stdio,
    }) as ChildProcessWithoutNullStreams

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    try {
      return new ManagedProcessGroup(
        child,
        options.terminationGraceMs ?? DEFAULT_GRACE_MS,
        anonymousInputDescriptors,
        anonymousOutputDescriptors,
        options.allowLeaderSignalFallback ?? false,
      )
    } catch (error) {
      signalGroup(child.pid!, 'SIGKILL')
      await new Promise<void>((resolve) => child.once('close', () => resolve()))
      throw error
    }
  }

  async terminate(): Promise<void> {
    if (this.terminating) return await this.terminating
    this.terminating = this.terminateInternal()
    return await this.terminating
  }

  async waitForExit(): Promise<void> {
    await this.exitPromise
  }

  private async terminateInternal(): Promise<void> {
    this.input.end()
    for (const input of this.anonymousInputs.values()) input.end()
    try {
      signalGroup(this.pid, 'SIGTERM')
    } catch (error) {
      const leaderAlreadyExited = this.child.exitCode !== null || this.child.signalCode !== null
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      if (leaderAlreadyExited) {
        await this.exitPromise
        this.destroyPipes()
        return
      }
      if (!this.allowLeaderSignalFallback) throw error
      await this.terminateLeaderOnly()
      this.destroyPipes()
      return
    }
    const groupExitedGracefully = await waitForGroupExit(this.pid, this.terminationGraceMs)
    if (!groupExitedGracefully) {
      signalGroup(this.pid, 'SIGKILL')
      const groupWasKilled = await waitForGroupExit(
        this.pid,
        Math.max(this.terminationGraceMs, 1_000),
      )
      if (!groupWasKilled) throw new Error('Temporary helper process group did not terminate')
    }
    await this.exitPromise
    this.destroyPipes()
  }

  private async terminateLeaderOnly(): Promise<void> {
    this.child.kill('SIGTERM')
    const exitedGracefully = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), this.terminationGraceMs)),
    ])
    if (!exitedGracefully) {
      this.child.kill('SIGKILL')
      await this.exitPromise
    }
  }

  private destroyPipes(): void {
    this.controlOutput.destroy()
    this.candidateKeyPipe.destroy()
    for (const input of this.anonymousInputs.values()) input.destroy()
    for (const output of this.anonymousOutputs.values()) output.destroy()
  }
}

export async function withManagedProcessGroup<T>(
  options: ProcessGroupRunOptions,
  operation: (group: ManagedProcessGroup, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const group = await ManagedProcessGroup.launch(options)
  const operationController = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let abortListener: (() => void) | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ProcessGroupTimeoutError()
        operationController.abort(error)
        reject(error)
      }, options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS)
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        const error = options.signal?.reason ?? new DOMException('Canceled', 'AbortError')
        operationController.abort(error)
        reject(error)
      }
      if (options.signal?.aborted) abortListener()
      else options.signal?.addEventListener('abort', abortListener, { once: true })
    })
    return await Promise.race([operation(group, operationController.signal), timeout, aborted])
  } finally {
    operationController.abort(new DOMException('Temporary helper finished', 'AbortError'))
    if (timer) clearTimeout(timer)
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    await group.terminate()
  }
}
