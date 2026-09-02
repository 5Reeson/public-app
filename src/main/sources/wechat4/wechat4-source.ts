import { createDecipheriv, createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type {
  ImportFailure,
  ImportProgress,
  ImportResult,
  StickerCollection,
  StickerSourceKind,
  WechatDownloadMode,
  Wechat4OfficialAlbumView,
} from '../../../shared/domain.js'
import { clearCandidateDatabaseKey } from './candidate-key-pipe.js'
import {
  LocalStickerSource,
  type ImportProgressHandler,
  validateLocalStickerFile,
} from '../../library/local-sticker-source.js'
import {
  clearWechat4PersonalEmoticonCatalog,
  type Wechat4PersonalEmoticon,
} from './personal-emoticon-catalog.js'
import type { Wechat4HelperRunnerOptions } from './helper-runner.js'
import {
  HelperWechat4PersonalEmoticonReader,
  type AcquireWechat4Candidate,
  type Wechat4CandidateStore,
  type Wechat4PersonalEmoticonReader,
} from './personal-emoticon-reader.js'
import {
  HelperWechat4StoreEmoticonCatalogReader,
  LocalWechat4OfficialEmoticonStager,
  type Wechat4StoreEmoticonCatalogReader,
  type Wechat4OfficialEmoticonStager,
} from './store-emoticon-reader.js'
import { clearWechat4StoreEmoticonCatalog } from './store-emoticon-catalog.js'
import { Wechat4KeyStore } from './wechat4-key-store.js'
import { Wechat4StoreKeyStore } from './wechat4-store-key-store.js'
import {
  DEFAULT_WECHAT4_ROOT,
  discoverWechat4,
  removeWechat4Snapshot,
  resolveWechat4EmoticonCaches,
  resolveWechat4StoreLayout,
  snapshotWechat4Database,
} from './wechat4-layout.js'

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const DOWNLOAD_ATTEMPTS = 2
const RECORD_RESOLUTION_TIMEOUT_MS = 45_000

export interface Wechat4ImportRequest {
  accountId: string
  sourceLabel?: string
  collection: StickerCollection
  collectionDirectory: string
  maxItems?: number
  downloadMode?: WechatDownloadMode
  signal?: AbortSignal
}

export interface Wechat4SourceOptions {
  catalogReader: Wechat4PersonalEmoticonReader
  officialCatalogReader?: Wechat4StoreEmoticonCatalogReader
  officialStager?: Wechat4OfficialEmoticonStager
  authorizationStore?: Wechat4CandidateStore
  root?: string
  fetcher?: typeof fetch
  temporaryParent?: string
  sleeper?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  /** Product mode may refresh live metadata when a valid cached key only exposes empty rows. */
  refreshMissingMetadata?: boolean
  resolutionConcurrency?: number
}

export interface ProductWechat4SourceOptions extends Omit<Wechat4SourceOptions, 'catalogReader'> {
  helper: Wechat4HelperRunnerOptions
  keyStoreDirectory: string
  acquireCandidate: AcquireWechat4Candidate
}

/** Wires the data adapter to Gate G acquisition and macOS Keychain-backed candidate caching. */
export function createProductWechat4StickerSource(
  options: ProductWechat4SourceOptions,
): Wechat4StickerSource {
  const candidateStore = new Wechat4KeyStore(options.keyStoreDirectory)
  const catalogReader = new HelperWechat4PersonalEmoticonReader({
    helper: options.helper,
    candidateStore,
    acquireCandidate: options.acquireCandidate,
  })
  const officialCatalogReader = new HelperWechat4StoreEmoticonCatalogReader({
    helper: options.helper,
    candidateStore,
  })
  const officialStager = new LocalWechat4OfficialEmoticonStager({
    catalogReader: officialCatalogReader,
    keyStore: new Wechat4StoreKeyStore(options.keyStoreDirectory),
    ...(options.root === undefined ? {} : { root: options.root }),
  })
  return new Wechat4StickerSource({
    catalogReader,
    officialCatalogReader,
    officialStager,
    authorizationStore: candidateStore,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.temporaryParent === undefined ? {} : { temporaryParent: options.temporaryParent }),
    ...(options.sleeper === undefined ? {} : { sleeper: options.sleeper }),
    refreshMissingMetadata: true,
    resolutionConcurrency: options.resolutionConcurrency ?? 6,
  })
}

