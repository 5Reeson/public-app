import { createHash } from 'node:crypto'
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import sharp, { type Metadata, type Sharp } from 'sharp'

import type {
  PreparedAssetFailure,
  PreparedPackView,
  PrepareProgress,
  PreparedStickerView,
  StickerAsset,
  StickerCollection,
} from '../../shared/domain.js'
import { planStickerPacks } from '../../shared/pack-plan.js'
import {
  MAX_ANIMATION_DURATION_MS,
  DEFAULT_ZERO_DELAY_GIF_FRAME_DURATION_MS,
  MIN_ANIMATION_FRAME_DURATION_MS,
  normalizeAnimationTiming,
  type NormalizedAnimationTiming,
} from './animation-timing.js'

export const WHATSAPP_CONVERSION_VERSION = 'wa-webp-v4'
const STICKER_DIMENSION = 512
const TRAY_DIMENSION = 96
const STATIC_LIMIT_BYTES = 100 * 1024
const ANIMATED_LIMIT_BYTES = 500 * 1024
const TRAY_LIMIT_BYTES = 50 * 1024
const SHARP_OPERATION_TIMEOUT_SECONDS = 12
// Bounded WebP compression attempts, from better image quality to smaller files.
// These values are encoder quality percentages, not sticker counts or pack sizes.
const STATIC_WEBP_QUALITY_STEPS = [90, 82, 74, 66, 58, 50, 42, 34, 28]
const ANIMATED_WEBP_QUALITY_STEPS = [82, 74, 66, 58, 50, 42, 34, 28, 22]
const LARGE_ANIMATION_WEBP_QUALITY_STEPS = [64, 42, 24, 16]
const LARGE_ANIMATION_FRAME_COUNT = 80

export interface PreparedSticker extends PreparedStickerView {
  outputPath: string
}

export interface PreparedPack extends Omit<PreparedPackView, 'stickers'> {
  stickers: PreparedSticker[]
  trayPath: string
}

function conversionKey(asset: StickerAsset): string {
  return createHash('sha256')
    .update(
      `${WHATSAPP_CONVERSION_VERSION}|${asset.sha256}|${asset.animated ? 'animated' : 'static'}`,
    )
    .digest('hex')
}

async function writeAtomically(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, contents, { mode: 0o600 })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

