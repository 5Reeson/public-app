import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import sharp from 'sharp'

import {
  type AnimationRepairView,
  type ExportTask,
  type PrepareExportSummary,
  type PrepareProgress,
  type PreparedAssetFailure,
  type PreparedExportGroupView,
  type PreparedSnapshotConfiguration,
  type PreparedSnapshotDestination,
  type StickerAsset,
  type StickerCollection,
} from '../../shared/domain.js'
import { planStickerPacks } from '../../shared/pack-plan.js'
import {
  PackPreparer,
  WHATSAPP_CONVERSION_VERSION,
  type PreparedPack,
} from '../packs/pack-preparer.js'

export const LOCAL_ORIGINAL_VERSION = 'local-original-v1'
export const LOCAL_WEBP_CONVERSION_VERSION = 'local-webp-v1'

export interface PreparedExportPayload {
  id: string
  role: 'sticker' | 'tray'
  assetId?: string
  sourcePath: string
  fileName: string
  sha256: string
  sizeBytes: number
  mimeType: string
  animated: boolean
  durationMs?: number
  animationTimingAdjusted?: boolean
  droppedFrameCount?: number
}

export interface PreparedExportGroup {
  id: string
  name: string
  mediaKind: 'static' | 'animated' | 'mixed'
  assetIds: string[]
  payloads: PreparedExportPayload[]
  status: 'prepared' | 'failed'
  error?: string
}

export interface PreparedExportResult {
  fingerprint: string
  destination: PreparedSnapshotDestination
  name: string
  publisher?: string
  configuration: PreparedSnapshotConfiguration
  orderedAssetIds: string[]
  groups: PreparedExportGroup[]
  conversionVersion: string
  warnings: string[]
  animationRepairs: AnimationRepairView[]
  assetFailures: PreparedAssetFailure[]
}

export class ExportPreparer {
  constructor(private readonly packPreparer = new PackPreparer()) {}

  async prepare(
    task: ExportTask,
    collection: StickerCollection,
    collectionDirectory: string,
    onProgress?: (progress: PrepareProgress) => void,
    signal?: AbortSignal,
  ): Promise<PreparedExportResult> {
    signal?.throwIfAborted()
    if (!task.destination) throw new Error('请先选择导出目的地')
    const assets = orderedTaskAssets(task, collection)
    if (assets.length === 0) throw new Error('请先选择要传输的表情')

    return task.destination.kind === 'whatsapp'
      ? this.prepareWhatsApp(task, collection, assets, collectionDirectory, onProgress, signal)
      : this.prepareLocalFolder(task, assets, collectionDirectory, onProgress, signal)
  }

  toSummary(
    prepared: PreparedExportResult,
    previewUrlForAsset: (assetId: string) => string,
  ): PrepareExportSummary {
    return {
      fingerprint: prepared.fingerprint,
      destination: prepared.destination,
      name: prepared.name,
      ...(prepared.publisher === undefined ? {} : { publisher: prepared.publisher }),
      groups: prepared.groups.map((group): PreparedExportGroupView => ({
        id: group.id,
        name: group.name,
        mediaKind: group.mediaKind,
        assetIds: group.assetIds,
        items: group.payloads
          .filter(
            (payload): payload is PreparedExportPayload & { assetId: string } =>
              payload.role === 'sticker' && payload.assetId !== undefined,
          )
          .map((payload) => ({
            id: payload.id,
            assetId: payload.assetId,
            previewUrl: previewUrlForAsset(payload.assetId),
            fileName: payload.fileName,
            sizeBytes: payload.sizeBytes,
            animated: payload.animated,
            ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
            ...(payload.animationTimingAdjusted ? { animationTimingAdjusted: true } : {}),
            ...(payload.droppedFrameCount ? { droppedFrameCount: payload.droppedFrameCount } : {}),
          })),
        status: group.status,
        ...(group.error === undefined ? {} : { error: group.error }),
      })),
      warnings: prepared.warnings,
      animationRepairs: prepared.animationRepairs,
      assetFailures: prepared.assetFailures,
    }
  }

