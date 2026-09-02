import { describe, expect, it } from 'vitest'

import {
  CURRENT_SCHEMA_VERSION,
  type StickerAsset,
  type StickerCollection,
} from '../../src/shared/domain.js'
import { parsePackSizeInput, planStickerPacks, splitPackSizes } from '../../src/shared/pack-plan.js'

const expectedCases: Array<[number, number[]]> = [
  [0, []],
  [1, []],
  [2, []],
  [3, [3]],
  [29, [29]],
  [30, [30]],
  [31, [28, 3]],
  [32, [29, 3]],
  [33, [30, 3]],
  [59, [30, 29]],
  [60, [30, 30]],
  [61, [30, 28, 3]],
  [92, [30, 30, 29, 3]],
]

function asset(index: number, animated = false): StickerAsset {
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
    originalPath: `/tmp/sticker-${index}.png`,
    sha256: index.toString(16).padStart(64, '0'),
    mimeType: animated ? 'image/gif' : 'image/png',
    animated,
    width: 100,
    height: 100,
    importedAt: '2026-08-08T00:00:00.000Z',
    sourceOrder: index,
    userOrder: index,
  }
}

function collection(
  assets: StickerAsset[],
  selectedAssetIds = assets.map((item) => item.id),
): StickerCollection {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'test-collection',
    title: 'Test pack',
    publisher: 'Tests',
    packSize: 30,
    assets,
    selectedAssetIds,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  }
}

describe('splitPackSizes', () => {
  it.each(expectedCases)('splits %i stickers without an illegal tail', (total, expected) => {
    expect(splitPackSizes(total, 30)).toEqual(expected)
  })

  it('uses the configured pack size and only borrows from the penultimate pack', () => {
    expect(splitPackSizes(22, 10)).toEqual([10, 9, 3])
    expect(splitPackSizes(21, 10)).toEqual([10, 8, 3])
  })

  it('rejects pack sizes outside 3–30', () => {
    expect(() => splitPackSizes(10, 2)).toThrow(/3–30/)
    expect(() => splitPackSizes(10, 31)).toThrow(/3–30/)
  })

  it('returns no sizes when a very small configured maximum makes a legal split impossible', () => {
    expect(splitPackSizes(4, 3)).toEqual([])
    expect(splitPackSizes(5, 4)).toEqual([])
  })
})

describe('parsePackSizeInput', () => {
  it('allows an empty editing state without converting it to zero', () => {
    expect(parsePackSizeInput('')).toBeNull()
    expect(parsePackSizeInput('0')).toBeNull()
  })

  it('accepts valid display values and rejects leading-zero or out-of-range values', () => {
    expect(parsePackSizeInput('3')).toBe(3)
    expect(parsePackSizeInput('10')).toBe(10)
    expect(parsePackSizeInput('30')).toBe(30)
    expect(parsePackSizeInput('010')).toBeNull()
    expect(parsePackSizeInput('31')).toBeNull()
  })
})

describe('planStickerPacks', () => {
  it('separates static and animated assets while preserving relative user order', () => {
    const assets = [asset(0), asset(1, true), asset(2), asset(3, true), asset(4), asset(5, true)]
    const plan = planStickerPacks(collection(assets))

    expect(plan.warnings).toEqual([])
    expect(plan.packs.map((pack) => [pack.mediaKind, pack.assetIds])).toEqual([
      ['static', ['asset-0', 'asset-2', 'asset-4']],
      ['animated', ['asset-1', 'asset-3', 'asset-5']],
    ])
  })

  it('warns instead of creating illegal packs for media groups with only 1–2 assets', () => {
    const plan = planStickerPacks(collection([asset(0), asset(1), asset(2, true)]))

    expect(plan.packs).toEqual([])
    expect(plan.warnings.map((warning) => [warning.mediaKind, warning.count])).toEqual([
      ['static', 2],
      ['animated', 1],
    ])
  })

  it('creates stable identifiers for an unchanged plan', () => {
    const value = collection([asset(0), asset(1), asset(2)])
    expect(planStickerPacks(value)).toEqual(planStickerPacks(value))
  })

  it('warns when the configured maximum cannot produce legal packs', () => {
    const value = collection([asset(0), asset(1), asset(2), asset(3)])
    value.packSize = 3
    expect(planStickerPacks(value).warnings[0]).toMatchObject({ code: 'cannot-split', count: 4 })
  })
})
