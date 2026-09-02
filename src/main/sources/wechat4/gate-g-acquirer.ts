import { execFile } from 'node:child_process'
import { chmod, copyFile, lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'

import type { Wechat4GateStatus } from '../../../shared/domain.js'
import {
  clearCandidateDatabaseKey,
  encodeSyntheticCandidateFrame,
  readCandidateDatabaseKey,
  type CandidateDatabaseKey,
} from './candidate-key-pipe.js'
import { runWechat4HelperWithCandidateFrame } from './helper-runner.js'
import {
  assertTemporaryAppOperationPaths,
  collectWechat4Markers,
  commonWechatProcesses,
  parseNativeProcessTable,
  processesInsideApp,
  type NativeProcessEntry,
  type Wechat4MarkerCollection,
} from './load-gate.js'
import { assertWechat4NativeArtifacts, type Wechat4NativeArtifacts } from './native-runtime.js'
import type { Wechat4PersonalEmoticonReadRequest } from './personal-emoticon-reader.js'
import { ManagedProcessGroup } from './process-group.js'
import { TemporaryWechatAppCopy } from './temporary-app-copy.js'

const execFileAsync = promisify(execFile)
const DEFAULT_ORIGINAL_APP = '/Applications/WeChat.app'
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MARKER_TAIL_MS = 15_000

export type Wechat4GateGErrorCode =
  | 'CANCELED'
  | 'WECHAT_UNAVAILABLE'
  | 'NATIVE_ARTIFACT_UNAVAILABLE'
  | 'ORIGINAL_QUIT_FAILED'
  | 'TEMPORARY_COPY_FAILED'
  | 'SIGNING_FAILED'
  | 'CANDIDATE_TIMEOUT'
  | 'CANDIDATE_INVALID'
  | 'VALIDATION_FAILED'
  | 'CLEANUP_FAILED'
  | 'ORIGINAL_RESTART_FAILED'

export class Wechat4GateGError extends Error {
  constructor(readonly code: Wechat4GateGErrorCode) {
    const messages: Record<Wechat4GateGErrorCode, string> = {
      CANCELED: '微信 4.x 授权导入已取消',
      WECHAT_UNAVAILABLE: '无法检查本机微信应用',
      NATIVE_ARTIFACT_UNAVAILABLE: '微信 4.x 原生组件不可用，请重新安装应用',
      ORIGINAL_QUIT_FAILED: '无法安全退出原微信，请手动完全退出后重试',
      TEMPORARY_COPY_FAILED: '无法创建隔离的微信临时副本',
      SIGNING_FAILED: '微信临时副本签名失败',
      CANDIDATE_TIMEOUT: '等待扫码和收藏数据库加载超时，请重试',
      CANDIDATE_INVALID: '未能安全取得微信表情数据库访问候选',
      VALIDATION_FAILED: '微信表情数据库访问验证失败',
      CLEANUP_FAILED: '微信临时副本未能完整清理，请退出应用后检查',
      ORIGINAL_RESTART_FAILED: '原微信未能自动重新打开，请手动启动微信',
    }
    super(messages[code])
    this.name = 'Wechat4GateGError'
  }
}

export interface Wechat4GateGAcquirerOptions {
  artifacts: Wechat4NativeArtifacts
  originalAppPath?: string
  candidateTimeoutMs?: number
  onStatus?: (status: Wechat4GateStatus) => void
  waitForFavoritesReady?: (signal?: AbortSignal) => Promise<void>
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child)
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
}

async function runSilent(
  executable: string,
  arguments_: string[],
  label: string,
  timeout = 30_000,
): Promise<void> {
  try {
    await execFileAsync(executable, arguments_, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout,
    })
  } catch (error) {
    throw new Error(label, { cause: error })
  }
}

async function codeDirectoryHash(appPath: string): Promise<string> {
  try {
    const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dvvv', appPath], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    })
    const hash = stderr.match(/^CDHash=([a-f0-9]+)$/m)?.[1]
    if (!hash) throw new Error('missing hash')
    return hash
  } catch (error) {
    throw new Error('original-signature-check', { cause: error })
  }
}

