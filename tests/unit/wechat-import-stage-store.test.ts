import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WechatImportStageStore } from '../../src/main/sources/wechat-import-stage-store.js'
import type { ImportResult, StickerAsset } from '../../src/shared/domain.js'

const cleanup: string[] = []
const ACCOUNT_ID = 'wechat-legacy-0123456789abcdef'

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function asset(id: string, originalPath: string): StickerAsset {
  return {
    id,
    displayName: id,
    originalPath,
    sha256: (id === 'kept' ? 'b' : 'a').repeat(64),
    mimeType: 'image/png',
    animated: false,
    width: 20,
    height: 20,
    importedAt: '2026-08-22T00:00:00.000Z',
    sourceOrder: 0,
    userOrder: 0,
    sources: [
      {
        id: `source-${id}`,
        kind: 'wechat-legacy',
        label: '旧版微信账号 cdef',
        accountId: ACCOUNT_ID,
        importedAt: '2026-08-22T00:00:00.000Z',
      },
    ],
  }
}

describe('WechatImportStageStore', () => {
  it('persists staged assets under the managed account directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wechat-import-stage-'))
    cleanup.push(root)
    const store = new WechatImportStageStore(root)

    const staged = await store.replace(
      'preview',
      'legacy',
      ACCOUNT_ID,
      async (_collection, dir) => {
        const originalPath = join(dir, 'originals', 'preview.png')
        await mkdir(join(dir, 'originals'), { recursive: true })
        await writeFile(originalPath, 'preview')
        const imported = asset('preview', originalPath)
        return { assets: [imported], sourceUpdates: [], duplicates: [], failures: [] }
      },
    )

    const target = store.directory('preview', 'legacy', ACCOUNT_ID)
    expect(staged.collection.assets[0]?.originalPath).toBe(join(target, 'originals', 'preview.png'))
    await expect(access(staged.collection.assets[0]!.originalPath)).resolves.toBeUndefined()
    expect((await store.load('preview', 'legacy', ACCOUNT_ID))?.assets).toEqual(
      staged.collection.assets,
    )
  })

  it('keeps the previous successful preview when a refresh fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wechat-import-stage-'))
    cleanup.push(root)
    const store = new WechatImportStageStore(root)
    const successfulImport = async (_collection: unknown, dir: string): Promise<ImportResult> => {
      const originalPath = join(dir, 'originals', 'kept.png')
      await mkdir(join(dir, 'originals'), { recursive: true })
      await writeFile(originalPath, 'kept')
      return {
        assets: [asset('kept', originalPath)],
        sourceUpdates: [],
        duplicates: [],
        failures: [],
      }
    }
    await store.replace('preview', 'legacy', ACCOUNT_ID, successfulImport)

    await expect(
      store.replace('preview', 'legacy', ACCOUNT_ID, async () => {
        throw new Error('refresh failed')
      }),
    ).rejects.toThrow('refresh failed')

    const previous = await store.load('preview', 'legacy', ACCOUNT_ID)
    expect(previous?.assets.map((item) => item.id)).toEqual(['kept'])
    await expect(access(previous!.assets[0]!.originalPath)).resolves.toBeUndefined()
  })
})
