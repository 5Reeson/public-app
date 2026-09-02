import { createDecipheriv, createHash } from 'node:crypto'
import { chmod, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { clearCandidateDatabaseKey, encodeSyntheticCandidateFrame } from './candidate-key-pipe.js'
import {
  runWechat4HelperForStoreEmoticons,
  type Wechat4HelperRunnerOptions,
} from './helper-runner.js'
import type { Wechat4CandidateStore } from './personal-emoticon-reader.js'
import {
  clearWechat4StoreEmoticonCatalog,
  type Wechat4StoreEmoticon,
} from './store-emoticon-catalog.js'
import type { Wechat4Snapshot } from './wechat4-layout.js'
import { DEFAULT_WECHAT4_ROOT, resolveWechat4StoreLayout } from './wechat4-layout.js'
import type { Wechat4StoreKeyCache } from './wechat4-store-key-store.js'

const MAX_KVCOMM_ENTRIES = 10_000
const MAX_KVCOMM_CODES = 64
const MAX_CONTAINER_BYTES = 256 * 1024 * 1024

export const DEFAULT_WECHAT4_KVCOMM_DIRECTORY = join(
  homedir(),
  'Library',
  'Containers',
  'com.tencent.xinWeChat',
  'Data',
  'Documents',
  'app_data',
  'net',
  'kvcomm',
)

export interface Wechat4StoreEmoticonReadRequest {
  accountId: string
  snapshot: Wechat4Snapshot
  signal?: AbortSignal
}

export interface Wechat4StoreEmoticonCatalogReader {
  read(request: Wechat4StoreEmoticonReadRequest): Promise<Wechat4StoreEmoticon[]>
}

export class HelperWechat4StoreEmoticonCatalogReader implements Wechat4StoreEmoticonCatalogReader {
  constructor(
    private readonly options: {
      helper: Wechat4HelperRunnerOptions
      candidateStore: Wechat4CandidateStore
    },
  ) {}

  async read(request: Wechat4StoreEmoticonReadRequest): Promise<Wechat4StoreEmoticon[]> {
    const candidate = await this.options.candidateStore.load(request.accountId)
    if (!candidate) throw new Error('微信数据库安全缓存尚未准备完成')
    try {
      request.signal?.throwIfAborted()
      const result = await runWechat4HelperForStoreEmoticons(
        {
          v: 1,
          id: `store-emoticons-${Date.now()}`,
          method: 'storeEmoticonsFd',
          params: { databasePath: request.snapshot.databasePath },
        },
        encodeSyntheticCandidateFrame(candidate),
        {
          ...this.options.helper,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      )
      if (!result.response.ok) {
        clearWechat4StoreEmoticonCatalog(result.records)
        throw new Error('微信官方表情目录读取失败')
      }
      const recordCount = result.response.result.recordCount
      const packageCount = result.response.result.packageCount
      const observedPackages = new Set(result.records.map((record) => record.packageId)).size
      if (
        !Number.isSafeInteger(recordCount) ||
        !Number.isSafeInteger(packageCount) ||
        recordCount !== result.records.length ||
        packageCount !== observedPackages
      ) {
        clearWechat4StoreEmoticonCatalog(result.records)
        throw new Error('微信官方表情目录计数不一致')
      }
      return result.records
    } finally {
      clearCandidateDatabaseKey(candidate)
    }
  }
}

export interface Wechat4OfficialStagedAsset {
  path: string
  label: string
  packageId: string
  packageName: string
  memberIndex: number
}

export interface Wechat4OfficialEmoticonStageRequest {
  accountId: string
  snapshot: Wechat4Snapshot
  stagingDirectory: string
  maxItems?: number
  maxItemsPerPackage?: number
  packageIds?: readonly string[]
  signal?: AbortSignal
}

export interface Wechat4OfficialEmoticonStager {
  stage(request: Wechat4OfficialEmoticonStageRequest): Promise<Wechat4OfficialStagedAsset[]>
}

interface ExtractedStore {
  assets: Wechat4OfficialStagedAsset[]
  createdPaths: string[]
}

class InvalidStoreKeyError extends Error {}

function contentMd5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

function decryptedFirstBlock(ciphertext: Buffer, key: Buffer): Buffer | undefined {
  if (ciphertext.length !== 16 || key.length !== 16) return undefined
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, key)
    decipher.setAutoPadding(false)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return undefined
  }
}