  private async prepareWhatsApp(
    task: ExportTask,
    collection: StickerCollection,
    assets: StickerAsset[],
    collectionDirectory: string,
    onProgress?: (progress: PrepareProgress) => void,
    signal?: AbortSignal,
  ): Promise<PreparedExportResult> {
    const preparedCollection = this.whatsAppCollection(task, collection, assets)
    const plan = planStickerPacks(preparedCollection)
    const packs = await this.packPreparer.prepare(
      preparedCollection,
      collectionDirectory,
      onProgress,
      signal,
    )
    signal?.throwIfAborted()
    const plannedAssets = new Map(plan.packs.map((pack) => [pack.id, pack.assetIds]))
    const groups = await Promise.all(
      packs.map((pack) => this.whatsAppGroup(pack, plannedAssets.get(pack.id) ?? [], signal)),
    )
    signal?.throwIfAborted()
    const configuration: PreparedSnapshotConfiguration = {
      kind: 'whatsapp',
      ...task.whatsapp,
      title: task.whatsapp.title.trim(),
      publisher: task.whatsapp.publisher.trim(),
    }
    const result = {
      destination: 'whatsapp' as const,
      name: configuration.title,
      publisher: configuration.publisher,
      configuration,
      orderedAssetIds: assets.map((asset) => asset.id),
      groups,
      conversionVersion: WHATSAPP_CONVERSION_VERSION,
      warnings: plan.warnings.map((warning) => warning.message),
      animationRepairs: packs.flatMap((pack) =>
        pack.stickers
          .filter((sticker) => sticker.animationTimingAdjusted)
          .map((sticker) => ({
            assetId: sticker.assetId,
            droppedFrameCount: sticker.droppedFrameCount ?? 0,
          })),
      ),
      assetFailures: packs.flatMap((pack) => pack.assetFailures),
    }
    return { ...result, fingerprint: fingerprintPrepared(result) }
  }

  async prepareWhatsAppPacks(
    task: ExportTask,
    collection: StickerCollection,
    collectionDirectory: string,
    onProgress?: (progress: PrepareProgress) => void,
    signal?: AbortSignal,
  ): Promise<PreparedPack[]> {
    if (task.destination?.kind !== 'whatsapp') throw new Error('当前导出目的地不是 WhatsApp')
    const assets = orderedTaskAssets(task, collection)
    if (assets.length === 0) throw new Error('请先选择要传输的表情')
    return this.packPreparer.prepare(
      this.whatsAppCollection(task, collection, assets),
      collectionDirectory,
      onProgress,
      signal,
    )
  }

  private whatsAppCollection(
    task: ExportTask,
    collection: StickerCollection,
    assets: StickerAsset[],
  ): StickerCollection {
    return {
      ...collection,
      id: task.id,
      title: task.whatsapp.title.trim(),
      publisher: task.whatsapp.publisher.trim(),
      packSize: task.whatsapp.packSize,
      assets: assets.map((asset, userOrder) => ({ ...asset, userOrder })),
      selectedAssetIds: assets.map((asset) => asset.id),
    }
  }

  private async whatsAppGroup(
    pack: PreparedPack,
    plannedAssetIds: string[],
    signal?: AbortSignal,
  ): Promise<PreparedExportGroup> {
    signal?.throwIfAborted()
    if (pack.status === 'failed') {
      const failedAssetIds = [
        ...pack.stickers.map((sticker) => sticker.assetId),
        ...pack.assetFailures.map((failure) => failure.assetId),
      ]
      return {
        id: pack.id,
        name: pack.name,
        mediaKind: pack.mediaKind,
        assetIds: plannedAssetIds.length > 0 ? plannedAssetIds : failedAssetIds,
        payloads: [],
        status: 'failed',
        error: pack.error ?? '表情包准备失败',
      }
    }
    const stickerPayloads = await Promise.all(
      pack.stickers.map(async (sticker, index): Promise<PreparedExportPayload> => ({
        id: `sticker-${sticker.assetId}`,
        role: 'sticker',
        assetId: sticker.assetId,
        sourcePath: sticker.outputPath,
        fileName: `${String(index + 1).padStart(3, '0')}.webp`,
        sha256: await sha256File(sticker.outputPath),
        sizeBytes: sticker.sizeBytes,
        mimeType: 'image/webp',
        animated: pack.mediaKind === 'animated',
        ...(sticker.durationMs === undefined ? {} : { durationMs: sticker.durationMs }),
        ...(sticker.animationTimingAdjusted ? { animationTimingAdjusted: true } : {}),
        ...(sticker.droppedFrameCount ? { droppedFrameCount: sticker.droppedFrameCount } : {}),
      })),
    )
    signal?.throwIfAborted()
    const trayStat = await stat(pack.trayPath)
    const tray: PreparedExportPayload = {
      id: `tray-${pack.id}`,
      role: 'tray',
      sourcePath: pack.trayPath,
      fileName: 'tray.png',
      sha256: await sha256File(pack.trayPath),
      sizeBytes: trayStat.size,
      mimeType: 'image/png',
      animated: false,
    }
    return {
      id: pack.id,
      name: pack.name,
      mediaKind: pack.mediaKind,
      assetIds: pack.stickers.map((sticker) => sticker.assetId),
      payloads: [...stickerPayloads, tray],
      status: 'prepared',
    }
  }