interface RemoteCandidate {
  url: string
  aesKey?: string
  verifyMd5: boolean
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Import canceled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function remoteConcurrencyForDownloadMode(
  mode: WechatDownloadMode | undefined,
  configuredConcurrency: number,
): number {
  if (mode === 'safe') return 1
  if (mode === 'default') return Math.min(4, configuredConcurrency)
  return configuredConcurrency
}

function concurrencyLimiter(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async function runLimited<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await operation()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

function safeHttpsUrl(value: string): string | undefined {
  if (!value || Buffer.byteLength(value, 'utf8') > 16 * 1024) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    return parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

function extractedHttpsUrls(value: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    const url = safeHttpsUrl(match[0])
    if (url && !seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }
  return urls
}

function remoteUrlScore(value: string): number {
  const url = value.toLowerCase()
  let score = url.includes('/stodownload') ? 1_000 : 0
  if (url.includes('wxapp.tc.qq.com')) score += 500
  else if (url.includes('vweixinf.tc.qq.com')) score += 400
  if (url.includes('filekey=')) score += 100
  if (/[?&]m=/.test(url)) score += 50
  if (url.includes('mmbiz.qpic.cn')) score -= 300
  if (url.includes('/mmemoticon/')) score -= 100
  return score
}

function downloadUrlVariants(value: string): string[] {
  const variants: string[] = []
  const seen = new Set<string>()
  const add = (url: URL) => {
    const serialized = safeHttpsUrl(url.toString())
    if (!serialized || seen.has(serialized)) return
    seen.add(serialized)
    variants.push(serialized)
  }
  const original = new URL(value)
  add(original)
  if (original.hostname === 'vweixinf.tc.qq.com') {
    const alternateHost = new URL(original)
    alternateHost.hostname = 'wxapp.tc.qq.com'
    add(alternateHost)
  }
  if (/\/stodownload(?:\.[a-z0-9]+)?$/i.test(original.pathname)) {
    for (const extension of ['gif', 'jpg', 'png', 'webp']) {
      const withExtension = new URL(original)
      withExtension.pathname = withExtension.pathname.replace(
        /\/stodownload(?:\.[a-z0-9]+)?$/i,
        `/stodownload.${extension}`,
      )
      add(withExtension)
      if (withExtension.hostname === 'vweixinf.tc.qq.com') {
        const alternateHost = new URL(withExtension)
        alternateHost.hostname = 'wxapp.tc.qq.com'
        add(alternateHost)
      }
    }
  }
  return variants
}

function remoteCandidates(record: Wechat4PersonalEmoticon): RemoteCandidate[] {
  const candidates: RemoteCandidate[] = []
  const seen = new Set<string>()
  const add = (value: string, verifyMd5: boolean, aesKey?: string) => {
    const urls = extractedHttpsUrls(value).sort(
      (left, right) => remoteUrlScore(right) - remoteUrlScore(left),
    )
    for (const extracted of urls) {
      for (const url of downloadUrlVariants(extracted)) {
        const identity = `${url}\0${verifyMd5 ? 'full' : 'thumb'}\0${aesKey ?? ''}`
        if (seen.has(identity)) continue
        seen.add(identity)
        candidates.push({ url, verifyMd5, ...(aesKey ? { aesKey } : {}) })
      }
    }
  }
  add(record.cdnUrl, true)
  add(record.tpUrl, true)
  add(record.externUrl, true)
  add(record.encryptUrl, true, record.aesKey)
  add(record.thumbUrl, false)
  return candidates
}

function aesKeyBytes(value: string): Buffer | undefined {
  if (/^[a-f0-9]{32}$/i.test(value)) return Buffer.from(value, 'hex')
  if (Buffer.byteLength(value, 'utf8') === 16) return Buffer.from(value, 'utf8')
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  if (/^[A-Za-z0-9+/]{22}={0,2}$/.test(normalized)) {
    const decoded = Buffer.from(normalized, 'base64')
    if (decoded.length === 16) return decoded
    decoded.fill(0)
  }
  return undefined
}

function decryptEmoticon(bytes: Buffer, encodedKey: string): Buffer {
  const key = aesKeyBytes(encodedKey)
  if (!key || bytes.length === 0 || bytes.length % 16 !== 0) {
    key?.fill(0)
    throw new Error('Encrypted CDN asset metadata is unsupported')
  }
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, key)
    decipher.setAutoPadding(false)
    return Buffer.concat([decipher.update(bytes), decipher.final()])
  } finally {
    key.fill(0)
  }
}

function embeddedImage(bytes: Buffer): Buffer | undefined {
  const candidates: Array<{ start: number; end: number }> = []
  const pngStart = bytes.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (pngStart >= 0) {
    let position = pngStart + 8
    while (position + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(position)
      const end = position + 12 + length
      if (end > bytes.length) break
      if (bytes.subarray(position + 4, position + 8).equals(Buffer.from('IEND'))) {
        candidates.push({ start: pngStart, end })
        break
      }
      position = end
    }
  }
  for (const signature of [Buffer.from('GIF87a'), Buffer.from('GIF89a')]) {
    const start = bytes.indexOf(signature)
    const end = start >= 0 ? bytes.lastIndexOf(0x3b) + 1 : 0
    if (start >= 0 && end > start) candidates.push({ start, end })
  }
  const jpegStart = bytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
  if (jpegStart >= 0) {
    const jpegEndMarker = bytes.indexOf(Buffer.from([0xff, 0xd9]), jpegStart + 3)
    if (jpegEndMarker >= 0) candidates.push({ start: jpegStart, end: jpegEndMarker + 2 })
  }
  let webpStart = bytes.indexOf(Buffer.from('RIFF'))
  while (webpStart >= 0 && webpStart + 12 <= bytes.length) {
    if (bytes.subarray(webpStart + 8, webpStart + 12).equals(Buffer.from('WEBP'))) {
      const end = webpStart + 8 + bytes.readUInt32LE(webpStart + 4)
      if (end <= bytes.length) candidates.push({ start: webpStart, end })
      break
    }
    webpStart = bytes.indexOf(Buffer.from('RIFF'), webpStart + 4)
  }
  const match = candidates.sort((left, right) => left.start - right.start)[0]
  return match ? Buffer.from(bytes.subarray(match.start, match.end)) : undefined
}

function md5MatchedPayload(bytes: Buffer, expectedMd5: string): Buffer | undefined {
  if (contentMd5(bytes) === expectedMd5) return bytes
  const embedded = embeddedImage(bytes)
  if (embedded) {
    if (contentMd5(embedded) === expectedMd5) return embedded
    embedded.fill(0)
  }
  for (let trim = 1; trim <= 15 && trim < bytes.length; trim += 1) {
    const candidate = bytes.subarray(0, bytes.length - trim)
    if (contentMd5(candidate) === expectedMd5) return Buffer.from(candidate)
  }
  return undefined
}

function contentMd5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

async function firstValidCache(
  candidates: Array<{ path?: string; expectedMd5?: string }>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate.path) continue
    try {
      await validateLocalStickerFile(candidate.path)
      if (candidate.expectedMd5) {
        const bytes = await readFile(candidate.path)
        try {
          if (contentMd5(bytes) !== candidate.expectedMd5) continue
        } finally {
          bytes.fill(0)
        }
      }
      return candidate.path
    } catch {
      // A stale or partial cache entry falls through to the next local/remote candidate.
    }
  }
  return undefined
}

