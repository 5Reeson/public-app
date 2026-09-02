import { createCipheriv, createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Wechat4PersonalEmoticon } from '../../src/main/sources/wechat4/personal-emoticon-catalog.js'
import type { Wechat4PersonalEmoticonReader } from '../../src/main/sources/wechat4/personal-emoticon-reader.js'
import { Wechat4StickerSource } from '../../src/main/sources/wechat4/wechat4-source.js'
import { discoverWechat4 } from '../../src/main/sources/wechat4/wechat4-layout.js'
import { createDefaultCollection } from '../../src/main/library/manifest-store.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function record(
  order: number,
  md5: string,
  fields: Partial<Wechat4PersonalEmoticon> = {},
): Wechat4PersonalEmoticon {
  return {
    order,
    group: 'favorite',
    type: 1,
    md5,
    caption: '',
    thumbUrl: '',
    tpUrl: '',
    cdnUrl: '',
    externUrl: '',
    encryptUrl: '',
    aesKey: '',
    authKey: '',
    ...fields,
  }
}

async function fixture(): Promise<{
  root: string
  temporaryParent: string
  collectionDirectory: string
  accountId: string
}> {
  const parent = await mkdtemp(join(tmpdir(), 'wechat4-source-test-'))
  cleanup.push(parent)
  const root = join(parent, 'xwechat_files')
  const account = join(root, 'wxid_synthetic_source_abcd')
  const database = join(account, 'db_storage', 'emoticon')
  const temporaryParent = join(parent, 'temporary')
  const collectionDirectory = join(parent, 'collection')
  await Promise.all([
    mkdir(database, { recursive: true }),
    mkdir(temporaryParent, { recursive: true }),
    mkdir(collectionDirectory, { recursive: true }),
  ])
  await writeFile(join(database, 'emoticon.db'), 'synthetic encrypted snapshot')
  const [discovered] = (await discoverWechat4(root)).accounts
  return { root, temporaryParent, collectionDirectory, accountId: discovered!.id }
}

