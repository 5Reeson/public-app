import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { unzipSync } from 'fflate'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PreparedPack } from '../../src/main/packs/pack-preparer.js'
import { buildNativeStickerPackPayload } from '../../src/main/whatsapp/native-pack.js'

describe('buildNativeStickerPackPayload', () => {
  let temporaryDirectory: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'native-pack-'))
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('zips prepared stickers in preview order followed by the tray icon', async () => {
    const stickerPaths: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const path = join(temporaryDirectory, `${index}.webp`)
      await writeFile(
        path,
        await sharp({
          create: {
            width: 512,
            height: 512,
            channels: 4,
            background: { r: 40 * index, g: 120, b: 200, alpha: 1 },
          },
        })
          .webp()
          .toBuffer(),
      )
      stickerPaths.push(path)
    }
    const trayPath = join(temporaryDirectory, 'tray.png')
    await writeFile(
      trayPath,
      await sharp({
        create: { width: 96, height: 96, channels: 4, background: 'blue' },
      })
        .png()
        .toBuffer(),
    )
    const pack: PreparedPack = {
      id: 'pack-id',
      name: 'Ordered pack',
      publisher: 'Tests',
      mediaKind: 'static',
      status: 'prepared',
      trayPath,
      traySizeBytes: 1,
      assetFailures: [],
      stickers: stickerPaths.map((outputPath, index) => ({
        assetId: `asset-${index}`,
        outputPath,
        sizeBytes: 1,
      })),
    }

    const payload = await buildNativeStickerPackPayload(pack)
    expect(payload.stickerFiles.map((sticker) => sticker.fileName)).toEqual([
      'sticker-01.webp',
      'sticker-02.webp',
      'sticker-03.webp',
    ])
    expect(Object.keys(unzipSync(payload.zip))).toEqual([
      'sticker-01.webp',
      'sticker-02.webp',
      'sticker-03.webp',
      'tray.png',
    ])
    const thumbnail = await sharp(payload.thumbnailJpeg).metadata()
    expect([thumbnail.format, thumbnail.width, thumbnail.height]).toEqual(['jpeg', 252, 252])
  })
})