async function firstDecryptedCache(
  candidates: Array<{ path?: string; expectedMd5?: string }>,
  encodedKeys: readonly string[],
): Promise<Buffer | undefined> {
  const keys = [...new Set(encodedKeys)].filter((value) => {
    const decoded = aesKeyBytes(value)
    decoded?.fill(0)
    return decoded !== undefined
  })
  if (keys.length === 0) return undefined
  for (const candidate of candidates) {
    if (!candidate.path) continue
    let encrypted: Buffer | undefined
    try {
      encrypted = await readFile(candidate.path)
      if (encrypted.length === 0 || encrypted.length > MAX_DOWNLOAD_BYTES) continue
      if (candidate.expectedMd5) {
        const embedded = md5MatchedPayload(encrypted, candidate.expectedMd5)
        if (embedded) return embedded
      }
      for (const encodedKey of keys) {
        let decrypted: Buffer | undefined
        try {
          decrypted = decryptEmoticon(encrypted, encodedKey)
          if (!candidate.expectedMd5) return decrypted
          const matched = md5MatchedPayload(decrypted, candidate.expectedMd5)
          if (matched) {
            if (matched !== decrypted) decrypted.fill(0)
            return matched
          }
        } catch {
          // Try the next candidate key.
        }
        decrypted?.fill(0)
      }
    } catch {
      // A stale, unsupported, or wrong-key cache entry falls through without exposing details.
    } finally {
      encrypted?.fill(0)
    }
  }
  return undefined
}