describe('Wechat4StickerSource', () => {
  it.each([
    ['safe', 1],
    ['fast', 4],
  ] as const)(
    'applies %s concurrency to CDN fallback only',
    async (downloadMode, expectedActive) => {
      const setup = await fixture()
      const images = await Promise.all(
        ['#ff1100ff', '#11ff00ff', '#0011ffff', '#ffaa00ff'].map((background) =>
          sharp({ create: { width: 9, height: 9, channels: 4, background } })
            .png()
            .toBuffer(),
        ),
      )
      const records = images.map((bytes, index) =>
        record(index, createHash('md5').update(bytes).digest('hex'), {
          cdnUrl: `https://synthetic.invalid/speed-${index}`,
        }),
      )
      let activeRequests = 0
      let maximumActiveRequests = 0
      let releaseRequests: () => void = () => undefined
      const requestGate = new Promise<void>((resolve) => {
        releaseRequests = resolve
      })
      const source = new Wechat4StickerSource({
        root: setup.root,
        temporaryParent: setup.temporaryParent,
        catalogReader: { read: async () => records },
        resolutionConcurrency: 4,
        fetcher: async (input) => {
          const index = Number(String(input).at(-1))
          activeRequests += 1
          maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
          await requestGate
          activeRequests -= 1
          return new Response(new Blob([Uint8Array.from(images[index]!)]))
        },
        sleeper: async () => undefined,
      })

      const importing = source.import({
        accountId: setup.accountId,
        collection: createDefaultCollection(undefined),
        collectionDirectory: setup.collectionDirectory,
        downloadMode,
      })
      await vi.waitFor(() => expect(activeRequests).toBe(expectedActive))
      releaseRequests()
      await importing

      expect(maximumActiveRequests).toBe(expectedActive)
      images.forEach((bytes) => bytes.fill(0))
    },
  )

  it('keeps database order when bounded remote workers finish out of order', async () => {
    const setup = await fixture()
    const images = await Promise.all(
      ['#ff1100ff', '#11ff00ff', '#0011ffff'].map((background) =>
        sharp({ create: { width: 9, height: 9, channels: 4, background } })
          .png()
          .toBuffer(),
      ),
    )
    const records = images.map((bytes, index) =>
      record(index, createHash('md5').update(bytes).digest('hex'), {
        cdnUrl: `https://synthetic.invalid/concurrent-${index}`,
      }),
    )
    const source = new Wechat4StickerSource({
      root: setup.root,
      temporaryParent: setup.temporaryParent,
      catalogReader: { read: async () => records },
      resolutionConcurrency: 3,
      fetcher: async (input) => {
        const index = Number(String(input).at(-1))
        await new Promise((resolve) => setTimeout(resolve, (2 - index) * 10))
        return new Response(new Blob([Uint8Array.from(images[index]!)]))
      },
      sleeper: async () => undefined,
    })

    const result = await source.import({
      accountId: setup.accountId,
      collection: createDefaultCollection(undefined),
      collectionDirectory: setup.collectionDirectory,
    })

    expect(result.assets.map((asset) => asset.sourceOrder)).toEqual([0, 1, 2])
    expect(result.assets.map((asset) => asset.displayName)).toEqual([
      '微信表情 0001',
      '微信表情 0002',
      '微信表情 0003',
    ])
    images.forEach((bytes) => bytes.fill(0))
  })

  it('forces an authorized live refresh and reads a new snapshot when cached rows have no assets', async () => {
    const setup = await fixture()
    const remotePng = await sharp({
      create: { width: 10, height: 10, channels: 4, background: '#123456ff' },
    })
      .png()
      .toBuffer()
    const md5 = createHash('md5').update(remotePng).digest('hex')
    const calls: Array<{ forceAcquire: boolean; databasePath: string }> = []
    const catalogReader: Wechat4PersonalEmoticonReader = {
      read: async ({ forceAcquire, snapshot }) => {
        calls.push({ forceAcquire: forceAcquire === true, databasePath: snapshot.databasePath })
        return [
          record(
            0,
            md5,
            calls.length === 3 ? { cdnUrl: 'https://synthetic.invalid/refreshed' } : {},
          ),
        ]
      },
    }
    const source = new Wechat4StickerSource({
      root: setup.root,
      temporaryParent: setup.temporaryParent,
      catalogReader,
      refreshMissingMetadata: true,
      fetcher: async () => new Response(new Blob([Uint8Array.from(remotePng)])),
      sleeper: async () => undefined,
    })

    const result = await source.import({
      accountId: setup.accountId,
      collection: createDefaultCollection(undefined),
      collectionDirectory: setup.collectionDirectory,
    })

    expect(result.assets).toHaveLength(1)
    expect(calls.map((call) => call.forceAcquire)).toEqual([false, true, false])
    expect(calls[1]!.databasePath).toBe(calls[0]!.databasePath)
    expect(calls[2]!.databasePath).not.toBe(calls[0]!.databasePath)
    remotePng.fill(0)
  })

  it('preserves database order, prefers the MD5 cache, decrypts CDN fallback, and imports through the shared library', async () => {
    const setup = await fixture()
    const localPng = await sharp({
      create: { width: 12, height: 10, channels: 4, background: '#ff0000ff' },
    })
      .png()
      .toBuffer()
    const plainPng = await sharp({
      create: { width: 14, height: 11, channels: 4, background: '#00ff00ff' },
    })
      .png()
      .toBuffer()
    const encryptedPng = await sharp({
      create: { width: 16, height: 13, channels: 4, background: '#0000ffff' },
    })
      .png()
      .toBuffer()
    const encryptedCachePng = await sharp({
      create: { width: 18, height: 15, channels: 4, background: '#ff00ffff' },
    })
      .png()
      .toBuffer()
    const localMd5 = createHash('md5').update(localPng).digest('hex')
    const plainMd5 = createHash('md5').update(plainPng).digest('hex')
    const encryptedMd5 = createHash('md5').update(encryptedPng).digest('hex')
    const encryptedCacheMd5 = createHash('md5').update(encryptedCachePng).digest('hex')
    const missingMd5 = '55000000000000000000000000000005'
    const cacheDirectory = join(
      setup.root,
      'wxid_synthetic_source_abcd',
      'business',
      'emoticon',
      'Persist',
      localMd5.slice(0, 2),
    )
    await mkdir(cacheDirectory, { recursive: true })
    await writeFile(join(cacheDirectory, localMd5), localPng)

    const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const zeroPad = (bytes: Buffer) => {
      const padded = Buffer.alloc(Math.ceil(bytes.length / 16) * 16)
      bytes.copy(padded)
      return padded
    }
    const cipher = createCipheriv('aes-128-cbc', aesKey, aesKey)
    cipher.setAutoPadding(false)
    const encryptedDownload = Buffer.concat([cipher.update(zeroPad(encryptedPng)), cipher.final()])
    const cacheCipher = createCipheriv('aes-128-cbc', aesKey, aesKey)
    cacheCipher.setAutoPadding(false)
    const encryptedCache = Buffer.concat([
      cacheCipher.update(zeroPad(encryptedCachePng)),
      cacheCipher.final(),
    ])
    const encryptedCacheDirectory = join(
      setup.root,
      'wxid_synthetic_source_abcd',
      'business',
      'emoticon',
      'Persist',
      encryptedCacheMd5.slice(0, 2),
    )
    await mkdir(encryptedCacheDirectory, { recursive: true })
    await writeFile(join(encryptedCacheDirectory, encryptedCacheMd5), encryptedCache)
    aesKey.fill(0)
    const records = [
      record(0, localMd5, { cdnUrl: 'https://synthetic.invalid/must-not-fetch' }),
      record(1, plainMd5, { cdnUrl: 'http://synthetic.invalid/plain' }),
      record(2, encryptedMd5, {
        encryptUrl:
          'metadata before https://synthetic.invalid/lower-score and https://synthetic.invalid/encrypted',
        aesKey: '00112233445566778899aabbccddeeff',
      }),
      record(3, encryptedCacheMd5, {
        cdnUrl: 'https://synthetic.invalid/must-not-fetch-encrypted-cache',
        aesKey: 'ABEiM0RVZneImaq7zN3u/w==',
      }),
      record(4, missingMd5),
    ]
    const catalogReader: Wechat4PersonalEmoticonReader = {
      read: async ({ snapshot }) => {
        expect(snapshot.databasePath).toContain('cn-memes-wechat4-snapshot-')
        return records
      },
    }
    const fetched: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const url = String(input)
      fetched.push(url)
      if (url.endsWith('/plain')) return new Response(new Blob([Uint8Array.from(plainPng)]))
      if (url.endsWith('/encrypted')) {
        return new Response(new Blob([Uint8Array.from(encryptedDownload)]))
      }
      if (url.endsWith('/lower-score')) return new Response(null, { status: 404 })
      return new Response(null, { status: 404 })
    }
    const progressPaths: string[] = []
    const source = new Wechat4StickerSource({
      root: setup.root,
      temporaryParent: setup.temporaryParent,
      catalogReader,
      fetcher,
      sleeper: async () => undefined,
    })

    const result = await source.import(
      {
        accountId: setup.accountId,
        collection: createDefaultCollection(undefined),
        collectionDirectory: setup.collectionDirectory,
      },
      (progress) => {
        if (progress.currentPath) progressPaths.push(progress.currentPath)
      },
    )

    expect(source.kind).toBe('wechat4')
    expect(result.assets).toHaveLength(4)
    expect(result.assets.map((asset) => asset.sources[0]?.kind)).toEqual([
      'wechat4',
      'wechat4',
      'wechat4',
      'wechat4',
    ])
    expect(result.assets.map((asset) => asset.sources[0]?.accountId)).toEqual([
      setup.accountId,
      setup.accountId,
      setup.accountId,
      setup.accountId,
    ])
    expect(result.assets.map((asset) => asset.sourceOrder)).toEqual([0, 1, 2, 3])
    expect(result.assets.map((asset) => asset.displayName)).toEqual([
      '微信表情 0001',
      '微信表情 0002',
      '微信表情 0003',
      '微信表情 0004',
    ])
    expect(result.failures).toEqual([{ path: '微信表情 0005', reason: '本地缓存和 CDN 均不可用' }])
    expect(fetched).toEqual([
      'https://synthetic.invalid/plain',
      'https://synthetic.invalid/lower-score',
      'https://synthetic.invalid/encrypted',
    ])
    expect(progressPaths.every((path) => /^微信表情 \d{4}$/.test(path))).toBe(true)
    expect(records).toHaveLength(0)
    expect(
      (await readdir(setup.temporaryParent)).every(
        (entry) =>
          !entry.startsWith('cn-memes-wechat4-snapshot-') &&
          !entry.startsWith('cn-memes-wechat4-assets-'),
      ),
    ).toBe(true)

    localPng.fill(0)
    plainPng.fill(0)
    encryptedPng.fill(0)
    encryptedCachePng.fill(0)
    encryptedDownload.fill(0)
    encryptedCache.fill(0)
  })

  it('imports selected locally staged official packs separately from personal favorites', async () => {
    const setup = await fixture()
    const officialPng = await sharp({
      create: { width: 11, height: 9, channels: 4, background: '#663399ff' },
    })
      .png()
      .toBuffer()
    const source = new Wechat4StickerSource({
      root: setup.root,
      temporaryParent: setup.temporaryParent,
      catalogReader: { read: async () => [] },
      officialStager: {
        stage: async ({ stagingDirectory }) => {
          const path = join(stagingDirectory, 'official.asset')
          await writeFile(path, officialPng)
          return [
            {
              path,
              label: '合成官方专辑·001',
              packageId: 'synthetic.package',
              packageName: '合成官方专辑',
              memberIndex: 0,
            },
          ]
        },
      },
    })

    const result = await source.importOfficialAlbums({
      accountId: setup.accountId,
      collection: createDefaultCollection(undefined),
      collectionDirectory: setup.collectionDirectory,
      packageIds: ['synthetic.package'],
    })

    expect(result.assets).toHaveLength(1)
    expect(result.assets[0]?.displayName).toBe('合成官方专辑·001')
    expect(result.assets[0]?.sources[0]?.kind).toBe('wechat4')
    expect(result.assets[0]?.sources[0]?.album).toEqual({
      kind: 'official',
      id: 'synthetic.package',
      name: '合成官方专辑',
    })
    expect(result.failures).toEqual([])
    officialPng.fill(0)
  })

  it('keeps decrypted official files until the attributed import has finished', async () => {
    const setup = await fixture()
    const officialPng = await sharp({
      create: { width: 11, height: 9, channels: 4, background: '#335577ff' },
    })
      .png()
      .toBuffer()
    let stagedPath = ''
    let releaseProgress: () => void = () => undefined
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve
    })
    let reportStarted: () => void = () => undefined
    const firstReport = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    let held = false
    const source = new Wechat4StickerSource({
      root: setup.root,
      temporaryParent: setup.temporaryParent,
      catalogReader: { read: async () => [] },
      officialStager: {
        stage: async ({ stagingDirectory }) => {
          stagedPath = join(stagingDirectory, 'official.asset')
          await writeFile(stagedPath, officialPng)
          return [
            {
              path: stagedPath,
              label: '合成官方专辑·001',
              packageId: 'synthetic.package',
              packageName: '合成官方专辑',
              memberIndex: 0,
            },
          ]
        },
      },
    })

    const importing = source.importOfficialAlbums(
      {
        accountId: setup.accountId,
        collection: createDefaultCollection(undefined),
        collectionDirectory: setup.collectionDirectory,
        packageIds: ['synthetic.package'],
      },
      async () => {
        if (held) return
        held = true
        reportStarted()
        await progressGate
      },
    )

    await firstReport
    await new Promise((resolve) => setTimeout(resolve, 25))
    await expect(access(stagedPath)).resolves.toBeUndefined()
    releaseProgress()
    const result = await importing

    expect(result.assets).toHaveLength(1)
    await expect(access(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    officialPng.fill(0)
  })

  it('keeps personal imports usable when official-pack staging fails', async () => {
    const setup = await fixture()
    const personalPng = await sharp({
      create: { width: 10, height: 8, channels: 4, background: '#228833ff' },
    })
      .png()
      .toBuffer()
    const personalMd5 = createHash('md5').update(personalPng).digest('hex')
    const cacheRoot = join(
      setup.root,
      'wxid_synthetic_source_abcd',
      'business',
      'emoticon',
      'Persist',
      personalMd5.slice(0, 2),
    )
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(join(cacheRoot, personalMd5), personalPng)
    const source = new Wechat4StickerSource({
      root: setup.root,
      temporaryParent: setup.temporaryParent,
      catalogReader: { read: async () => [record(0, personalMd5)] },
      officialStager: { stage: async () => Promise.reject(new Error('sensitive detail')) },
    })

    const result = await source.import({
      accountId: setup.accountId,
      collection: createDefaultCollection(undefined),
      collectionDirectory: setup.collectionDirectory,
    })

    expect(result.assets).toHaveLength(1)
    expect(result.failures).toEqual([])
    expect(JSON.stringify(result)).not.toContain('sensitive detail')
    personalPng.fill(0)
  })
})