function knownImageHeader(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) ||
    bytes.subarray(0, 6).equals(Buffer.from('GIF89a')) ||
    bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ||
    (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') ||
    bytes.subarray(0, 4).toString('ascii').toLowerCase() === 'wxgf'
  )
}

function decryptContainer(ciphertext: Buffer, key: Buffer): Buffer | undefined {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0 || key.length !== 16) return undefined
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, key)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return undefined
  }
}

async function firstContainerBlock(path: string): Promise<Buffer | undefined> {
  const handle = await open(path, 'r')
  const block = Buffer.alloc(16)
  try {
    const { bytesRead } = await handle.read(block, 0, block.length, 0)
    if (bytesRead !== block.length) {
      block.fill(0)
      return undefined
    }
    return block
  } finally {
    await handle.close()
  }
}

async function kvcommCodes(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  if (entries.length > MAX_KVCOMM_ENTRIES) throw new Error('微信会话密钥目录超出安全读取限制')
  const codes = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const match = /^key_(\d{1,20})_.+\.statistic$/i.exec(entry.name)
    if (!match?.[1]) continue
    codes.add(match[1])
    if (codes.size > MAX_KVCOMM_CODES) throw new Error('微信会话密钥候选超出安全读取限制')
  }
  return [...codes]
}

function accountNameCandidates(accountDirectoryName: string): string[] {
  if (
    !accountDirectoryName ||
    Buffer.byteLength(accountDirectoryName, 'utf8') > 4_096 ||
    accountDirectoryName.includes('/') ||
    accountDirectoryName.includes('\0')
  ) {
    throw new Error('微信账号目录名称无效')
  }
  const candidates = new Set([accountDirectoryName])
  const suffix = /^(.+)_([a-z0-9]{4})$/i.exec(accountDirectoryName)?.[1]
  if (suffix) candidates.add(suffix)
  return [...candidates]
}

function groupedRecords(records: readonly Wechat4StoreEmoticon[]) {
  const groups = new Map<string, Wechat4StoreEmoticon[]>()
  for (const record of records) {
    const group = groups.get(record.packageId) ?? []
    group.push(record)
    groups.set(record.packageId, group)
  }
  return groups
}

async function removeCreated(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })))
}

export class LocalWechat4OfficialEmoticonStager implements Wechat4OfficialEmoticonStager {
  private readonly root: string
  private readonly kvcommDirectory: string

  constructor(
    private readonly options: {
      catalogReader: Wechat4StoreEmoticonCatalogReader
      keyStore: Wechat4StoreKeyCache
      root?: string
      kvcommDirectory?: string
    },
  ) {
    this.root = options.root ?? DEFAULT_WECHAT4_ROOT
    this.kvcommDirectory = options.kvcommDirectory ?? DEFAULT_WECHAT4_KVCOMM_DIRECTORY
  }

  private async extract(
    request: Wechat4OfficialEmoticonStageRequest,
    records: readonly Wechat4StoreEmoticon[],
    selected: ReadonlySet<number>,
    key: Buffer,
    layout: Awaited<ReturnType<typeof resolveWechat4StoreLayout>>,
  ): Promise<ExtractedStore | undefined> {
    const assets: Wechat4OfficialStagedAsset[] = []
    const createdPaths: string[] = []
    const groups = groupedRecords(records)
    try {
      for (const [packageId, members] of groups) {
        request.signal?.throwIfAborted()
        const path = layout.containers.get(packageId)
        if (!path) throw new InvalidStoreKeyError()
        const encrypted = await readFile(path)
        if (encrypted.length === 0 || encrypted.length > MAX_CONTAINER_BYTES) {
          encrypted.fill(0)
          throw new InvalidStoreKeyError()
        }
        const decrypted = decryptContainer(encrypted, key)
        encrypted.fill(0)
        if (!decrypted) throw new InvalidStoreKeyError()
        try {
          let memberIndex = 0
          for (const member of members) {
            const end = member.emoticonOffset + member.emoticonSize
            if (
              !Number.isSafeInteger(end) ||
              end > decrypted.length ||
              contentMd5(decrypted.subarray(member.emoticonOffset, end)) !== member.md5
            ) {
              throw new InvalidStoreKeyError()
            }
            if (selected.has(member.order)) {
              const outputPath = join(
                request.stagingDirectory,
                `official-${String(member.order).padStart(6, '0')}.asset`,
              )
              await writeFile(outputPath, decrypted.subarray(member.emoticonOffset, end), {
                mode: 0o600,
              })
              await chmod(outputPath, 0o600)
              createdPaths.push(outputPath)
              assets.push({
                path: outputPath,
                label: `${member.packageName}·${String(memberIndex + 1).padStart(3, '0')}`,
                packageId,
                packageName: member.packageName,
                memberIndex,
              })
            }
            memberIndex += 1
          }
        } finally {
          decrypted.fill(0)
        }
      }
      return { assets, createdPaths }
    } catch (error) {
      await removeCreated(createdPaths)
      if (error instanceof InvalidStoreKeyError) return undefined
      throw error
    }
  }