async function stageValidatedAsset(
  stagingDirectory: string,
  fileName: string,
  bytes: Buffer,
): Promise<string | undefined> {
  const path = join(stagingDirectory, fileName)
  try {
    await writeFile(path, bytes, { mode: 0o600 })
    await chmod(path, 0o600)
    await validateLocalStickerFile(path)
    return path
  } catch {
    await rm(path, { force: true })
    return undefined
  } finally {
    bytes.fill(0)
  }
}

async function responseBytes(response: Response): Promise<Buffer> {
  if (!response.ok) {
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new RetryableCdnError()
    }
    throw new TerminalCdnError()
  }
  if (response.url && !safeHttpsUrl(response.url)) throw new Error('CDN redirect was not HTTPS')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error('CDN asset exceeded the size limit')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_DOWNLOAD_BYTES) {
    bytes.fill(0)
    throw new Error('CDN asset size was invalid')
  }
  return bytes
}

class RetryableCdnError extends Error {}
class TerminalCdnError extends Error {}

export class Wechat4StickerSource {
  readonly kind: StickerSourceKind = 'wechat4'
  private readonly root: string
  private readonly fetcher: typeof fetch
  private readonly temporaryParent: string
  private readonly sleeper: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly refreshMissingMetadata: boolean
  private readonly resolutionConcurrency: number
  private readonly localSource = new LocalStickerSource()

  constructor(private readonly options: Wechat4SourceOptions) {
    this.root = options.root ?? DEFAULT_WECHAT4_ROOT
    this.fetcher = options.fetcher ?? fetch
    this.temporaryParent = options.temporaryParent ?? tmpdir()
    this.sleeper = options.sleeper ?? delay
    this.refreshMissingMetadata = options.refreshMissingMetadata ?? false
    this.resolutionConcurrency = Math.max(
      1,
      Math.min(8, Math.floor(options.resolutionConcurrency ?? 1)),
    )
  }

  discover() {
    return discoverWechat4(this.root)
  }

  async hasCachedAuthorization(accountId: string): Promise<boolean> {
    if (!this.options.authorizationStore) return false
    const candidate = await this.options.authorizationStore.load(accountId).catch(() => undefined)
    if (!candidate) return false
    clearCandidateDatabaseKey(candidate)
    return true
  }

