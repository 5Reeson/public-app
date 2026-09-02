import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LocalStickerSource,
  discoverLocalFiles,
} from '../../src/main/library/local-sticker-source.js'
import {
  CURRENT_SCHEMA_VERSION,
  type ImportProgress,
  type StickerAsset,
  type StickerCollection,
} from '../../src/shared/domain.js'

function collection(assets: StickerAsset[] = []): StickerCollection {
  const now = '2026-08-08T00:00:00.000Z'
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'test-collection',
    title: 'Test stickers',
    publisher: 'Tests',
    packSize: 30,
    assets,
    selectedAssetIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

describe('LocalStickerSource', () => {
  let temporaryDirectory: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'local-sticker-source-'))
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('discovers explicit files and nested directory files in deterministic order', async () => {
    const explicit = join(temporaryDirectory, 'explicit.png')
    const selectedDirectory = join(temporaryDirectory, 'selected')
    const nestedDirectory = join(selectedDirectory, 'nested')
    await mkdir(nestedDirectory, { recursive: true })
    await Promise.all([
      writeFile(explicit, 'explicit'),
      writeFile(join(selectedDirectory, 'b.png'), 'b'),
      writeFile(join(selectedDirectory, 'a.png'), 'a'),
      writeFile(join(nestedDirectory, 'c.png'), 'c'),
    ])

    const discovered = await discoverLocalFiles([explicit, selectedDirectory])

    expect(discovered).toEqual([
      explicit,
      join(selectedDirectory, 'a.png'),
      join(selectedDirectory, 'b.png'),
      join(nestedDirectory, 'c.png'),
    ])
  })

  it('decodes supported content, preserves source files, and reports invalid and duplicate files', async () => {
    const sources = join(temporaryDirectory, 'sources')
    const collectionDirectory = join(temporaryDirectory, 'library', 'collection')
    await mkdir(sources, { recursive: true })

    // Extension is intentionally wrong. Detection must use decoded content.
    const pngWithWrongExtension = join(sources, 'yellow-sticker.bin')
    const duplicate = join(sources, 'yellow-sticker-copy.png')
    const jpeg = join(sources, 'photo.jpg')
    const invalid = join(sources, 'broken.webp')
    await sharp({
      create: {
        width: 18,
        height: 12,
        channels: 4,
        background: '#f4c542',
      },
    })
      .png()
      .toFile(pngWithWrongExtension)
    await writeFile(duplicate, await readFile(pngWithWrongExtension))
    await sharp({
      create: {
        width: 9,
        height: 7,
        channels: 3,
        background: '#178f7a',
      },
    })
      .jpeg()
      .toFile(jpeg)
    await writeFile(invalid, 'not an image')

    const originalPngBytes = await readFile(pngWithWrongExtension)
    const progress: ImportProgress[] = []
    const result = await new LocalStickerSource().import(
      {
        collection: collection(),
        collectionDirectory,
        inputs: [pngWithWrongExtension, duplicate, invalid, jpeg],
      },
      (update) => {
        progress.push(update)
      },
    )

    expect(result.assets).toHaveLength(2)
    expect(result.assets.map((asset) => asset.displayName)).toEqual(['yellow-sticker', 'photo'])
    expect(result.assets.map((asset) => asset.mimeType)).toEqual(['image/png', 'image/jpeg'])
    expect(result.assets.map((asset) => [asset.width, asset.height])).toEqual([
      [18, 12],
      [9, 7],
    ])
    expect(result.assets.map((asset) => asset.sourceOrder)).toEqual([0, 1])
    expect(result.assets.map((asset) => asset.userOrder)).toEqual([0, 1])
    expect(result.duplicates).toEqual([duplicate])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.path).toBe(invalid)
    expect(result.failures[0]?.reason).toMatch(/unsupported|unreadable|image/i)

    const importedPng = result.assets[0]!
    expect(importedPng.id).toMatch(/^asset-[a-f0-9]{24}$/)
    expect(importedPng.originalPath).toBe(
      join(collectionDirectory, 'originals', `${importedPng.id}.png`),
    )
    expect(await readFile(importedPng.originalPath)).toEqual(originalPngBytes)
    expect(await readFile(pngWithWrongExtension)).toEqual(originalPngBytes)
    expect((await stat(join(collectionDirectory, 'originals'))).mode & 0o777).toBe(0o700)
    expect((await stat(importedPng.originalPath)).mode & 0o777).toBe(0o600)

    expect(progress[0]).toMatchObject({ completed: 0, total: 4 })
    expect(progress.at(-1)).toMatchObject({
      completed: 4,
      total: 4,
      imported: 2,
      duplicates: 1,
      failed: 1,
      currentPath: jpeg,
    })
  })

  it('deduplicates against existing collection assets and keeps their order offset', async () => {
    const source = join(temporaryDirectory, 'same.png')
    const newSource = join(temporaryDirectory, 'new.webp')
    const collectionDirectory = join(temporaryDirectory, 'collection')
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: '#df4d7d',
      },
    })
      .png()
      .toFile(source)
    await sharp({
      create: {
        width: 10,
        height: 11,
        channels: 4,
        background: '#395bc9',
      },
    })
      .webp()
      .toFile(newSource)

    const first = await new LocalStickerSource().import({
      collection: collection(),
      collectionDirectory,
      inputs: [source],
    })
    const existing = {
      ...first.assets[0]!,
      sourceOrder: 4,
      userOrder: 7,
    }
    const second = await new LocalStickerSource().import({
      collection: collection([existing]),
      collectionDirectory,
      inputs: [source, newSource],
    })

    expect(second.duplicates).toEqual([source])
    expect(second.assets).toHaveLength(1)
    expect(second.sourceUpdates).toHaveLength(1)
    expect(second.sourceUpdates[0]?.sources).toHaveLength(2)
    expect(second.assets[0]).toMatchObject({
      displayName: 'new',
      mimeType: 'image/webp',
      sourceOrder: 5,
      userOrder: 8,
    })
    expect(basename(second.assets[0]!.originalPath)).toBe(`${second.assets[0]!.id}.webp`)
  })

  it('merges account provenance when the same content is imported from two sources', async () => {
    const source = join(temporaryDirectory, 'same.png')
    const collectionDirectory = join(temporaryDirectory, 'collection')
    await sharp({ create: { width: 12, height: 12, channels: 4, background: '#445566' } })
      .png()
      .toFile(source)
    const importer = new LocalStickerSource()
    const first = await importer.importAttributed(
      { collection: collection(), collectionDirectory, inputs: [source] },
      {
        sourceKind: 'wechat4',
        sourceAccountId: 'wechat4-account-a',
        sourceLabel: '新版微信账号 · 0001',
      },
    )
    const second = await importer.importAttributed(
      { collection: collection(first.assets), collectionDirectory, inputs: [source] },
      {
        sourceKind: 'wechat4',
        sourceAccountId: 'wechat4-account-b',
        sourceLabel: '新版微信账号 · 0002',
      },
    )

    expect(second.assets).toEqual([])
    expect(second.duplicates).toEqual([source])
    expect(second.sourceUpdates).toHaveLength(1)
    expect(second.sourceUpdates[0]?.sources.map((item) => item.accountId)).toEqual([
      'wechat4-account-a',
      'wechat4-account-b',
    ])
    expect(new Set(second.sourceUpdates[0]?.sources.map((item) => item.id)).size).toBe(2)
  })

  it('retains two official album sources from the same account after de-duplication', async () => {
    const source = join(temporaryDirectory, 'same-official.png')
    const collectionDirectory = join(temporaryDirectory, 'collection-official')
    await sharp({ create: { width: 12, height: 12, channels: 4, background: '#775544' } })
      .png()
      .toFile(source)
    const importer = new LocalStickerSource()
    const first = await importer.importAttributed(
      { collection: collection(), collectionDirectory, inputs: [source] },
      {
        sourceKind: 'wechat4',
        sourceAccountId: 'wechat4-account-a',
        sourceAlbum: { kind: 'official', id: 'album-a', name: '专辑 A' },
      },
    )
    const second = await importer.importAttributed(
      { collection: collection(first.assets), collectionDirectory, inputs: [source] },
      {
        sourceKind: 'wechat4',
        sourceAccountId: 'wechat4-account-a',
        sourceAlbum: { kind: 'official', id: 'album-b', name: '专辑 B' },
      },
    )

    expect(second.sourceUpdates[0]?.sources.map((item) => item.album?.id)).toEqual([
      'album-a',
      'album-b',
    ])
    expect(new Set(second.sourceUpdates[0]?.sources.map((item) => item.id)).size).toBe(2)
  })

  it('marks multi-page images as animated and records their duration', async () => {
    const animated = join(temporaryDirectory, 'animated.gif')
    const collectionDirectory = join(temporaryDirectory, 'collection')
    const frameHeight = 6
    await sharp({
      create: {
        width: 6,
        height: frameHeight * 2,
        pageHeight: frameHeight,
        channels: 4,
        background: '#cc3366',
      },
    })
      .gif({
        delay: [80, 120],
        loop: 0,
        keepDuplicateFrames: true,
      })
      .toFile(animated)

    const result = await new LocalStickerSource().import({
      collection: collection(),
      collectionDirectory,
      inputs: [animated],
    })

    expect(result.failures).toEqual([])
    expect(result.assets[0]).toMatchObject({
      animated: true,
      width: 6,
      height: frameHeight,
      durationMs: 200,
      mimeType: 'image/gif',
    })
  })

  it('records a player-compatible duration for zero-delay GIFs', async () => {
    const animated = join(temporaryDirectory, 'zero-delay.gif')
    const collectionDirectory = join(temporaryDirectory, 'collection')
    await sharp({
      create: {
        width: 6,
        height: 18,
        pageHeight: 6,
        channels: 4,
        background: '#3366cc',
      },
    })
      .gif({ delay: [0, 0, 0], loop: 0, keepDuplicateFrames: true })
      .toFile(animated)
    const metadata = await sharp(animated, { animated: true, pages: -1 }).metadata()

    const result = await new LocalStickerSource().import({
      collection: collection(),
      collectionDirectory,
      inputs: [animated],
    })

    expect(result.failures).toEqual([])
    expect(result.assets[0]).toMatchObject({
      animated: true,
      durationMs: metadata.pages! * 100,
      mimeType: 'image/gif',
    })
  })

  it('removes originals created by an import that is canceled before manifest persistence', async () => {
    const first = join(temporaryDirectory, 'first.png')
    const second = join(temporaryDirectory, 'second.png')
    const collectionDirectory = join(temporaryDirectory, 'collection')
    await sharp({
      create: { width: 12, height: 12, channels: 4, background: 'red' },
    })
      .png()
      .toFile(first)
    await sharp({
      create: { width: 12, height: 12, channels: 4, background: 'blue' },
    })
      .png()
      .toFile(second)
    const controller = new AbortController()

    const importing = new LocalStickerSource().import(
      {
        collection: collection(),
        collectionDirectory,
        inputs: [first, second],
        signal: controller.signal,
      },
      (progress) => {
        if (progress.completed === 1) {
          controller.abort(new DOMException('Canceled by test', 'AbortError'))
        }
      },
    )

    await expect(importing).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(join(collectionDirectory, 'originals'))).toEqual([])
  })
})
