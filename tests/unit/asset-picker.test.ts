import { describe, expect, it } from 'vitest'

import {
  filterAndSortAssets,
  normalizePickerSelection,
  reorderPickerSelection,
  setVisiblePickerSelection,
  togglePickerAsset,
} from '../../src/shared/asset-picker.js'
import type { StickerAsset } from '../../src/shared/domain.js'

function asset(
  id: string,
  options: {
    animated?: boolean
    userOrder: number
    sources: StickerAsset['sources']
    importedAt?: string
  },
): StickerAsset {
  return {
    id,
    sources: options.sources,
    displayName: `表情 ${id}`,
    originalPath: `/synthetic/${id}.webp`,
    sha256: id.padEnd(64, '0'),
    mimeType: 'image/webp',
    animated: options.animated ?? false,
    width: 128,
    height: 128,
    importedAt: options.importedAt ?? '2026-08-11T01:00:00.000Z',
    sourceOrder: options.userOrder,
    userOrder: options.userOrder,
  }
}

const importedAt = '2026-08-11T01:00:00.000Z'
const assets = [
  asset('a', {
    userOrder: 2,
    sources: [
      {
        id: 'wechat-account-a',
        kind: 'wechat4',
        label: '新版微信账号 · 0001',
        accountId: 'account-a',
        album: { kind: 'official', id: 'pink-rabbit', name: '粉红兔子2' },
        importedAt,
      },
      {
        id: 'wechat-account-b',
        kind: 'wechat4',
        label: '新版微信账号 · 0002',
        accountId: 'account-b',
        importedAt,
      },
    ],
  }),
  asset('b', {
    animated: true,
    userOrder: 0,
    sources: [
      {
        id: 'local-batch-a',
        kind: 'local',
        label: '本机文件夹',
        importBatchId: 'batch-a',
        importedAt,
      },
    ],
  }),
  asset('c', {
    userOrder: 1,
    sources: [
      {
        id: 'legacy-account',
        kind: 'wechat-legacy',
        label: '旧版微信账号 · 0003',
        accountId: 'account-c',
        importedAt,
      },
    ],
  }),
]

describe('asset picker core', () => {
  it('filters by every retained source without duplicating a multi-source asset', () => {
    expect(
      filterAndSortAssets(assets, { sourceAccountIds: ['account-b'] }).map((item) => item.id),
    ).toEqual(['a'])
    expect(
      filterAndSortAssets(assets, { sourceKinds: ['wechat4'] }).map((item) => item.id),
    ).toEqual(['a'])
    expect(
      filterAndSortAssets(assets, { manualImportIds: ['batch-a'] }).map((item) => item.id),
    ).toEqual(['b'])
    expect(filterAndSortAssets(assets, { query: '0002' }).map((item) => item.id)).toEqual(['a'])
  })

  it('combines media filters with stable global-order sorting', () => {
    expect(filterAndSortAssets(assets, { media: 'all' }).map((item) => item.id)).toEqual([
      'b',
      'c',
      'a',
    ])
    expect(filterAndSortAssets(assets, { media: 'animated' }).map((item) => item.id)).toEqual(['b'])
  })

  it('filters by official album and treats old WeChat provenance as personal favorites', () => {
    expect(
      filterAndSortAssets(assets, { albumIds: ['pink-rabbit'] }).map((item) => item.id),
    ).toEqual(['a'])
    expect(
      filterAndSortAssets(assets, { albumIds: ['wechat-personal'] }).map((item) => item.id),
    ).toEqual(['c', 'a'])
  })

  it('changes only task selection and order when a filtered view is selected or reordered', () => {
    const initial = { selectedAssetIds: ['a', 'c'], orderedAssetIds: ['c', 'a'] }
    const withVisible = setVisiblePickerSelection(initial, ['b'], true)
    expect(withVisible).toEqual({
      selectedAssetIds: ['a', 'c', 'b'],
      orderedAssetIds: ['c', 'a', 'b'],
    })
    expect(reorderPickerSelection(withVisible, 'b', 'c').orderedAssetIds).toEqual(['b', 'c', 'a'])
    expect(setVisiblePickerSelection(withVisible, ['b'], false)).toEqual(initial)
    expect(togglePickerAsset(initial, 'a')).toEqual({
      selectedAssetIds: ['c'],
      orderedAssetIds: ['c'],
    })
  })

  it('prunes deleted assets without mutating the library order', () => {
    expect(
      normalizePickerSelection(
        {
          selectedAssetIds: ['missing', 'a', 'a', 'b'],
          orderedAssetIds: ['b', 'missing'],
        },
        assets.map((item) => item.id),
      ),
    ).toEqual({ selectedAssetIds: ['a', 'b'], orderedAssetIds: ['b', 'a'] })
    expect(assets.map((item) => item.userOrder)).toEqual([2, 0, 1])
  })
})
