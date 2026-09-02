import { createCipheriv, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import {
  LocalWechat4OfficialEmoticonStager,
  type Wechat4StoreEmoticonCatalogReader,
} from '../../src/main/sources/wechat4/store-emoticon-reader.js'
import type { Wechat4StoreEmoticon } from '../../src/main/sources/wechat4/store-emoticon-catalog.js'
import type { Wechat4StoreKeyCache } from '../../src/main/sources/wechat4/wechat4-store-key-store.js'
import { discoverWechat4 } from '../../src/main/sources/wechat4/wechat4-layout.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('LocalWechat4OfficialEmoticonStager', () => {
  it('rejects an invalid item limit before reading account data', async () => {
    let read = false
    const stager = new LocalWechat4OfficialEmoticonStager({
      catalogReader: {
        read: async () => {
          read = true
          return []
        },
      },
      keyStore: {
        load: async () => undefined,
        save: async () => undefined,
        clear: async () => undefined,
      },
    })

    await expect(
      stager.stage({
        accountId: 'wechat4-0123456789abcdef',
        snapshot: { directory: '/private/tmp', databasePath: '/private/tmp/db', sidecars: [] },
        stagingDirectory: '/private/tmp',
        maxItems: -1,
      }),
    ).rejects.toThrow(/item limit/i)
    expect(read).toBe(false)
  })

  it('replaces a stale cached key, validates every member, stages images, and reuses the safe cache', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wechat4-official-stager-'))
    cleanup.push(parent)
    const root = join(parent, 'xwechat_files')
    const accountName = 'wxid_synthetic_official_abcd'
    const accountRoot = join(root, accountName)
    const databaseRoot = join(accountRoot, 'db_storage', 'emoticon')
    const staging = join(parent, 'staging')
    const secondStaging = join(parent, 'staging-second')
    const kvcomm = join(parent, 'kvcomm')
    await Promise.all([
      mkdir(databaseRoot, { recursive: true }),
      mkdir(staging, { recursive: true }),
      mkdir(secondStaging, { recursive: true }),
      mkdir(kvcomm, { recursive: true }),
    ])
    await writeFile(join(databaseRoot, 'emoticon.db'), 'synthetic encrypted database')
    const [account] = (await discoverWechat4(root)).accounts

    const images = await Promise.all(
      ['#ff3300ff', '#0066ffff'].map((background) =>
        sharp({ create: { width: 12, height: 10, channels: 4, background } })
          .png()
          .toBuffer(),
      ),
    )
    const packageId = '10000000000000000000000000000001'
    const code = '1234567890'
    const key = createHash('md5').update(`${code}${accountName}EMOTICON`).digest()
    const plaintext = Buffer.concat(images)
    const cipher = createCipheriv('aes-128-cbc', key, key)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const containerName = createHash('md5').update(packageId).digest('hex')
    const containerRoot = join(
      accountRoot,
      'business',
      'emoticon',
      'PersistStore',
      containerName.slice(0, 2),
    )
    await mkdir(containerRoot, { recursive: true })
    await writeFile(join(containerRoot, containerName), encrypted)
    await writeFile(join(kvcomm, `key_${code}_synthetic.statistic`), '')

    const makeRecords = (): Wechat4StoreEmoticon[] => [
      {
        order: 0,
        packageId,
        packageName: '合成官方专辑',
        downloadStatus: 2,
        removeTime: 0,
        md5: createHash('md5').update(images[0]!).digest('hex'),
        type: 1,
        sortOrder: 0,
        emoticonSize: images[0]!.length,
        emoticonOffset: 0,
        thumbSize: 0,
        thumbOffset: 0,
        hasEncryptedRemote: false,
        hasAnyRemote: false,
      },
      {
        order: 1,
        packageId,
        packageName: '合成官方专辑',
        downloadStatus: 2,
        removeTime: 0,
        md5: createHash('md5').update(images[1]!).digest('hex'),
        type: 1,
        sortOrder: 1,
        emoticonSize: images[1]!.length,
        emoticonOffset: images[0]!.length,
        thumbSize: 0,
        thumbOffset: 0,
        hasEncryptedRemote: false,
        hasAnyRemote: false,
      },
    ]
    const catalogReader: Wechat4StoreEmoticonCatalogReader = { read: async () => makeRecords() }
    let cached = Buffer.alloc(16, 0x99)
    let clearCount = 0
    let saveCount = 0
    const keyStore: Wechat4StoreKeyCache = {
      load: async () => Buffer.from(cached),
      save: async (_accountId, saved) => {
        cached.fill(0)
        cached = Buffer.from(saved)
        saveCount += 1
      },
      clear: async () => {
        cached.fill(0)
        cached = Buffer.alloc(0)
        clearCount += 1
      },
    }
    const stager = new LocalWechat4OfficialEmoticonStager({
      catalogReader,
      keyStore,
      root,
      kvcommDirectory: kvcomm,
    })

    const first = await stager.stage({
      accountId: account!.id,
      snapshot: { directory: parent, databasePath: join(parent, 'snapshot.db'), sidecars: [] },
      stagingDirectory: staging,
    })
    expect(first.map((asset) => asset.label)).toEqual(['合成官方专辑·001', '合成官方专辑·002'])
    expect(await readFile(first[0]!.path)).toEqual(images[0])
    expect(await readFile(first[1]!.path)).toEqual(images[1])
    expect(clearCount).toBe(1)
    expect(saveCount).toBe(1)
    expect(cached.equals(key)).toBe(true)

    await rm(kvcomm, { recursive: true, force: true })
    const second = await stager.stage({
      accountId: account!.id,
      snapshot: { directory: parent, databasePath: join(parent, 'snapshot.db'), sidecars: [] },
      stagingDirectory: secondStaging,
      packageIds: [packageId],
      maxItemsPerPackage: 1,
    })
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({
      packageId,
      packageName: '合成官方专辑',
      memberIndex: 0,
    })
    expect(await readFile(second[0]!.path)).toEqual(images[0])
    expect(saveCount).toBe(1)

    images.forEach((bytes) => bytes.fill(0))
    plaintext.fill(0)
    encrypted.fill(0)
    key.fill(0)
    cached.fill(0)
  })
})