  async stage(request: Wechat4OfficialEmoticonStageRequest): Promise<Wechat4OfficialStagedAsset[]> {
    let records: Wechat4StoreEmoticon[] = []
    try {
      if (
        request.maxItems !== undefined &&
        (!Number.isSafeInteger(request.maxItems) || request.maxItems < 0)
      ) {
        throw new TypeError('Invalid official-emoticon item limit')
      }
      if (
        request.maxItemsPerPackage !== undefined &&
        (!Number.isSafeInteger(request.maxItemsPerPackage) || request.maxItemsPerPackage < 0)
      ) {
        throw new TypeError('Invalid official-emoticon per-package limit')
      }
      records = await this.options.catalogReader.read({
        accountId: request.accountId,
        snapshot: request.snapshot,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      if (records.length === 0 || request.maxItems === 0 || request.maxItemsPerPackage === 0)
        return []
      const requestedPackageIds = request.packageIds ? new Set(request.packageIds) : undefined
      if (requestedPackageIds && requestedPackageIds.size !== request.packageIds!.length) {
        throw new TypeError('Official-emoticon packages must be unique')
      }
      const availablePackageIds = new Set(records.map((record) => record.packageId))
      if (
        requestedPackageIds &&
        [...requestedPackageIds].some((id) => !availablePackageIds.has(id))
      ) {
        throw new TypeError('Unknown official-emoticon package')
      }
      const packageCounts = new Map<string, number>()
      let selectedRecords = records.filter((record) => {
        if (requestedPackageIds && !requestedPackageIds.has(record.packageId)) return false
        const count = packageCounts.get(record.packageId) ?? 0
        packageCounts.set(record.packageId, count + 1)
        return request.maxItemsPerPackage === undefined || count < request.maxItemsPerPackage
      })
      if (request.maxItems !== undefined)
        selectedRecords = selectedRecords.slice(0, request.maxItems)
      const selected = new Set(selectedRecords.map((record) => record.order))
      const layout = await resolveWechat4StoreLayout(
        request.accountId,
        [...new Set(records.map((record) => record.packageId))],
        this.root,
      )
      const firstPath = layout.containers.get(records[0]!.packageId)
      if (!firstPath) throw new Error('微信官方表情容器不完整')

      let cached: Buffer | undefined
      try {
        cached = await this.options.keyStore.load(request.accountId)
      } catch {
        await this.options.keyStore.clear(request.accountId)
      }
      if (cached) {
        try {
          const extracted = await this.extract(request, records, selected, cached, layout)
          if (extracted) return extracted.assets
          await this.options.keyStore.clear(request.accountId)
        } finally {
          cached.fill(0)
        }
      }

      const encryptedFirstBlock = await firstContainerBlock(firstPath)
      if (!encryptedFirstBlock) throw new Error('微信官方表情容器无法读取')
      try {
        const codes = await kvcommCodes(this.kvcommDirectory)
        for (const code of codes) {
          for (const accountName of accountNameCandidates(layout.accountDirectoryName)) {
            request.signal?.throwIfAborted()
            const key = createHash('md5').update(`${code}${accountName}EMOTICON`).digest()
            try {
              const firstBlock = decryptedFirstBlock(encryptedFirstBlock, key)
              if (!firstBlock) continue
              try {
                if (!knownImageHeader(firstBlock)) continue
              } finally {
                firstBlock.fill(0)
              }
              const extracted = await this.extract(request, records, selected, key, layout)
              if (!extracted) continue
              try {
                await this.options.keyStore.save(request.accountId, key)
                return extracted.assets
              } catch (error) {
                await removeCreated(extracted.createdPaths)
                throw error
              }
            } finally {
              key.fill(0)
            }
          }
        }
      } finally {
        encryptedFirstBlock.fill(0)
      }
      throw new Error('当前账号的微信官方表情密钥尚不可用；请登录该账号后重试')
    } finally {
      clearWechat4StoreEmoticonCatalog(records)
    }
  }
}