  async listOfficialAlbums(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<Wechat4OfficialAlbumView[]> {
    if (!this.options.officialCatalogReader) return []
    const snapshot = await snapshotWechat4Database(accountId, {
      root: this.root,
      ...(signal === undefined ? {} : { signal }),
      temporaryParent: this.temporaryParent,
    })
    let records: Awaited<ReturnType<Wechat4StoreEmoticonCatalogReader['read']>> = []
    try {
      records = await this.options.officialCatalogReader.read({
        accountId,
        snapshot,
        ...(signal === undefined ? {} : { signal }),
      })
      const packageIds = [...new Set(records.map((record) => record.packageId))]
      const layout = await resolveWechat4StoreLayout(accountId, packageIds, this.root)
      const albums = new Map<string, Wechat4OfficialAlbumView>()
      for (const record of records) {
        const current = albums.get(record.packageId)
        if (current) current.stickerCount += 1
        else {
          albums.set(record.packageId, {
            packageId: record.packageId,
            name: record.packageName,
            stickerCount: 1,
            cached: layout.containers.has(record.packageId),
          })
        }
      }
      return [...albums.values()]
    } finally {
      clearWechat4StoreEmoticonCatalog(records)
      await removeWechat4Snapshot(snapshot)
    }
  }

  async importOfficialAlbums(
    request: Wechat4ImportRequest & {
      packageIds: readonly string[]
      maxItemsPerPackage?: number
    },
    onProgress?: ImportProgressHandler,
  ): Promise<ImportResult> {
    if (!this.options.officialStager) throw new Error('当前版本不支持官方表情专辑')
    const snapshot = await snapshotWechat4Database(request.accountId, {
      root: this.root,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      temporaryParent: this.temporaryParent,
    })
    const stagingDirectory = await mkdtemp(join(this.temporaryParent, 'cn-memes-wechat4-official-'))
    await chmod(stagingDirectory, 0o700)
    try {
      const staged = await this.options.officialStager.stage({
        accountId: request.accountId,
        snapshot,
        stagingDirectory,
        packageIds: request.packageIds,
        ...(request.maxItemsPerPackage === undefined
          ? {}
          : { maxItemsPerPackage: request.maxItemsPerPackage }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      const byPath = new Map(staged.map((asset) => [asset.path, asset]))
      return await this.localSource.importAttributed(
        {
          collection: request.collection,
          collectionDirectory: request.collectionDirectory,
          inputs: staged.map((asset) => asset.path),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
        {
          sourceKind: this.kind,
          sourceAccountId: request.accountId,
          sourceLabel: request.sourceLabel,
          sourceAlbum: (path) => {
            const asset = byPath.get(path)
            return asset
              ? { kind: 'official', id: asset.packageId, name: asset.packageName }
              : undefined
          },
          displayName: (path) => byPath.get(path)?.label ?? basename(path),
        },
        onProgress,
      )
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true })
      await removeWechat4Snapshot(snapshot)
    }
  }

  private async downloadCandidate(
    candidate: RemoteCandidate,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    let lastFailure: unknown
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted()
      try {
        const timeout = AbortSignal.timeout(20_000)
        const response = await this.fetcher(candidate.url, {
          redirect: 'follow',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
        const downloaded = await responseBytes(response)
        if (!candidate.aesKey) return downloaded
        try {
          return decryptEmoticon(downloaded, candidate.aesKey)
        } finally {
          downloaded.fill(0)
        }
      } catch (error) {
        if (signal?.aborted) throw error
        lastFailure = error
        if (error instanceof TerminalCdnError) break
        if (attempt < DOWNLOAD_ATTEMPTS) await this.sleeper(attempt * 250, signal)
      }
    }
    throw new Error('CDN candidate failed after retries', { cause: lastFailure })
  }

  private async downloadRecord(
    record: Wechat4PersonalEmoticon,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const recordTimeout = AbortSignal.timeout(RECORD_RESOLUTION_TIMEOUT_MS)
    const recordSignal = signal ? AbortSignal.any([signal, recordTimeout]) : recordTimeout
    let lastFailure: unknown
    for (const candidate of remoteCandidates(record)) {
      try {
        const bytes = await this.downloadCandidate(candidate, recordSignal)
        if (candidate.verifyMd5) {
          const matched = md5MatchedPayload(bytes, record.md5)
          if (!matched) {
            bytes.fill(0)
            throw new Error('CDN asset hash did not match')
          }
          if (matched !== bytes) bytes.fill(0)
          return matched
        }
        return bytes
      } catch (error) {
        if (recordSignal.aborted) throw error
        lastFailure = error
      }
    }
    throw new Error('No usable CDN candidate', { cause: lastFailure })
  }

  async import(
    request: Wechat4ImportRequest,
    onProgress?: ImportProgressHandler,
  ): Promise<ImportResult> {
    const snapshots = [] as Awaited<ReturnType<typeof snapshotWechat4Database>>[]
    let snapshot = await snapshotWechat4Database(request.accountId, {
      root: this.root,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      temporaryParent: this.temporaryParent,
    })
    snapshots.push(snapshot)
    let records: Wechat4PersonalEmoticon[] = []
    let stagingDirectory: string | undefined
    try {
      records = await this.options.catalogReader.read({
        accountId: request.accountId,
        snapshot,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      if (request.maxItems !== undefined) records = records.slice(0, request.maxItems)
      request.signal?.throwIfAborted()
      let cachePaths = await resolveWechat4EmoticonCaches(
        request.accountId,
        records.map((record) => record.md5),
        this.root,
      )
      const needsLiveMetadataRefresh =
        this.refreshMissingMetadata &&
        records.every((record) => {
          const cache = cachePaths.get(record.md5)
          return !cache?.persistPath && !cache?.thumbPath && remoteCandidates(record).length === 0
        })
      if (needsLiveMetadataRefresh) {
        clearWechat4PersonalEmoticonCatalog(records)
        const staleRecords = await this.options.catalogReader.read({
          accountId: request.accountId,
          snapshot,
          forceAcquire: true,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        clearWechat4PersonalEmoticonCatalog(staleRecords)
        request.signal?.throwIfAborted()

        snapshot = await snapshotWechat4Database(request.accountId, {
          root: this.root,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          temporaryParent: this.temporaryParent,
        })
        snapshots.push(snapshot)
        records = await this.options.catalogReader.read({
          accountId: request.accountId,
          snapshot,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        if (request.maxItems !== undefined) records = records.slice(0, request.maxItems)
        cachePaths = await resolveWechat4EmoticonCaches(
          request.accountId,
          records.map((record) => record.md5),
          this.root,
        )
      }

      const activeStagingDirectory = await mkdtemp(
        join(this.temporaryParent, 'cn-memes-wechat4-assets-'),
      )
      stagingDirectory = activeStagingDirectory
      await chmod(activeStagingDirectory, 0o700)
      const inputs: string[] = []
      const resolvedInputs = new Array<string | undefined>(records.length)
      const labels = new Map<string, string>()
      const failureByIndex = new Array<ImportFailure | undefined>(records.length)
      if (records.length === 0) {
        throw new Error('该账号没有可导入的微信表情')
      }
      const runRemoteDownload = concurrencyLimiter(
        remoteConcurrencyForDownloadMode(request.downloadMode, this.resolutionConcurrency),
      )
      let completed = 0
      const resolutionTotal = records.length
      const report = async (currentPath?: string) => {
        await onProgress?.({
          completed,
          total: resolutionTotal,
          imported: 0,
          duplicates: 0,
          failed: failureByIndex.filter(Boolean).length,
          phase: 'downloading',
          ...(currentPath ? { currentPath } : {}),
        })
      }
      await report()

      const resolveRecord = async (index: number) => {
        const record = records[index]!
        request.signal?.throwIfAborted()
        const label = `微信表情 ${String(index + 1).padStart(4, '0')}`
        let fixedFailureReason = '本地缓存和 CDN 均不可用'
        try {
          const cache = cachePaths.get(record.md5) ?? {}
          const supportedCacheKeys = [record.aesKey, record.authKey].filter((value) => {
            const decoded = aesKeyBytes(value)
            decoded?.fill(0)
            return decoded !== undefined
          })
          const hasRemoteMetadata = [
            record.cdnUrl,
            record.tpUrl,
            record.externUrl,
            record.encryptUrl,
            record.thumbUrl,
          ].some(Boolean)
          if (cache.persistPath && supportedCacheKeys.length === 0) {
            fixedFailureReason = '本地缓存已加密，但记录没有受支持的解密 key'
          } else if (cache.persistPath) {
            fixedFailureReason = '本地缓存解密校验失败，CDN 回退不可用'
          } else if (hasRemoteMetadata && remoteCandidates(record).length === 0) {
            fixedFailureReason = 'CDN 元数据无法安全转换为 HTTPS 地址'
          }
          const localPath = await firstValidCache([
            { path: cache.persistPath, expectedMd5: record.md5 },
            { path: cache.thumbPath },
          ])
          if (localPath) {
            resolvedInputs[index] = localPath
            labels.set(localPath, label)
          } else {
            const cacheBytes = await firstDecryptedCache(
              [{ path: cache.persistPath, expectedMd5: record.md5 }],
              supportedCacheKeys,
            )
            const decryptedCachePath = cacheBytes
              ? await stageValidatedAsset(
                  activeStagingDirectory,
                  `${String(index).padStart(6, '0')}-cache.asset`,
                  cacheBytes,
                )
              : undefined
            if (decryptedCachePath) {
              resolvedInputs[index] = decryptedCachePath
              labels.set(decryptedCachePath, label)
            } else {
              const bytes = await runRemoteDownload(() =>
                this.downloadRecord(record, request.signal),
              )
              const path = await stageValidatedAsset(
                activeStagingDirectory,
                `${String(index).padStart(6, '0')}-remote.asset`,
                bytes,
              )
              if (!path) throw new Error('Downloaded CDN candidate was not a valid image')
              resolvedInputs[index] = path
              labels.set(path, label)
            }
          }
        } catch (error) {
          if (request.signal?.aborted) throw error
          failureByIndex[index] = { path: label, reason: fixedFailureReason }
        }
        completed += 1
        await report(label)
      }

      let nextRecordIndex = 0
      const worker = async () => {
        while (true) {
          const index = nextRecordIndex
          nextRecordIndex += 1
          if (index >= records.length) return
          await resolveRecord(index)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(this.resolutionConcurrency, records.length) }, worker),
      )
      inputs.push(...resolvedInputs.filter((path): path is string => path !== undefined))
      const resolutionFailures = failureByIndex.filter(
        (failure): failure is ImportFailure => failure !== undefined,
      )

      const imported = await this.localSource.importAttributed(
        {
          collection: request.collection,
          collectionDirectory: request.collectionDirectory,
          inputs,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
        {
          sourceKind: this.kind,
          sourceAccountId: request.accountId,
          sourceLabel: request.sourceLabel,
          sourceAlbum: { kind: 'personal', id: 'wechat-personal', name: '个人收藏' },
          displayName: (path) => labels.get(path) ?? basename(path),
        },
        async (progress: ImportProgress) => {
          await onProgress?.({
            ...progress,
            completed: resolutionFailures.length + progress.completed,
            total: resolutionTotal,
            failed: resolutionFailures.length + progress.failed,
            phase: 'importing',
            ...(progress.currentPath
              ? { currentPath: labels.get(progress.currentPath) ?? '微信表情' }
              : {}),
          })
        },
      )
      const remap = (path: string) => labels.get(path) ?? '微信表情'
      return {
        assets: imported.assets,
        sourceUpdates: imported.sourceUpdates,
        duplicates: imported.duplicates.map(remap),
        failures: [
          ...resolutionFailures,
          ...imported.failures.map((failure) => ({
            path: remap(failure.path),
            reason: failure.reason,
          })),
        ],
      }
    } finally {
      clearWechat4PersonalEmoticonCatalog(records)
      try {
        if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true })
      } finally {
        await Promise.all(snapshots.map((item) => removeWechat4Snapshot(item)))
      }
    }
  }
}
