import { describe, expect, it, vi } from 'vitest'

import { AssetPreviewIndex } from '../../src/main/library/asset-preview-index.js'
import { createDefaultCollection } from '../../src/main/library/manifest-store.js'

describe('AssetPreviewIndex', () => {
  it('coalesces the initial manifest load and serves subsequent lookups from memory', async () => {
    const collection = fixtureCollection('first')
    const loadCollection = vi.fn(async () => collection)
    const index = new AssetPreviewIndex()

    const [first, second] = await Promise.all([
      index.find('asset-first', loadCollection),
      index.find('asset-first', loadCollection),
    ])

    expect(first).toEqual(second)
    expect(loadCollection).toHaveBeenCalledTimes(1)
    expect(await index.find('asset-first', loadCollection)).toEqual(first)
    expect(await index.find('missing', loadCollection)).toBeUndefined()
    expect(loadCollection).toHaveBeenCalledTimes(1)
  })

  it('replaces stale paths when the collection view is refreshed', async () => {
    const index = new AssetPreviewIndex()
    const initial = fixtureCollection('before')
    index.update(initial)
    const next = fixtureCollection('after')
    index.update(next)

    expect(await index.find('asset-before', async () => initial)).toBeUndefined()
    expect(await index.find('asset-after', async () => initial)).toEqual({
      originalPath: '/private/library/after.webp',
      mimeType: 'image/webp',
    })
  })
})

function fixtureCollection(id: string) {
  return createDefaultCollection(
    {
      id: 'default',
      title: '我的表情',
      publisher: '图渡',
      packSize: 30,
      selectedAssetIds: [],
      assets: [
        {
          id: `asset-${id}`,
          displayName: id,
          originalPath: `/private/library/${id}.webp`,
          sha256: id.padEnd(64, '0'),
          mimeType: 'image/webp',
          animated: false,
          width: 128,
          height: 128,
          importedAt: '2026-08-13T00:00:00.000Z',
          sourceOrder: 0,
          userOrder: 0,
          sources: [
            {
              id: `source-${id}`,
              kind: 'local',
              label: '本机文件',
              importedAt: '2026-08-13T00:00:00.000Z',
            },
          ],
        },
      ],
    },
    new Date('2026-08-13T00:00:00.000Z'),
  )
}
