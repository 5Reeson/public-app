import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WechatLegacySource } from '../../src/main/sources/wechat-legacy/wechat-legacy-source.js'
import { CURRENT_SCHEMA_VERSION, type StickerCollection } from '../../src/shared/domain.js'

const ACCOUNT_DIRECTORY = '0123456789abcdef0123456789abcdef'

function collection(): StickerCollection {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'default',
    title: 'Test',
    publisher: 'Tests',
    packSize: 30,
    assets: [],
    selectedAssetIds: [],
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  }
}

function archiveXml(urls: string[]): string {
  const strings = urls.map((url) => `<string>${url.replaceAll('&', '&amp;')}</string>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict><key>$archiver</key><string>NSKeyedArchiver</string><key>$objects</key><array>${strings}</array></dict></plist>`
}

describe('WechatLegacySource', () => {
  let root: string
  let collectionDirectory: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wechat-legacy-source-'))
    collectionDirectory = join(root, 'library')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeArchive(urls: string[]): Promise<void> {
    const stickers = join(root, ACCOUNT_DIRECTORY, 'Stickers')
    await mkdir(stickers, { recursive: true })
    await writeFile(join(stickers, 'fav.archive'), archiveXml(urls))
  }

  it('discovers valid account directories without exposing archive paths', async () => {
    await writeArchive(['https://stickers.example/one', 'https://stickers.example/two'])
    await mkdir(join(root, 'not-an-account', 'Stickers'), { recursive: true })
    await writeFile(join(root, 'not-an-account', 'Stickers', 'fav.archive'), archiveXml([]))

    const result = await new WechatLegacySource({ root }).discover()

    expect(result).toMatchObject({ rootFound: true, permissionDenied: false, failures: [] })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      label: '旧版微信账号 cdef',
      stickerCount: 2,
    })
    expect(result.accounts[0]).not.toHaveProperty('archivePath')
  })

  it('downloads, decodes, attributes and deduplicates legacy stickers', async () => {
    const urls = [
      'https://stickers.example/one',
      'https://stickers.example/two',
      'https://stickers.example/duplicate',
      'https://stickers.example/broken',
    ]
    await writeArchive(urls)
    const png = await sharp({
      create: { width: 40, height: 30, channels: 4, background: 'red' },
    })
      .png()
      .toBuffer()
    const gif = await sharp({
      create: { width: 30, height: 60, pageHeight: 30, channels: 4, background: 'blue' },
    })
      .gif({ delay: [80, 120], keepDuplicateFrames: true })
      .toBuffer()
    const bodies = new Map<string, Buffer>([
      [urls[0]!, png],
      [urls[1]!, gif],
      [urls[2]!, png],
      [urls[3]!, Buffer.from('not an image')],
    ])
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      return new Response(Uint8Array.from(bodies.get(String(url))!), { status: 200 })
    }) as typeof fetch
    const source = new WechatLegacySource({ root, fetcher, sleeper: async () => undefined })
    const [account] = (await source.discover()).accounts
    const progress = vi.fn()

    const result = await source.import(
      {
        accountId: account!.id,
        collection: collection(),
        collectionDirectory,
        downloadMode: 'default',
      },
      progress,
    )

    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(result.assets).toHaveLength(2)
    expect(result.duplicates).toHaveLength(1)
    expect(result.failures).toHaveLength(1)
    expect(result.assets.map((asset) => asset.sources[0]?.kind)).toEqual([
      'wechat-legacy',
      'wechat-legacy',
    ])
    expect(result.assets.every((asset) => asset.sources[0]?.accountId === account!.id)).toBe(true)
    expect(result.assets.map((asset) => asset.displayName)).toEqual([
      '微信表情 0001',
      '微信表情 0002',
    ])
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        completed: 4,
        total: 4,
        imported: 2,
        duplicates: 1,
        failed: 1,
        phase: 'importing',
      }),
    )
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ completed: 0, total: 4, phase: 'downloading' }),
    )
  })

  it('limits an account preview to the first five stickers in archive order', async () => {
    const urls = Array.from({ length: 7 }, (_, index) => `https://stickers.example/${index}`)
    await writeArchive(urls)
    const png = await sharp({
      create: { width: 24, height: 24, channels: 4, background: 'purple' },
    })
      .png()
      .toBuffer()
    const fetcher = vi.fn(async () => {
      return new Response(Uint8Array.from(png), { status: 200 })
    }) as typeof fetch
    const source = new WechatLegacySource({ root, fetcher, sleeper: async () => undefined })
    const [account] = (await source.discover()).accounts

    const result = await source.import({
      accountId: account!.id,
      collection: collection(),
      collectionDirectory,
      downloadMode: 'fast',
      maxItems: 5,
    })

    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(result.assets).toHaveLength(1)
    expect(result.duplicates).toHaveLength(4)
  })

  it.each([
    ['default', 500],
    ['safe', 1_500],
  ] as const)('spaces requests in %s download mode', async (downloadMode, expectedDelay) => {
    const urls = ['https://stickers.example/one', 'https://stickers.example/two']
    await writeArchive(urls)
    const png = await sharp({
      create: { width: 24, height: 24, channels: 4, background: 'green' },
    })
      .png()
      .toBuffer()
    const fetcher = vi.fn(async () => {
      return new Response(Uint8Array.from(png), { status: 200 })
    }) as typeof fetch
    const sleeper = vi.fn(async () => undefined)
    const source = new WechatLegacySource({ root, fetcher, random: () => 0, sleeper })
    const [account] = (await source.discover()).accounts

    await source.import({
      accountId: account!.id,
      collection: collection(),
      collectionDirectory,
      downloadMode,
    })

    expect(sleeper).toHaveBeenCalledTimes(1)
    expect(sleeper).toHaveBeenCalledWith(expectedDelay, undefined)
  })

  it('uses four workers without spacing in fast download mode', async () => {
    const urls = Array.from({ length: 4 }, (_, index) => `https://stickers.example/${index}`)
    await writeArchive(urls)
    const png = await sharp({
      create: { width: 24, height: 24, channels: 4, background: 'yellow' },
    })
      .png()
      .toBuffer()
    let activeRequests = 0
    let maximumActiveRequests = 0
    let releaseRequests: () => void = () => undefined
    const requestGate = new Promise<void>((resolve) => {
      releaseRequests = resolve
    })
    const fetcher = vi.fn(async () => {
      activeRequests += 1
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
      await requestGate
      activeRequests -= 1
      return new Response(Uint8Array.from(png), { status: 200 })
    }) as typeof fetch
    const sleeper = vi.fn(async () => undefined)
    const source = new WechatLegacySource({ root, fetcher, sleeper })
    const [account] = (await source.discover()).accounts

    const importing = source.import({
      accountId: account!.id,
      collection: collection(),
      collectionDirectory,
      downloadMode: 'fast',
    })
    await vi.waitFor(() => expect(activeRequests).toBe(4))
    releaseRequests()
    await importing

    expect(maximumActiveRequests).toBe(4)
    expect(sleeper).not.toHaveBeenCalled()
  })

  it('aborts an active request instead of retrying it', async () => {
    await writeArchive(['https://stickers.example/slow'])
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener(
          'abort',
          () => reject(signal.reason ?? new DOMException('Canceled', 'AbortError')),
          { once: true },
        )
      })
    }) as typeof fetch
    const source = new WechatLegacySource({ root, fetcher })
    const [account] = (await source.discover()).accounts
    const controller = new AbortController()

    const importing = source.import({
      accountId: account!.id,
      collection: collection(),
      collectionDirectory,
      downloadMode: 'default',
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    controller.abort(new DOMException('Canceled by test', 'AbortError'))

    await expect(importing).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
