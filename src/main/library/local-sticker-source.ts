import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

import sharp, { type Metadata } from 'sharp'

import type {
  ImportFailure,
  ImportProgress,
  ImportResult,
  StickerAsset,
  StickerAlbumRef,
  StickerAssetSource,
  StickerCollection,
  StickerSource,
  StickerSourceKind,
} from '../../shared/domain.js'

const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'webp', 'gif'])

const EXTENSIONS: Record<string, string> = {
  gif: '.gif',
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
}

const MIME_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export interface LocalImportRequest {
  collection: StickerCollection
  /** Directory containing manifest.json and the originals directory. */
  collectionDirectory: string
  /** Explicit files and/or directories, kept in the order supplied by the user. */
  inputs: readonly string[]
  /** Optional cancellation for sources that perform long-running staged imports. */
  signal?: AbortSignal
}

export type ImportProgressHandler = (progress: ImportProgress) => void | Promise<void>

export interface ImportAttribution {
  sourceKind: StickerSourceKind
  sourceAccountId?: string
  sourceId?: string
  sourceLabel?: string
  importBatchId?: string
  sourceAlbum?: StickerAlbumRef | ((path: string, index: number) => StickerAlbumRef | undefined)
  displayName?: (path: string, index: number) => string
}

interface DiscoveryResult {
  files: string[]
  failures: ImportFailure[]
}

interface InspectedImage {
  bytes: Buffer
  extension: string
  mimeType: string
  width: number
  height: number
  animated: boolean
  durationMs?: number
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function walkDirectory(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => lexicalCompare(left.name, right.name))

  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(path)))
    } else if (entry.isFile()) {
      files.push(path)
    }
    // Deliberately do not follow symlinks. Besides avoiding cycles, this keeps a
    // directory import inside the directory the user actually selected.
  }
  return files
}

/**
 * Expands files and directories without filtering by filename extension.
 * Image support is decided later from decoded content, not from user-controlled
 * extensions. Explicit input order is preserved; directory entries are sorted.
 */
export async function discoverLocalFiles(inputs: readonly string[]): Promise<string[]> {
  const result = await discoverWithFailures(inputs)
  if (result.failures.length > 0) {
    throw new AggregateError(
      result.failures.map((failure) => new Error(`${failure.path}: ${failure.reason}`)),
      'One or more import locations could not be read',
    )
  }
  return result.files
}

