import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PackPreparer, WHATSAPP_CONVERSION_VERSION } from '../../src/main/packs/pack-preparer.js'
import {
  CURRENT_SCHEMA_VERSION,
  type StickerAsset,
  type StickerCollection,
} from '../../src/shared/domain.js'

describe('PackPreparer', () => {
  let temporaryDirectory: string
  let collectionDirectory: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'pack-preparer-'))
    collectionDirectory = join(temporaryDirectory, 'collection')
    await mkdir(collectionDirectory, { recursive: true })
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  async function asset(
    index: number,
    animated = false,
    delays = [80, 120, 160],
  ): Promise<StickerAsset> {
    const originalPath = join(temporaryDirectory, `source-${index}.${animated ? 'webp' : 'png'}`)
    let contents: Buffer
    if (animated) {
      const frameHeight = 40
      contents = await sharp({
        create: {
          width: 60,
          height: frameHeight * 3,
          pageHeight: frameHeight,
          channels: 4,
          background: 'red',
        },
      })
        .composite([
          {
            input: Buffer.from(
              '<svg width="60" height="40"><rect width="60" height="40" fill="green"/></svg>',
            ),
            top: 40,
            left: 0,
          },
          {
            input: Buffer.from(
              '<svg width="60" height="40"><rect width="60" height="40" fill="blue"/></svg>',
            ),
            top: 80,
            left: 0,
          },
        ])
        .webp({ delay: delays, loop: 0 })
        .toBuffer()
      contents = patchWebpFrameDurations(contents, delays)
    } else {
      contents = await sharp({
        create: {
          width: 140 + index,
          height: 90 + index,
          channels: 4,
          background: { r: 30 * index, g: 110, b: 210, alpha: 1 },
        },
      })
        .png()
        .toBuffer()
    }
    await writeFile(originalPath, contents)
    return {
      id: `asset-${index}`,
      sources: [
        {
          id: 'source-local-test',
          kind: 'local',
          label: '本机导入',
          importBatchId: 'test-import',
          importedAt: '2026-08-08T00:00:00.000Z',
        },
      ],
      displayName: `Sticker ${index}`,
      originalPath,
      sha256: createHash('sha256').update(contents).digest('hex'),
      mimeType: animated ? 'image/webp' : 'image/png',
      animated,
      width: 140 + index,
      height: 90 + index,
      durationMs: animated ? delays.reduce((total, delay) => total + delay, 0) : undefined,
      importedAt: '2026-08-08T00:00:00.000Z',
      sourceOrder: index,
      userOrder: index,
    }
  }

  async function zeroDelayGifAsset(index: number, frameCount = 40): Promise<StickerAsset> {
    const originalPath = join(temporaryDirectory, `source-${index}.gif`)
    const frameHeight = 8
    const generatedContents = await sharp({
      create: {
        width: 8,
        height: frameHeight * frameCount,
        pageHeight: frameHeight,
        channels: 4,
        background: 'red',
      },
    })
      .composite(
        Array.from({ length: frameCount - 1 }, (_, frameIndex) => ({
          input: Buffer.from(
            `<svg width="8" height="8"><rect width="8" height="8" fill="rgb(${(frameIndex * 17) % 255},${(frameIndex * 31) % 255},${(frameIndex * 47) % 255})"/></svg>`,
          ),
          top: (frameIndex + 1) * frameHeight,
          left: 0,
        })),
      )
      .gif({ delay: Array(frameCount).fill(100), loop: 0, keepDuplicateFrames: true })
      .toBuffer()
    const contents = patchGifFrameDurations(generatedContents, 0)
    await writeFile(originalPath, contents)
    const metadata = await sharp(contents, { animated: true, pages: -1 }).metadata()
    return {
      id: `asset-${index}`,
      sources: [
        {
          id: 'source-wechat4-test',
          kind: 'wechat4',
          label: '新版微信账号 · 0001',
          accountId: 'wechat4-test-account',
          importedAt: '2026-08-08T00:00:00.000Z',
        },
      ],
      displayName: '微信表情 0004',
      originalPath,
      sha256: createHash('sha256').update(contents).digest('hex'),
      mimeType: 'image/gif',
      animated: true,
      width: metadata.width!,
      height: metadata.pageHeight!,
      durationMs: 0,
      importedAt: '2026-08-08T00:00:00.000Z',
      sourceOrder: index,
      userOrder: index,
    }
  }

  async function manyFrameGifAsset(index: number, frameCount = 90): Promise<StickerAsset> {
    const originalPath = join(temporaryDirectory, `many-frame-${index}.gif`)
    const frameHeight = 8
    const contents = await sharp({
      create: {
        width: 8,
        height: frameHeight * frameCount,
        pageHeight: frameHeight,
        channels: 4,
        background: 'red',
      },
    })
      .composite(
        Array.from({ length: frameCount - 1 }, (_, frameIndex) => ({
          input: Buffer.from(
            `<svg width="8" height="8"><rect width="8" height="8" fill="rgb(${(frameIndex * 13) % 255},${(frameIndex * 29) % 255},${(frameIndex * 43) % 255})"/></svg>`,
          ),
          top: (frameIndex + 1) * frameHeight,
          left: 0,
        })),
      )
      .gif({ delay: Array(frameCount).fill(40), loop: 0, keepDuplicateFrames: true })
      .toBuffer()
    await writeFile(originalPath, contents)
    return {
      id: `asset-${index}`,
      sources: [
        {
          id: 'source-wechat4-many-frame',
          kind: 'wechat4',
          label: '新版微信账号 · 0001',
          accountId: 'wechat4-test-account',
          importedAt: '2026-08-08T00:00:00.000Z',
        },
      ],
      displayName: `Many-frame GIF ${index}`,
      originalPath,
      sha256: createHash('sha256').update(contents).digest('hex'),
      mimeType: 'image/gif',
      animated: true,
      width: 8,
      height: 8,
      durationMs: frameCount * 40,
      importedAt: '2026-08-08T00:00:00.000Z',
      sourceOrder: index,
      userOrder: index,
    }
  }

  function collection(assets: StickerAsset[]): StickerCollection {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'test-collection',
      title: 'Test pack',
      publisher: 'Tests',
      packSize: 30,
      assets,
      selectedAssetIds: assets.map((item) => item.id),
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    }
  }

  it('prepares static 512px WebP stickers and a 96px tray icon within limits', async () => {
    const assets = await Promise.all([asset(0), asset(1), asset(2)])
    const [pack] = await new PackPreparer().prepare(collection(assets), collectionDirectory)

    expect(pack).toMatchObject({ status: 'prepared', mediaKind: 'static', name: 'Test pack' })
    expect(pack?.stickers).toHaveLength(3)
    for (const sticker of pack!.stickers) {
      expect(sticker.sizeBytes).toBeLessThanOrEqual(100 * 1024)
      const metadata = await sharp(sticker.outputPath).metadata()
      expect([metadata.format, metadata.width, metadata.height]).toEqual(['webp', 512, 512])
      expect((await stat(sticker.outputPath)).mode & 0o777).toBe(0o600)
    }
    expect(pack!.traySizeBytes).toBeLessThanOrEqual(50 * 1024)
    const tray = await sharp(await readFile(pack!.trayPath)).metadata()
    expect([tray.format, tray.width, tray.height]).toEqual(['png', 96, 96])
  })

  it('preserves animated frames and duration in animated WebP output', async () => {
    const assets = await Promise.all([asset(0, true), asset(1, true), asset(2, true)])
    const [pack] = await new PackPreparer().prepare(collection(assets), collectionDirectory)

    expect(pack).toMatchObject({ status: 'prepared', mediaKind: 'animated' })
    for (const sticker of pack!.stickers) {
      expect(sticker.durationMs).toBe(360)
      expect(sticker.sizeBytes).toBeLessThanOrEqual(500 * 1024)
      const metadata = await sharp(sticker.outputPath, { animated: true, pages: -1 }).metadata()
      expect(metadata.format).toBe('webp')
      expect(metadata.width).toBe(512)
      expect(metadata.pageHeight).toBe(512)
      expect(metadata.pages).toBe(3)
      expect(metadata.delay).toEqual([80, 120, 160])
    }
  })

  it('reuses valid cached conversions', async () => {
    const assets = await Promise.all([asset(0), asset(1), asset(2)])
    const preparer = new PackPreparer()
    const first = await preparer.prepare(collection(assets), collectionDirectory)
    const firstPath = first[0]!.stickers[0]!.outputPath
    const firstModifiedAt = (await stat(firstPath)).mtimeMs
    const second = await preparer.prepare(collection(assets), collectionDirectory)

    expect(second[0]!.stickers[0]!.outputPath).toBe(firstPath)
    expect((await stat(firstPath)).mtimeMs).toBe(firstModifiedAt)
  })

  it('normalizes short WebP frame delays and reports a non-blocking repair', async () => {
    const assets = await Promise.all([asset(0, true, [1, 7, 92]), asset(1, true), asset(2, true)])
    const [pack] = await new PackPreparer().prepare(collection(assets), collectionDirectory)

    expect(pack).toMatchObject({ status: 'prepared', assetFailures: [] })
    expect(pack!.stickers[0]).toMatchObject({
      animationTimingAdjusted: true,
      durationMs: 100,
    })
    expect(pack!.stickers[0]!.droppedFrameCount).toBeUndefined()
    const metadata = await sharp(pack!.stickers[0]!.outputPath, {
      animated: true,
      pages: -1,
    }).metadata()
    expect(metadata.delay).toEqual([11, 11, 78])
    expect(metadata.width).toBe(512)
    expect(metadata.pageHeight).toBe(512)
  })

  it('drops one imperceptible frame when borrowing alone cannot satisfy the minimum', async () => {
    const assets = await Promise.all([asset(0, true, [1, 1, 20]), asset(1, true), asset(2, true)])
    const [pack] = await new PackPreparer().prepare(collection(assets), collectionDirectory)
    const repaired = pack!.stickers[0]!
    const metadata = await sharp(repaired.outputPath, { animated: true, pages: -1 }).metadata()

    expect(repaired).toMatchObject({
      animationTimingAdjusted: true,
      droppedFrameCount: 1,
      durationMs: 22,
    })
    expect(metadata.pages).toBe(2)
    expect(metadata.delay).toEqual([11, 11])
  })

  it('keeps every frame of a zero-delay GIF and assigns a stable playback duration', async () => {
    const zeroDelayGif = await zeroDelayGifAsset(0)
    const assets = [zeroDelayGif, await asset(1, true), await asset(2, true)]
    const [pack] = await new PackPreparer().prepare(collection(assets), collectionDirectory)
    expect(pack!.assetFailures).toEqual([])
    expect(pack!.stickers.map((sticker) => sticker.assetId)).toContain(zeroDelayGif.id)
    const repaired = pack!.stickers.find((sticker) => sticker.assetId === zeroDelayGif.id)!
    const source = await sharp(zeroDelayGif.originalPath, {
      animated: true,
      pages: -1,
    }).metadata()
    const converted = await sharp(repaired.outputPath, {
      animated: true,
      pages: -1,
    }).metadata()

    expect(repaired).toMatchObject({
      animationTimingAdjusted: true,
      durationMs: source.pages! * 100,
    })
    expect(repaired.droppedFrameCount).toBeUndefined()
    expect(converted.pages).toBe(source.pages)
    expect(converted.delay).toEqual(Array(source.pages).fill(100))
  })

  it('uses a bounded conversion path for many-frame GIFs and continues the pack', async () => {
    const assets = [await manyFrameGifAsset(0), await asset(1, true), await asset(2, true)]
    const progress: Array<[number, string]> = []
    const [pack] = await new PackPreparer().prepare(
      collection(assets),
      collectionDirectory,
      (current) => progress.push([current.completed, current.currentName]),
    )

    expect(pack).toMatchObject({ status: 'prepared', assetFailures: [] })
    expect(pack!.stickers).toHaveLength(3)
    expect(progress.slice(0, 2)).toEqual([
      [0, 'Many-frame GIF 0'],
      [1, 'Many-frame GIF 0'],
    ])
  })

  it('does not reuse a valid-looking conversion from the previous cache version', async () => {
    const assets = await Promise.all([asset(0), asset(1), asset(2)])
    const oldKey = createHash('sha256')
      .update(`wa-webp-v3|${assets[0]!.sha256}|static`)
      .digest('hex')
    const oldPath = join(collectionDirectory, 'converted', 'whatsapp', `${oldKey}.webp`)
    await mkdir(join(collectionDirectory, 'converted', 'whatsapp'), { recursive: true })
    await writeFile(
      oldPath,
      await sharp({
        create: { width: 512, height: 512, channels: 4, background: 'red' },
      })
        .webp()
        .toBuffer(),
    )

    const [pack] = await new PackPreparer().prepare(collection(assets), collectionDirectory)

    expect(WHATSAPP_CONVERSION_VERSION).toBe('wa-webp-v4')
    expect(pack!.stickers[0]!.outputPath).not.toBe(oldPath)
  })

  it('keeps other assets and packs usable when one animation is invalid', async () => {
    const animated = await Promise.all([
      asset(0, true),
      asset(1, true),
      asset(2, true),
      asset(3, true, [5_000, 5_000, 1]),
    ])
    const staticAssets = await Promise.all([asset(4), asset(5), asset(6)])
    const packs = await new PackPreparer().prepare(
      collection([...animated, ...staticAssets]),
      collectionDirectory,
    )
    const animatedPack = packs.find((pack) => pack.mediaKind === 'animated')!
    const staticPack = packs.find((pack) => pack.mediaKind === 'static')!

    expect(animatedPack.status).toBe('prepared')
    expect(animatedPack.stickers).toHaveLength(3)
    expect(animatedPack.assetFailures).toEqual([
      { assetId: 'asset-3', message: expect.stringMatching(/10 秒/) },
    ])
    expect(staticPack).toMatchObject({ status: 'prepared', assetFailures: [] })
    expect(staticPack.stickers).toHaveLength(3)
  })

  it('stops before converting more assets after preparation is canceled', async () => {
    const assets = await Promise.all([asset(7), asset(8), asset(9), asset(10)])
    const controller = new AbortController()
    const progress: number[] = []

    await expect(
      new PackPreparer().prepare(
        collection(assets),
        collectionDirectory,
        (current) => {
          progress.push(current.completed)
          if (current.completed === 1) {
            controller.abort(new DOMException('cancel fixture', 'AbortError'))
          }
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(progress).toEqual([0, 1])
  })
})

function patchWebpFrameDurations(contents: Buffer, delays: number[]): Buffer {
  const patched = Buffer.from(contents)
  let offset = 12
  let frameIndex = 0
  while (offset + 8 <= patched.length) {
    const chunkType = patched.toString('ascii', offset, offset + 4)
    const chunkSize = patched.readUInt32LE(offset + 4)
    if (chunkType === 'ANMF') {
      const delay = delays[frameIndex]
      if (delay === undefined) throw new Error('测试动画包含了多余的帧')
      patched.writeUIntLE(delay, offset + 20, 3)
      frameIndex += 1
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  if (frameIndex !== delays.length) throw new Error('测试动画帧数与时长数量不一致')
  return patched
}

function patchGifFrameDurations(contents: Buffer, delayCentiseconds: number): Buffer {
  const patched = Buffer.from(contents)
  let frameCount = 0
  for (let offset = 0; offset + 7 < patched.length; offset += 1) {
    if (patched[offset] === 0x21 && patched[offset + 1] === 0xf9 && patched[offset + 2] === 0x04) {
      patched.writeUInt16LE(delayCentiseconds, offset + 4)
      frameCount += 1
    }
  }
  if (frameCount < 2) throw new Error('测试 GIF 没有多个图形控制帧')
  return patched
}
