import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type {
  ImportFailure,
  ImportProgress,
  ImportResult,
  LegacyWechatDownloadMode,
  LegacyWechatAccountView,
  LegacyWechatDiscoveryView,
  StickerCollection,
} from '../../../shared/domain.js'
import {
  LocalStickerSource,
  type ImportProgressHandler,
} from '../../library/local-sticker-source.js'
import { readFavArchive } from './fav-archive.js'

const ACCOUNT_DIRECTORY = /^[\da-f]{32}$/i
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const DOWNLOAD_ATTEMPTS = 3

interface DownloadPolicy {
  concurrency: number
  minimumIntervalMs: number
  maximumIntervalMs: number
}

const DOWNLOAD_POLICIES: Record<LegacyWechatDownloadMode, DownloadPolicy> = {
  default: { concurrency: 1, minimumIntervalMs: 500, maximumIntervalMs: 1_500 },
  fast: { concurrency: 4, minimumIntervalMs: 0, maximumIntervalMs: 0 },
  safe: { concurrency: 1, minimumIntervalMs: 1_500, maximumIntervalMs: 3_500 },
}

export const DEFAULT_LEGACY_WECHAT_ROOT = join(
  homedir(),
  'Library',
  'Containers',
  'com.tencent.xinWeChat',
  'Data',
  'Library',
  'Application Support',
  'com.tencent.xinWeChat',
  '2.0b4.0.9',
)

interface LegacyWechatAccount extends LegacyWechatAccountView {
  archivePath: string
}

export interface LegacyWechatImportRequest {
  accountId: string
  downloadMode: LegacyWechatDownloadMode
  collection: StickerCollection
  collectionDirectory: string
  maxItems?: number
  signal?: AbortSignal
}