function readAnimationTiming(metadata: Metadata, displayName: string): NormalizedAnimationTiming {
  const delays = metadata.delay ?? []
  if (!metadata.pages || metadata.pages <= 1) {
    throw new Error(`${displayName} 被标记为动态图片，但解码后没有多个帧`)
  }
  if (delays.length !== metadata.pages) {
    throw new Error(`${displayName} 无法读取完整的动画帧时长`)
  }
  try {
    return normalizeAnimationTiming(delays, {
      ...(metadata.format === 'gif'
        ? { zeroDelayMs: DEFAULT_ZERO_DELAY_GIF_FRAME_DURATION_MS }
        : {}),
    })
  } catch (error) {
    throw new Error(`${displayName} ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

function resizeToStickerCanvas(pipeline: Sharp, metadata: Metadata, animated: boolean): Sharp {
  const sourceWidth = metadata.width
  const sourceHeight = animated ? metadata.pageHeight : metadata.height
  if (!sourceWidth || !sourceHeight) throw new Error('无法读取图片尺寸')

  const scale = Math.min(1, STICKER_DIMENSION / sourceWidth, STICKER_DIMENSION / sourceHeight)
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const horizontalPadding = STICKER_DIMENSION - width
  const verticalPadding = STICKER_DIMENSION - height

  return pipeline.resize({ width, height, fit: 'fill' }).extend({
    top: Math.floor(verticalPadding / 2),
    bottom: Math.ceil(verticalPadding / 2),
    left: Math.floor(horizontalPadding / 2),
    right: Math.ceil(horizontalPadding / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
}

async function validateCachedSticker(
  path: string,
  animated: boolean,
): Promise<PreparedStickerView | undefined> {
  try {
    const file = await stat(path)
    const metadata = await sharp(path, { animated, pages: animated ? -1 : 1 })
      .timeout({ seconds: SHARP_OPERATION_TIMEOUT_SECONDS })
      .metadata()
    const height = animated ? metadata.pageHeight : metadata.height
    const limit = animated ? ANIMATED_LIMIT_BYTES : STATIC_LIMIT_BYTES
    if (
      metadata.format !== 'webp' ||
      metadata.width !== STICKER_DIMENSION ||
      height !== STICKER_DIMENSION ||
      file.size > limit
    ) {
      return undefined
    }
    const durationMs = animated ? validateEncodedAnimation(metadata) : undefined
    return { assetId: '', sizeBytes: file.size, durationMs }
  } catch {
    return undefined
  }
}

function validateEncodedAnimation(metadata: Metadata): number {
  const delays = metadata.delay ?? []
  if (!metadata.pages || metadata.pages <= 1 || delays.length !== metadata.pages) {
    throw new Error('编码后的动画帧数据不完整')
  }
  if (delays.some((delay) => delay < MIN_ANIMATION_FRAME_DURATION_MS)) {
    throw new Error('编码后的动画仍包含短于 8ms 的帧')
  }
  const durationMs = delays.reduce((total, delay) => total + delay, 0)
  if (durationMs > MAX_ANIMATION_DURATION_MS) {
    throw new Error('编码后的动画总时长超过 10 秒')
  }
  return durationMs
}

async function validateEncodedSticker(
  contents: Buffer,
  animated: boolean,
): Promise<number | undefined> {
  const metadata = await sharp(contents, {
    animated,
    pages: animated ? -1 : 1,
  })
    .timeout({ seconds: SHARP_OPERATION_TIMEOUT_SECONDS })
    .metadata()
  const height = animated ? metadata.pageHeight : metadata.height
  if (
    metadata.format !== 'webp' ||
    metadata.width !== STICKER_DIMENSION ||
    height !== STICKER_DIMENSION
  ) {
    throw new Error('编码后的表情尺寸或格式无效')
  }
  return animated ? validateEncodedAnimation(metadata) : undefined
}

async function prepareKeptFrames(
  asset: StickerAsset,
  metadata: Metadata,
  keptFrameIndexes: number[],
  signal?: AbortSignal,
): Promise<Buffer[]> {
  const frames: Buffer[] = []
  for (const frameIndex of keptFrameIndexes) {
    signal?.throwIfAborted()
    frames.push(
      await resizeToStickerCanvas(
        sharp(asset.originalPath, {
          page: frameIndex,
          pages: 1,
          limitInputPixels: 128 * 1024 * 1024,
        }),
        metadata,
        true,
      )
        .png()
        .timeout({ seconds: SHARP_OPERATION_TIMEOUT_SECONDS })
        .toBuffer(),
    )
  }
  return frames
}

async function convertSticker(
  asset: StickerAsset,
  cacheDirectory: string,
  signal?: AbortSignal,
): Promise<PreparedSticker> {
  signal?.throwIfAborted()
  const outputPath = join(cacheDirectory, `${conversionKey(asset)}.webp`)
  const inputMetadata = await sharp(asset.originalPath, {
    animated: asset.animated,
    pages: asset.animated ? -1 : 1,
  })
    .timeout({ seconds: SHARP_OPERATION_TIMEOUT_SECONDS })
    .metadata()
  const timing = asset.animated ? readAnimationTiming(inputMetadata, asset.displayName) : undefined
  const cached = await validateCachedSticker(outputPath, asset.animated)
  if (cached) {
    return {
      ...cached,
      assetId: asset.id,
      outputPath,
      ...(timing?.adjusted ? { animationTimingAdjusted: true } : {}),
      ...(timing?.droppedFrameCount ? { droppedFrameCount: timing.droppedFrameCount } : {}),
    }
  }
  const keptFrames =
    timing && (timing.droppedFrameCount > 0 || (inputMetadata.format === 'gif' && timing.adjusted))
      ? await prepareKeptFrames(asset, inputMetadata, timing.keptFrameIndexes, signal)
      : undefined
  signal?.throwIfAborted()
  const largeAnimation = asset.animated && (inputMetadata.pages ?? 1) >= LARGE_ANIMATION_FRAME_COUNT
  const qualitySteps = asset.animated
    ? largeAnimation
      ? LARGE_ANIMATION_WEBP_QUALITY_STEPS
      : ANIMATED_WEBP_QUALITY_STEPS
    : STATIC_WEBP_QUALITY_STEPS
  const limit = asset.animated ? ANIMATED_LIMIT_BYTES : STATIC_LIMIT_BYTES
  let smallest: Buffer | undefined

  const encode = async (quality: number, exhaustive: boolean): Promise<Buffer> => {
    const pipeline = keptFrames
      ? sharp(keptFrames, { join: { animated: true } })
      : resizeToStickerCanvas(
          sharp(asset.originalPath, {
            animated: asset.animated,
            pages: asset.animated ? -1 : 1,
            limitInputPixels: 128 * 1024 * 1024,
          }),
          inputMetadata,
          asset.animated,
        )
    return pipeline
      .webp({
        quality,
        alphaQuality: Math.max(quality, 70),
        effort: exhaustive ? 6 : 2,
        loop: asset.animated ? (inputMetadata.loop ?? 0) : undefined,
        delay: timing?.delays,
        minSize: asset.animated && exhaustive,
        mixed: asset.animated && exhaustive,
      })
      .timeout({ seconds: SHARP_OPERATION_TIMEOUT_SECONDS })
      .toBuffer()
  }

  for (const quality of qualitySteps) {
    signal?.throwIfAborted()
    const candidate = await encode(quality, false)
    signal?.throwIfAborted()
    if (!smallest || candidate.length < smallest.length) smallest = candidate
    if (candidate.length <= limit) {
      const durationMs = await validateEncodedSticker(candidate, asset.animated)
      await writeAtomically(outputPath, candidate)
      return {
        assetId: asset.id,
        outputPath,
        sizeBytes: candidate.length,
        durationMs,
        ...(timing?.adjusted ? { animationTimingAdjusted: true } : {}),
        ...(timing?.droppedFrameCount ? { droppedFrameCount: timing.droppedFrameCount } : {}),
      }
    }
  }

  if (largeAnimation) {
    throw new Error(
      `${asset.displayName} 无法在有限次尝试内压缩到 500KB 以内（最小 ${Math.ceil((smallest?.length ?? 0) / 1024)}KB）`,
    )
  }

  const exhaustiveCandidate = await encode(qualitySteps.at(-1)!, true)
  signal?.throwIfAborted()
  if (!smallest || exhaustiveCandidate.length < smallest.length) smallest = exhaustiveCandidate
  if (exhaustiveCandidate.length <= limit) {
    const durationMs = await validateEncodedSticker(exhaustiveCandidate, asset.animated)
    await writeAtomically(outputPath, exhaustiveCandidate)
    return {
      assetId: asset.id,
      outputPath,
      sizeBytes: exhaustiveCandidate.length,
      durationMs,
      ...(timing?.adjusted ? { animationTimingAdjusted: true } : {}),
      ...(timing?.droppedFrameCount ? { droppedFrameCount: timing.droppedFrameCount } : {}),
    }
  }

  throw new Error(
    `${asset.displayName} 无法压缩到 ${asset.animated ? '500KB' : '100KB'} 以内（最小 ${Math.ceil((smallest?.length ?? 0) / 1024)}KB）`,
  )
}

async function prepareTrayIcon(asset: StickerAsset, path: string): Promise<number> {
  try {
    const existing = await stat(path)
    if (existing.size <= TRAY_LIMIT_BYTES) return existing.size
  } catch {
    // Regenerate a missing tray icon.
  }

  const contents = await sharp(asset.originalPath, { page: 0, pages: 1 })
    .resize({
      width: TRAY_DIMENSION,
      height: TRAY_DIMENSION,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer()
  if (contents.length > TRAY_LIMIT_BYTES) throw new Error('托盘图标无法压缩到 50KB 以内')
  await writeAtomically(path, contents)
  return contents.length
}

function validatePackMetadata(collection: StickerCollection): void {
  if (!collection.title.trim() || collection.title.length > 128) {
    throw new Error('贴纸包名称必须为 1–128 个字符')
  }
  if (!collection.publisher.trim() || collection.publisher.length > 128) {
    throw new Error('发布者必须为 1–128 个字符')
  }
}

function preparedPackId(
  fallbackId: string,
  collectionId: string,
  mediaKind: 'static' | 'animated',
  stickers: PreparedSticker[],
  byId: ReadonlyMap<string, StickerAsset>,
): string {
  if (stickers.length === 0) return fallbackId
  const selected = stickers.map((sticker) => byId.get(sticker.assetId)!)
  const digest = createHash('sha256')
    .update(
      `${collectionId}|${mediaKind}|${selected.map((asset) => `${asset.id}:${asset.sha256}`).join('|')}`,
    )
    .digest('hex')
    .slice(0, 16)
  return `pack-${digest}`
}

export class PackPreparer {
  async prepare(
    collection: StickerCollection,
    collectionDirectory: string,
    onProgress?: (progress: PrepareProgress) => void,
    signal?: AbortSignal,
  ): Promise<PreparedPack[]> {
    signal?.throwIfAborted()
    validatePackMetadata(collection)
    const plan = planStickerPacks(collection)
    const byId = new Map(collection.assets.map((asset) => [asset.id, asset]))
    const cacheDirectory = join(collectionDirectory, 'converted', 'whatsapp')
    const trayDirectory = join(collectionDirectory, 'tray')
    const total = plan.packs.reduce((count, pack) => count + pack.assetIds.length, 0)
    let completed = 0

    const preparedPacks: PreparedPack[] = []
    for (const [packIndex, pack] of plan.packs.entries()) {
      signal?.throwIfAborted()
      const assets = pack.assetIds.map((id) => byId.get(id)!)
      const suffix = plan.packs.length > 1 ? ` ${packIndex + 1}` : ''
      const name = `${collection.title.slice(0, 128 - suffix.length)}${suffix}`
      const stickers: PreparedSticker[] = []
      const assetFailures: PreparedAssetFailure[] = []
      for (const asset of assets) {
        signal?.throwIfAborted()
        onProgress?.({
          completed,
          total,
          currentName: asset.displayName,
          packIndex: packIndex + 1,
          packCount: plan.packs.length,
        })
        try {
          stickers.push(await convertSticker(asset, cacheDirectory, signal))
          signal?.throwIfAborted()
        } catch (error) {
          if (signal?.aborted) throw signal.reason
          assetFailures.push({
            assetId: asset.id,
            message: error instanceof Error ? error.message : String(error),
          })
        } finally {
          completed += 1
          onProgress?.({
            completed,
            total,
            currentName: asset.displayName,
            packIndex: packIndex + 1,
            packCount: plan.packs.length,
          })
        }
      }

      if (stickers.length < 3) {
        const id = assetFailures.length
          ? preparedPackId(pack.id, collection.id, pack.mediaKind, stickers, byId)
          : pack.id
        preparedPacks.push({
          id,
          name,
          publisher: collection.publisher,
          mediaKind: pack.mediaKind,
          stickers,
          trayPath: '',
          traySizeBytes: 0,
          assetFailures,
          status: 'failed',
          error: `成功准备的${pack.mediaKind === 'animated' ? '动图' : '静态表情'}只有 ${stickers.length} 张，至少需要 3 张`,
        })
        continue
      }

      const trayAsset = byId.get(stickers[0]!.assetId)!
      const id = assetFailures.length
        ? preparedPackId(pack.id, collection.id, pack.mediaKind, stickers, byId)
        : pack.id
      const trayPath = join(trayDirectory, `${id}.png`)
      try {
        const traySizeBytes = await prepareTrayIcon(trayAsset, trayPath)
        signal?.throwIfAborted()
        preparedPacks.push({
          id,
          name,
          publisher: collection.publisher,
          mediaKind: pack.mediaKind,
          stickers,
          trayPath,
          traySizeBytes,
          assetFailures,
          status: 'prepared',
        })
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        preparedPacks.push({
          id,
          name,
          publisher: collection.publisher,
          mediaKind: pack.mediaKind,
          stickers,
          trayPath: '',
          traySizeBytes: 0,
          assetFailures,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    signal?.throwIfAborted()
    return preparedPacks
  }
}