async function processTable(): Promise<NativeProcessEntry[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,comm='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  return parseNativeProcessTable(stdout)
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  return await predicate()
}

async function quitOriginalWechat(appPath: string): Promise<void> {
  const executablePath = await realpath(join(appPath, 'Contents', 'MacOS', 'WeChat'))
  const mainProcesses = processesInsideApp(await processTable(), appPath).filter(
    (entry) => resolve(entry.executablePath) === executablePath,
  )
  for (const entry of mainProcesses) {
    try {
      process.kill(entry.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const stopped = await waitUntil(
    async () => commonWechatProcesses(await processTable()).length === 0,
    20_000,
  )
  if (!stopped) throw new Error('original-processes-still-running')
}

async function restartOriginalWechat(appPath: string): Promise<boolean> {
  try {
    await runSilent('/usr/bin/open', [appPath], 'original-restart-request', 15_000)
    return await waitUntil(
      async () => processesInsideApp(await processTable(), appPath).length > 0,
      20_000,
    )
  } catch {
    return false
  }
}

async function signTemporaryArtifacts(appPath: string, dylibPath: string): Promise<void> {
  await runSilent(
    '/usr/bin/codesign',
    ['--force', '--sign', '-', '--timestamp=none', dylibPath],
    'interposer-signing',
    30_000,
  )
  await runSilent(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    'temporary-app-signing',
    120_000,
  )
  await runSilent(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', appPath],
    'temporary-signature-verification',
    60_000,
  )
}

async function verifiedTemporaryProcesses(appPath: string): Promise<NativeProcessEntry[]> {
  const appRoot = await realpath(appPath)
  const verified: NativeProcessEntry[] = []
  for (const candidate of processesInsideApp(await processTable(), appRoot)) {
    try {
      const executable = await realpath(candidate.executablePath)
      const details = await lstat(executable)
      if (details.isFile() && !details.isSymbolicLink() && isWithin(appRoot, executable)) {
        verified.push(candidate)
      }
    } catch {
      // The process may exit between table collection and path verification.
    }
  }
  return verified
}

async function signalTemporaryProcesses(appPath: string, signal: NodeJS.Signals): Promise<void> {
  for (const entry of await verifiedTemporaryProcesses(appPath)) {
    try {
      process.kill(entry.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

async function terminateTemporaryProcesses(appPath: string): Promise<void> {
  await signalTemporaryProcesses(appPath, 'SIGTERM')
  if (
    !(await waitUntil(async () => (await verifiedTemporaryProcesses(appPath)).length === 0, 1_000))
  ) {
    await signalTemporaryProcesses(appPath, 'SIGKILL')
  }
  if (
    !(await waitUntil(async () => (await verifiedTemporaryProcesses(appPath)).length === 0, 3_000))
  ) {
    throw new Error('temporary-process-cleanup')
  }
}

async function readDatabaseSalt(databasePath: string): Promise<Buffer> {
  const salt = Buffer.alloc(16)
  const handle = await open(databasePath, 'r')
  try {
    const { bytesRead } = await handle.read(salt, 0, salt.length, 0)
    if (bytesRead !== salt.length) throw new Error('snapshot-header-short')
    return salt
  } catch (error) {
    salt.fill(0)
    throw error
  } finally {
    await handle.close()
  }
}

async function writeAndClear(input: Writable, buffer: Buffer): Promise<void> {
  try {
    await new Promise<void>((resolveWrite, reject) => {
      const onError = () => reject(new Error('target-salt-pipe-failed'))
      input.once('error', onError)
      input.end(buffer, () => {
        input.removeListener('error', onError)
        resolveWrite()
      })
    })
  } finally {
    buffer.fill(0)
  }
}

function stageErrorCode(stage: string, error: unknown): Wechat4GateGErrorCode {
  if (error instanceof DOMException && error.name === 'AbortError') return 'CANCELED'
  if (stage === 'preparing') return 'WECHAT_UNAVAILABLE'
  if (stage === 'quitting-original') return 'ORIGINAL_QUIT_FAILED'
  if (stage === 'copying') return 'TEMPORARY_COPY_FAILED'
  if (stage === 'signing') return 'SIGNING_FAILED'
  if (stage === 'awaiting-qr') {
    const message = error instanceof Error ? error.message : ''
    return /timed out/i.test(message) ? 'CANDIDATE_TIMEOUT' : 'CANDIDATE_INVALID'
  }
  if (stage === 'validating') return 'VALIDATION_FAILED'
  return 'CANDIDATE_INVALID'
}

export class Wechat4GateGAcquirer {
  private readonly originalAppPath: string
  private readonly timeoutMs: number

  constructor(private readonly options: Wechat4GateGAcquirerOptions) {
    this.originalAppPath = resolve(options.originalAppPath ?? DEFAULT_ORIGINAL_APP)
    const requestedTimeout = options.candidateTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.timeoutMs =
      Number.isFinite(requestedTimeout) &&
      requestedTimeout >= 60_000 &&
      requestedTimeout <= 30 * 60_000
        ? Math.floor(requestedTimeout)
        : DEFAULT_TIMEOUT_MS
  }

  private emit(phase: Wechat4GateStatus['phase'], message: string): void {
    try {
      this.options.onStatus?.({ phase, message })
    } catch {
      // Renderer progress is best-effort and never controls the security boundary.
    }
  }

  async acquire(request: Wechat4PersonalEmoticonReadRequest): Promise<CandidateDatabaseKey> {
    if (process.platform !== 'darwin') throw new Wechat4GateGError('WECHAT_UNAVAILABLE')
    if (request.signal?.aborted) throw new Wechat4GateGError('CANCELED')

    let stage = 'preparing'
    let operationFailure: unknown
    let failureCode: Wechat4GateGErrorCode | undefined
    let originalHash = ''
    let originalLifecycleStarted = false
    let appCopy: TemporaryWechatAppCopy | undefined
    let copiedAppPath: string | undefined
    let group: ManagedProcessGroup | undefined
    let markerCollection: Promise<Wechat4MarkerCollection> | undefined
    let targetSalt: Buffer = Buffer.alloc(0)
    let candidate: CandidateDatabaseKey | undefined
    let cleanupFailed = false

    try {
      this.emit('preparing', '正在检查微信和本地原生组件')
      try {
        await assertWechat4NativeArtifacts(this.options.artifacts)
      } catch {
        throw new Wechat4GateGError('NATIVE_ARTIFACT_UNAVAILABLE')
      }
      originalHash = await codeDirectoryHash(this.originalAppPath)
      request.signal?.throwIfAborted()

      stage = 'quitting-original'
      originalLifecycleStarted = true
      this.emit('quitting-original', '正在安全退出原微信')
      await quitOriginalWechat(this.originalAppPath)
      request.signal?.throwIfAborted()

      stage = 'copying'
      this.emit('copying', '正在创建隔离的微信临时副本')
      targetSalt = await readDatabaseSalt(request.snapshot.databasePath)
      appCopy = await TemporaryWechatAppCopy.create({ sourceAppPath: this.originalAppPath })
      copiedAppPath = appCopy.appPath
      const dylibPath = join(appCopy.sessionRoot, 'libwechat4-emoticon-interposer.dylib')
      await copyFile(this.options.artifacts.interposerPath, dylibPath)
      await chmod(dylibPath, 0o700)
      await assertTemporaryAppOperationPaths({
        originalAppPath: this.originalAppPath,
        sessionRoot: appCopy.sessionRoot,
        copiedAppPath,
        probePath: dylibPath,
      })
      const executablePath = await realpath(join(copiedAppPath, 'Contents', 'MacOS', 'WeChat'))
      const copiedRoot = await realpath(copiedAppPath)
      if (
        !isWithin(copiedRoot, executablePath) ||
        executablePath ===
          (await realpath(join(this.originalAppPath, 'Contents', 'MacOS', 'WeChat')))
      ) {
        throw new Error('temporary-executable-boundary')
      }

      stage = 'signing'
      this.emit('signing', '正在签名临时副本；原微信不会被修改')
      await signTemporaryArtifacts(copiedAppPath, dylibPath)
      request.signal?.throwIfAborted()

      stage = 'awaiting-qr'
      group = await ManagedProcessGroup.launch({
        executable: executablePath,
        environment: { DYLD_INSERT_LIBRARIES: dylibPath },
        anonymousInputDescriptors: [4],
        anonymousOutputDescriptors: [7],
        terminationGraceMs: 1_000,
      })
      group.input.end()
      group.controlOutput.resume()
      const markerOutput = group.anonymousOutputs.get(7)
      const saltInput = group.anonymousInputs.get(4)
      if (!markerOutput || !saltInput) throw new Error('temporary-pipe-missing')
      markerCollection = collectWechat4Markers(markerOutput, {
        signal: request.signal,
        timeoutMs: this.timeoutMs + MARKER_TAIL_MS,
      })
      const saltForWrite = Buffer.from(targetSalt)
      targetSalt.fill(0)
      await writeAndClear(saltInput, saltForWrite)
      this.emit('awaiting-qr', '请在临时微信中扫码登录，并打开一次收藏表情面板')
      candidate = await readCandidateDatabaseKey(group.candidateKeyPipe, {
        signal: request.signal,
        timeoutMs: this.timeoutMs,
      })
      group.candidateKeyPipe.destroy()

      stage = 'validating'
      this.emit('validating', '已取得候选，正在执行数据库完整性校验')
      const validation = await runWechat4HelperWithCandidateFrame(
        {
          v: 1,
          id: `product-gate-g-${Date.now()}`,
          method: 'validateCandidateFd',
          params: { databasePath: request.snapshot.databasePath },
        },
        encodeSyntheticCandidateFrame(candidate),
        {
          executable: this.options.artifacts.helperPath,
          timeoutMs: 60_000,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      )
      if (
        !validation.ok ||
        validation.result.verified !== true ||
        validation.result.formatValidated !== true ||
        validation.result.cipherIntegrityValidated !== true ||
        validation.result.schemaQueryValidated !== true ||
        validation.result.quickCheckValidated !== true
      ) {
        throw new Error('candidate-validation-rejected')
      }

      if (this.options.waitForFavoritesReady) {
        stage = 'awaiting-favorites'
        this.emit(
          'awaiting-favorites',
          '数据库访问已验证；请打开收藏表情，等待内容显示后回到本应用继续',
        )
        await this.options.waitForFavoritesReady(request.signal)
        request.signal?.throwIfAborted()
      }
    } catch (error) {
      operationFailure = error
      failureCode = error instanceof Wechat4GateGError ? error.code : stageErrorCode(stage, error)
    } finally {
      this.emit('cleaning', '正在清理临时副本并恢复原微信')
      targetSalt.fill(0)
      if (group) {
        try {
          await group.terminate()
        } catch {
          cleanupFailed = true
        }
      }
      if (copiedAppPath) {
        try {
          await terminateTemporaryProcesses(copiedAppPath)
        } catch {
          cleanupFailed = true
        }
      }
      if (markerCollection) await markerCollection.catch(() => undefined)
      if (appCopy) {
        try {
          await appCopy.cleanup()
        } catch {
          cleanupFailed = true
        }
      }
      if (originalHash) {
        try {
          if ((await codeDirectoryHash(this.originalAppPath)) !== originalHash) cleanupFailed = true
        } catch {
          cleanupFailed = true
        }
      }
      if (originalLifecycleStarted && !(await restartOriginalWechat(this.originalAppPath))) {
        failureCode = 'ORIGINAL_RESTART_FAILED'
      }
    }

    if (request.signal?.aborted) failureCode = 'CANCELED'
    if (cleanupFailed) failureCode = 'CLEANUP_FAILED'
    if (operationFailure || failureCode || !candidate) {
      if (candidate) clearCandidateDatabaseKey(candidate)
      const error = new Wechat4GateGError(failureCode ?? 'CANDIDATE_INVALID')
      this.emit(error.code === 'CANCELED' ? 'canceled' : 'failed', error.message)
      throw error
    }

    this.emit('complete', '微信数据库访问验证完成，正在导入收藏表情')
    return candidate
  }
}