  private async prepareLocalFolder(
    task: ExportTask,
    assets: StickerAsset[],
    collectionDirectory: string,
    onProgress?: (progress: PrepareProgress) => void,
    signal?: AbortSignal,
  ): Promise<PreparedExportResult> {
    signal?.throwIfAborted()
    const configuration: PreparedSnapshotConfiguration = {
      kind: 'local-folder',
      ...task.localFolder,
      batchName: task.localFolder.batchName.trim(),
    }
    const chunks = chunk(assets, configuration.itemsPerFolder)
    let completed = 0
    const groups: PreparedExportGroup[] = []
    for (const [groupIndex, groupAssets] of chunks.entries()) {
      signal?.throwIfAborted()
      const suffix = chunks.length > 1 ? ` ${groupIndex + 1}` : ''
      const name = `${configuration.batchName.slice(0, 128 - suffix.length)}${suffix}`
      try {
        const usedNames = new Set<string>()
        const payloads: PreparedExportPayload[] = []
        for (const [itemIndex, asset] of groupAssets.entries()) {
          signal?.throwIfAborted()
          try {
            const sourcePath =
              configuration.format === 'original'
                ? asset.originalPath
                : await convertLocalWebp(asset, collectionDirectory)
            const file = await stat(sourcePath)
            const extension = configuration.format === 'original' ? sourceExtension(asset) : '.webp'
            const fileName = uniqueFileName(
              configuration.naming === 'sequence'
                ? `${String(itemIndex + 1).padStart(3, '0')}${extension}`
                : `${safeStem(asset.displayName)}${extension}`,
              usedNames,
            )
            payloads.push({
              id: `sticker-${asset.id}`,
              role: 'sticker',
              assetId: asset.id,
              sourcePath,
              fileName,
              sha256: await sha256File(sourcePath),
              sizeBytes: file.size,
              mimeType: configuration.format === 'original' ? asset.mimeType : 'image/webp',
              animated: asset.animated,
              ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
            })
            signal?.throwIfAborted()
          } finally {
            completed += 1
            onProgress?.({
              completed,
              total: assets.length,
              currentName: asset.displayName,
              packIndex: groupIndex + 1,
              packCount: chunks.length,
            })
          }
        }
        groups.push({
          id: stableGroupId('local', groupAssets),
          name,
          mediaKind: mediaKindFor(groupAssets),
          assetIds: groupAssets.map((asset) => asset.id),
          payloads,
          status: 'prepared',
        })
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        groups.push({
          id: stableGroupId('local', groupAssets),
          name,
          mediaKind: mediaKindFor(groupAssets),
          assetIds: groupAssets.map((asset) => asset.id),
          payloads: [],
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    signal?.throwIfAborted()
    const result = {
      destination: 'local-folder' as const,
      name: configuration.batchName,
      configuration,
      orderedAssetIds: assets.map((asset) => asset.id),
      groups,
      conversionVersion:
        configuration.format === 'original'
          ? LOCAL_ORIGINAL_VERSION
          : LOCAL_WEBP_CONVERSION_VERSION,
      warnings: [] as string[],
      animationRepairs: [] as AnimationRepairView[],
      assetFailures: [] as PreparedAssetFailure[],
    }
    return { ...result, fingerprint: fingerprintPrepared(result) }
  }
}

function orderedTaskAssets(task: ExportTask, collection: StickerCollection): StickerAsset[] {
  if (
    task.selectedAssetIds.length !== task.orderedAssetIds.length ||
    new Set(task.selectedAssetIds).size !== task.selectedAssetIds.length
  ) {
    throw new Error('本次导出选择或顺序无效')
  }
  const selected = new Set(task.selectedAssetIds)
  if (task.orderedAssetIds.some((id) => !selected.has(id))) {
    throw new Error('本次导出顺序与所选素材不一致')
  }
  const byId = new Map(collection.assets.map((asset) => [asset.id, asset]))
  return task.orderedAssetIds.map((id) => {
    const asset = byId.get(id)
    if (!asset) throw new Error('本次导出包含已从素材库删除的内容，请重新挑选')
    return asset
  })
}

async function convertLocalWebp(asset: StickerAsset, collectionDirectory: string): Promise<string> {
  const key = createHash('sha256')
    .update(`${LOCAL_WEBP_CONVERSION_VERSION}|${asset.sha256}|${asset.animated}`)
    .digest('hex')
  const outputPath = join(collectionDirectory, 'converted', 'local-folder', `${key}.webp`)
  try {
    const metadata = await sharp(outputPath, {
      animated: asset.animated,
      pages: asset.animated ? -1 : 1,
    }).metadata()
    if (metadata.format === 'webp') return outputPath
  } catch {
    // Regenerate a missing or invalid derived file.
  }

  const input = sharp(asset.originalPath, {
    animated: asset.animated,
    pages: asset.animated ? -1 : 1,
    limitInputPixels: 128 * 1024 * 1024,
  })
  const metadata = await input.metadata()
  const contents = await input
    .webp({
      quality: 90,
      effort: 4,
      loop: asset.animated ? (metadata.loop ?? 0) : undefined,
    })
    .toBuffer()
  await mkdir(join(collectionDirectory, 'converted', 'local-folder'), {
    recursive: true,
    mode: 0o700,
  })
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, outputPath)
    await chmod(outputPath, 0o600)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  return outputPath
}

function fingerprintPrepared(prepared: Omit<PreparedExportResult, 'fingerprint'>): string {
  const payloadByAssetId = new Map(
    prepared.groups.flatMap((group) =>
      group.payloads
        .filter(
          (payload): payload is PreparedExportPayload & { assetId: string } =>
            payload.role === 'sticker' && payload.assetId !== undefined,
        )
        .map((payload) => [payload.assetId, payload] as const),
    ),
  )
  return createHash('sha256')
    .update(
      JSON.stringify({
        destination: prepared.destination,
        name: prepared.name,
        publisher: prepared.publisher,
        configuration: prepared.configuration,
        orderedPayloads: prepared.orderedAssetIds.map((assetId) => {
          const payload = payloadByAssetId.get(assetId)
          return payload
            ? {
                sha256: payload.sha256,
                mimeType: payload.mimeType,
                animated: payload.animated,
                durationMs: payload.durationMs,
              }
            : { missing: true }
        }),
        conversionVersion: prepared.conversionVersion,
        groups: prepared.groups.map((group) => ({
          name: group.name,
          mediaKind: group.mediaKind,
          status: group.status,
          error: group.error,
          payloads: group.payloads.map((payload) => ({
            role: payload.role,
            fileName: payload.fileName,
            sha256: payload.sha256,
            sizeBytes: payload.sizeBytes,
            mimeType: payload.mimeType,
            animated: payload.animated,
            durationMs: payload.durationMs,
            animationTimingAdjusted: payload.animationTimingAdjusted,
            droppedFrameCount: payload.droppedFrameCount,
          })),
        })),
      }),
    )
    .digest('hex')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function stableGroupId(prefix: string, assets: StickerAsset[]): string {
  const digest = createHash('sha256')
    .update(assets.map((asset) => `${asset.id}:${asset.sha256}`).join('|'))
    .digest('hex')
    .slice(0, 16)
  return `${prefix}-${digest}`
}

function mediaKindFor(assets: StickerAsset[]): 'static' | 'animated' | 'mixed' {
  const animated = assets.filter((asset) => asset.animated).length
  return animated === 0 ? 'static' : animated === assets.length ? 'animated' : 'mixed'
}

function sourceExtension(asset: StickerAsset): string {
  const extension = extname(basename(asset.originalPath)).toLowerCase()
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension
  return mimeExtension(asset.mimeType)
}

function mimeExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    default:
      return '.img'
  }
}

function safeStem(displayName: string): string {
  const withoutExtension = basename(displayName, extname(displayName))
  const withoutControlCharacters = [...withoutExtension]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
  const safe = withoutControlCharacters
    .normalize('NFC')
    .replaceAll(/[/:\\]/g, '-')
    .replaceAll(/^\.+|\.+$/g, '')
    .trim()
  return (safe || '表情').slice(0, 96)
}

function uniqueFileName(candidate: string, used: Set<string>): string {
  const extension = extname(candidate)
  const stem = basename(candidate, extension)
  let fileName = candidate
  let suffix = 2
  while (used.has(fileName.toLocaleLowerCase())) {
    fileName = `${stem}-${suffix}${extension}`
    suffix += 1
  }
  used.add(fileName.toLocaleLowerCase())
  return fileName
}