async function discoverWithFailures(inputs: readonly string[]): Promise<DiscoveryResult> {
  const files: string[] = []
  const failures: ImportFailure[] = []

  for (const input of inputs) {
    const path = resolve(input)
    try {
      const details = await lstat(path)
      if (details.isFile()) {
        files.push(path)
      } else if (details.isDirectory()) {
        files.push(...(await walkDirectory(path)))
      } else {
        failures.push({ path, reason: 'Not a regular file or directory' })
      }
    } catch (error) {
      failures.push({ path, reason: errorMessage(error) })
    }
  }

  return { files, failures }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function durationFrom(metadata: Metadata): number | undefined {
  if (!metadata.delay || metadata.delay.length === 0) return undefined
  const delays =
    metadata.format === 'gif'
      ? metadata.delay.map((delay) => (delay === 0 ? 100 : delay))
      : metadata.delay
  return delays.reduce((total, delay) => total + delay, 0)
}

async function inspectImage(path: string): Promise<InspectedImage> {
  const bytes = await readFile(path)
  const image = sharp(bytes, {
    animated: true,
    failOn: 'error',
    limitInputPixels: 100_000_000,
  })
  const metadata = await image.metadata()

  if (
    !metadata.format ||
    !SUPPORTED_FORMATS.has(metadata.format) ||
    !metadata.width ||
    !metadata.height
  ) {
    throw new Error('Unsupported or unreadable image (PNG, JPEG, WebP and GIF only)')
  }

  // metadata() validates the container. Force a pixel decode as well so a file
  // with a plausible header but corrupt image data cannot enter the library.
  await image.clone().raw().toBuffer()

  const pages = metadata.pages ?? 1
  const pageHeight = metadata.pageHeight ?? metadata.height
  const animated = pages > 1 || (metadata.delay?.length ?? 0) > 1
  const durationMs = animated ? durationFrom(metadata) : undefined

  return {
    bytes,
    extension: EXTENSIONS[metadata.format]!,
    mimeType: MIME_TYPES[metadata.format]!,
    width: metadata.width,
    height: pageHeight,
    animated,
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

/** Content-validates a source candidate without copying it into the library. */
export async function validateLocalStickerFile(path: string): Promise<void> {
  const inspected = await inspectImage(path)
  inspected.bytes.fill(0)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function nextOrder(assets: readonly StickerAsset[], key: 'sourceOrder' | 'userOrder') {
  return assets.reduce((highest, asset) => Math.max(highest, asset[key]), -1) + 1
}

function sourceReference(
  attribution: ImportAttribution,
  importedAt: string,
  path?: string,
  index?: number,
): StickerAssetSource {
  const album =
    typeof attribution.sourceAlbum === 'function'
      ? path === undefined || index === undefined
        ? undefined
        : attribution.sourceAlbum(path, index)
      : attribution.sourceAlbum
  const importBatchId =
    attribution.importBatchId ??
    (attribution.sourceAccountId === undefined ? `local-import-${randomUUID()}` : undefined)
  const baseIdentity =
    attribution.sourceAccountId ?? importBatchId ?? `${attribution.sourceKind}-${randomUUID()}`
  const identity = album ? `${baseIdentity}|album:${album.id}` : baseIdentity
  const id =
    attribution.sourceId ??
    `source-${createHash('sha256')
      .update(`${attribution.sourceKind}|${identity}`)
      .digest('hex')
      .slice(0, 24)}`
  const defaultLabel =
    attribution.sourceKind === 'local'
      ? '本机导入'
      : attribution.sourceKind === 'wechat4'
        ? '新版微信账号'
        : '旧版微信账号'
  return {
    id,
    kind: attribution.sourceKind,
    label: attribution.sourceLabel?.trim() || defaultLabel,
    ...(attribution.sourceAccountId === undefined
      ? {}
      : { accountId: attribution.sourceAccountId }),
    ...(importBatchId === undefined ? {} : { importBatchId }),
    ...(album === undefined ? {} : { album: { ...album } }),
    importedAt,
  }
}

async function copyOriginal(
  bytes: Buffer,
  originalsDirectory: string,
  fileName: string,
  expectedHash: string,
): Promise<{ path: string; created: boolean }> {
  await mkdir(originalsDirectory, { recursive: true, mode: 0o700 })
  await chmod(originalsDirectory, 0o700)

  const destination = join(originalsDirectory, fileName)
  let created = false
  try {
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
    created = true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw error

    const existingHash = sha256(await readFile(destination))
    if (existingHash !== expectedHash) {
      throw new Error(
        `Library destination already exists with different content: ${basename(destination)}`,
        { cause: error },
      )
    }
  }

  await chmod(destination, 0o600)
  // Ensure an unexpected filesystem implementation did not produce a partial
  // copy before this path is persisted in the manifest.
  const destinationStat = await stat(destination)
  if (!destinationStat.isFile()) throw new Error('Imported original is not a file')
  return { path: destination, created }
}

export class LocalStickerSource implements StickerSource {
  readonly kind: StickerSourceKind = 'local'

  discover(inputs: readonly string[]): Promise<string[]> {
    return discoverLocalFiles(inputs)
  }

  async import(
    request: LocalImportRequest,
    onProgress?: ImportProgressHandler,
  ): Promise<ImportResult> {
    return this.importAttributed(request, { sourceKind: this.kind }, onProgress)
  }

  async importAttributed(
    request: LocalImportRequest,
    attribution: ImportAttribution,
    onProgress?: ImportProgressHandler,
  ): Promise<ImportResult> {
    const discovery = await discoverWithFailures(request.inputs)
    const originalsDirectory = join(resolve(request.collectionDirectory), 'originals')
    const assets: StickerAsset[] = []
    const sourceUpdates = new Map<string, StickerAsset>()
    const duplicates: string[] = []
    const failures = [...discovery.failures]
    const knownByHash = new Map(request.collection.assets.map((asset) => [asset.sha256, asset]))
    const createdOriginalPaths: string[] = []
    let sourceOrder = nextOrder(request.collection.assets, 'sourceOrder')
    let userOrder = nextOrder(request.collection.assets, 'userOrder')
    const batchImportedAt = new Date().toISOString()
    const total = discovery.files.length + discovery.failures.length
    let completed = discovery.failures.length

    const report = async (currentPath?: string) => {
      if (!onProgress) return
      await onProgress({
        completed,
        total,
        imported: assets.length,
        duplicates: duplicates.length,
        failed: failures.length,
        ...(currentPath === undefined ? {} : { currentPath }),
      })
    }

    await report()

    try {
      request.signal?.throwIfAborted()
      for (const [inputIndex, path] of discovery.files.entries()) {
        try {
          const source = sourceReference(attribution, batchImportedAt, path, inputIndex)
          request.signal?.throwIfAborted()
          const inspected = await inspectImage(path)
          request.signal?.throwIfAborted()
          const hash = sha256(inspected.bytes)
          const duplicateAsset = knownByHash.get(hash)
          if (duplicateAsset) {
            duplicates.push(path)
            if (!duplicateAsset.sources.some((item) => item.id === source.id)) {
              const updated = {
                ...duplicateAsset,
                sources: [...duplicateAsset.sources, { ...source }],
              }
              knownByHash.set(hash, updated)
              sourceUpdates.set(updated.id, updated)
            }
          } else {
            const id = `asset-${hash.slice(0, 24)}`
            const copied = await copyOriginal(
              inspected.bytes,
              originalsDirectory,
              `${id}${inspected.extension}`,
              hash,
            )
            if (copied.created) createdOriginalPaths.push(copied.path)
            request.signal?.throwIfAborted()
            const importedAt = batchImportedAt
            assets.push({
              id,
              sources: [{ ...source }],
              displayName:
                attribution.displayName?.(path, inputIndex) ?? basename(path, extname(path)),
              originalPath: copied.path,
              sha256: hash,
              mimeType: inspected.mimeType,
              animated: inspected.animated,
              width: inspected.width,
              height: inspected.height,
              ...(inspected.durationMs === undefined ? {} : { durationMs: inspected.durationMs }),
              importedAt,
              sourceOrder,
              userOrder,
            })
            knownByHash.set(hash, assets.at(-1)!)
            sourceOrder += 1
            userOrder += 1
          }
        } catch (error) {
          if (request.signal?.aborted) throw error
          failures.push({ path, reason: errorMessage(error) })
        }

        completed += 1
        await report(path)
      }
      request.signal?.throwIfAborted()
    } catch (error) {
      if (request.signal?.aborted) {
        await Promise.all(
          createdOriginalPaths.map((originalPath) => rm(originalPath, { force: true })),
        )
      }
      throw error
    }

    return { assets, sourceUpdates: [...sourceUpdates.values()], duplicates, failures }
  }
}