export interface WechatLegacySourceOptions {
  root?: string
  fetcher?: typeof fetch
  random?: () => number
  sleeper?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

function accountId(directoryName: string): string {
  return `wechat-legacy-${createHash('sha256').update(directoryName).digest('hex').slice(0, 16)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, milliseconds)
    const handleAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Import canceled', 'AbortError'))
    }
    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

function randomInterval(policy: DownloadPolicy, random: () => number): number {
  if (policy.maximumIntervalMs === 0) return 0
  const sample = Math.min(1, Math.max(0, random()))
  return Math.round(
    policy.minimumIntervalMs + sample * (policy.maximumIntervalMs - policy.minimumIntervalMs),
  )
}

async function responseBytes(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    throw new Error('图片超过 20MB 安全上限')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('下载结果为空')
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('图片超过 20MB 安全上限')
  return bytes
}

export class WechatLegacySource {
  private readonly root: string
  private readonly fetcher: typeof fetch
  private readonly random: () => number
  private readonly sleeper: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly localSource = new LocalStickerSource()

  constructor(options: WechatLegacySourceOptions = {}) {
    this.root = options.root ?? DEFAULT_LEGACY_WECHAT_ROOT
    this.fetcher = options.fetcher ?? fetch
    this.random = options.random ?? Math.random
    this.sleeper = options.sleeper ?? delay
  }

  private async discoverInternal(): Promise<{
    rootFound: boolean
    permissionDenied: boolean
    accounts: LegacyWechatAccount[]
    failures: string[]
  }> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return { rootFound: false, permissionDenied: false, accounts: [], failures: [] }
      }
      if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM')) {
        return {
          rootFound: true,
          permissionDenied: true,
          accounts: [],
          failures: ['没有读取旧版微信数据目录的权限'],
        }
      }
      return {
        rootFound: true,
        permissionDenied: false,
        accounts: [],
        failures: ['无法读取旧版微信数据目录'],
      }
    }

    const candidates = entries
      .filter((entry) => entry.isDirectory() && ACCOUNT_DIRECTORY.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    const accounts: LegacyWechatAccount[] = []
    const failures: string[] = []

    for (const entry of candidates) {
      const archivePath = join(this.root, entry.name, 'Stickers', 'fav.archive')
      try {
        const details = await lstat(archivePath)
        if (!details.isFile() || details.isSymbolicLink()) continue
        const parsed = await readFavArchive(archivePath)
        accounts.push({
          id: accountId(entry.name),
          label: `旧版微信账号 ${entry.name.slice(-4)}`,
          stickerCount: parsed.urls.length,
          archiveBytes: details.size,
          archivePath,
        })
      } catch (error) {
        if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM')) {
          return {
            rootFound: true,
            permissionDenied: true,
            accounts: [],
            failures: ['没有读取旧版微信账号数据的权限'],
          }
        }
        if (!isNodeError(error, 'ENOENT')) {
          failures.push(`账号 · ${entry.name.slice(-4)}：无法读取收藏索引`)
        }
      }
    }

    return { rootFound: true, permissionDenied: false, accounts, failures }
  }

  async discover(): Promise<LegacyWechatDiscoveryView> {
    const result = await this.discoverInternal()
    return {
      rootFound: result.rootFound,
      permissionDenied: result.permissionDenied,
      accounts: result.accounts.map(({ archivePath: _archivePath, ...account }) => account),
      failures: result.failures,
    }
  }

  private async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    let lastError: unknown
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted()
      try {
        const timeoutSignal = AbortSignal.timeout(20_000)
        const response = await this.fetcher(url, {
          redirect: 'follow',
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        })
        return await responseBytes(response)
      } catch (error) {
        if (signal?.aborted) throw error
        lastError = error
        if (attempt < DOWNLOAD_ATTEMPTS) await this.sleeper(attempt * 250, signal)
      }
    }
    throw new Error('下载重试 3 次后仍失败', { cause: lastError })
  }

  async import(
    request: LegacyWechatImportRequest,
    onProgress?: ImportProgressHandler,
  ): Promise<ImportResult> {
    const discovery = await this.discoverInternal()
    const account = discovery.accounts.find((candidate) => candidate.id === request.accountId)
    if (!account) throw new Error('选择的旧版微信账号已不可用，请重新检测')
    const parsed = await readFavArchive(account.archivePath)
    request.signal?.throwIfAborted()
    if (parsed.urls.length === 0) throw new Error('该账号的 fav.archive 中没有可下载的收藏表情')
    const urls =
      request.maxItems === undefined ? parsed.urls : parsed.urls.slice(0, request.maxItems)
    const downloadPolicy = DOWNLOAD_POLICIES[request.downloadMode]

    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'cn-memes-wechat-legacy-'))
    await chmod(temporaryDirectory, 0o700)
    const downloadedByIndex: Array<string | undefined> = Array(urls.length)
    const labels = new Map<string, string>()
    const downloadFailuresByIndex: Array<ImportFailure | undefined> = Array(urls.length)
    let nextDownloadIndex = 0
    let completedDownloads = 0

    const report = async (progress: ImportProgress) => onProgress?.(progress)
    await report({
      completed: 0,
      total: urls.length,
      imported: 0,
      duplicates: 0,
      failed: 0,
      phase: 'downloading',
    })

    try {
      const downloadWorker = async () => {
        while (nextDownloadIndex < urls.length) {
          request.signal?.throwIfAborted()
          const index = nextDownloadIndex
          nextDownloadIndex += 1
          if (index > 0 && downloadPolicy.maximumIntervalMs > 0) {
            await this.sleeper(randomInterval(downloadPolicy, this.random), request.signal)
          }
          request.signal?.throwIfAborted()
          const url = urls[index]!
          const label = `微信表情 ${String(index + 1).padStart(4, '0')}`
          try {
            const bytes = await this.download(url, request.signal)
            const path = join(temporaryDirectory, `${String(index).padStart(6, '0')}.download`)
            await writeFile(path, bytes, { mode: 0o600 })
            await chmod(path, 0o600)
            downloadedByIndex[index] = path
            labels.set(path, label)
          } catch (error) {
            if (request.signal?.aborted) throw error
            downloadFailuresByIndex[index] = { path: label, reason: errorMessage(error) }
          }
          completedDownloads += 1
          await report({
            completed: completedDownloads,
            total: urls.length,
            imported: 0,
            duplicates: 0,
            failed: downloadFailuresByIndex.filter(Boolean).length,
            phase: 'downloading',
            currentPath: label,
          })
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(downloadPolicy.concurrency, urls.length) }, downloadWorker),
      )
      const downloaded = downloadedByIndex.filter((path): path is string => path !== undefined)
      const downloadFailures = downloadFailuresByIndex.filter(
        (failure): failure is ImportFailure => failure !== undefined,
      )

      const imported = await this.localSource.importAttributed(
        {
          collection: request.collection,
          collectionDirectory: request.collectionDirectory,
          inputs: downloaded,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
        {
          sourceKind: 'wechat-legacy',
          sourceAccountId: account.id,
          sourceLabel: account.label,
          sourceAlbum: { kind: 'personal', id: 'wechat-personal', name: '个人收藏' },
          displayName: (path) => labels.get(path) ?? basename(path),
        },
        async (progress) => {
          await report({
            ...progress,
            completed: downloadFailures.length + progress.completed,
            total: urls.length,
            failed: downloadFailures.length + progress.failed,
            phase: 'importing',
            ...(progress.currentPath === undefined
              ? {}
              : { currentPath: labels.get(progress.currentPath) ?? '微信表情' }),
          })
        },
      )

      request.signal?.throwIfAborted()
      const remapPath = (path: string) => labels.get(path) ?? '微信表情'
      await report({
        completed: urls.length,
        total: urls.length,
        imported: imported.assets.length,
        duplicates: imported.duplicates.length,
        failed: downloadFailures.length + imported.failures.length,
        phase: 'importing',
      })
      return {
        assets: imported.assets,
        sourceUpdates: imported.sourceUpdates,
        duplicates: imported.duplicates.map(remapPath),
        failures: [
          ...downloadFailures,
          ...imported.failures.map((failure) => ({
            path: remapPath(failure.path),
            reason: failure.reason,
          })),
        ],
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
