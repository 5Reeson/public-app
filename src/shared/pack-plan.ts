import type { StickerAsset } from './domain.js'

export const MIN_STICKERS_PER_PACK = 3
export const MAX_STICKERS_PER_PACK = 30

export type PackMediaKind = 'static' | 'animated'

export interface PlannedStickerPack {
  id: string
  mediaKind: PackMediaKind
  index: number
  assetIds: string[]
}

export interface PackPlanWarning {
  code: 'not-enough-stickers' | 'cannot-split'
  mediaKind: PackMediaKind
  count: number
  message: string
}

export interface StickerPackPlan {
  packs: PlannedStickerPack[]
  warnings: PackPlanWarning[]
}

export interface PackPlanningCollection {
  id: string
  packSize: number
  selectedAssetIds: string[]
  assets: Array<Pick<StickerAsset, 'id' | 'sha256' | 'animated' | 'userOrder'>>
}

export function parsePackSizeInput(value: string): number | null {
  if (!/^\d{1,2}$/.test(value)) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= MIN_STICKERS_PER_PACK && parsed <= 30 ? parsed : null
}

export function validatePackSize(packSize: number): void {
  if (!Number.isInteger(packSize) || packSize < MIN_STICKERS_PER_PACK || packSize > 30) {
    throw new RangeError('每包数量必须是 3–30 之间的整数')
  }
}

export function splitPackSizes(total: number, packSize: number): number[] {
  validatePackSize(packSize)
  if (!Number.isInteger(total) || total < 0) throw new RangeError('贴纸数量必须是非负整数')
  if (total < MIN_STICKERS_PER_PACK) return []

  const fullPackCount = Math.floor(total / packSize)
  const remainder = total % packSize
  const sizes = Array.from({ length: fullPackCount }, () => packSize)

  if (remainder === 0) return sizes
  if (remainder >= MIN_STICKERS_PER_PACK) return [...sizes, remainder]

  const missing = MIN_STICKERS_PER_PACK - remainder
  const donorIndex = sizes.length - 1
  if (donorIndex < 0 || sizes[donorIndex]! - missing < MIN_STICKERS_PER_PACK) return []
  sizes[donorIndex] = sizes[donorIndex]! - missing
  sizes.push(MIN_STICKERS_PER_PACK)
  return sizes
}

function stablePackDigest(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function planMediaPacks(
  collectionId: string,
  assets: Array<Pick<StickerAsset, 'id' | 'sha256'>>,
  mediaKind: PackMediaKind,
  packSize: number,
): { packs: PlannedStickerPack[]; warning?: PackPlanWarning } {
  if (assets.length > 0 && assets.length < MIN_STICKERS_PER_PACK) {
    return {
      packs: [],
      warning: {
        code: 'not-enough-stickers',
        mediaKind,
        count: assets.length,
        message: `${mediaKind === 'animated' ? '动态' : '静态'}贴纸只有 ${assets.length} 张，至少需要 3 张才能生成一个包。`,
      },
    }
  }

  const sizes = splitPackSizes(assets.length, packSize)
  if (assets.length >= MIN_STICKERS_PER_PACK && sizes.length === 0) {
    return {
      packs: [],
      warning: {
        code: 'cannot-split',
        mediaKind,
        count: assets.length,
        message: `${assets.length} 张${mediaKind === 'animated' ? '动态' : '静态'}贴纸无法按每包最多 ${packSize} 张且至少 3 张分包，请调大每包数量或调整选择。`,
      },
    }
  }
  let offset = 0
  return {
    packs: sizes.map((size, index) => {
      const members = assets.slice(offset, offset + size)
      offset += size
      const digestInput = members.map((asset) => `${asset.id}:${asset.sha256}`).join('|')
      return {
        id: `pack-${stablePackDigest(`${collectionId}|${mediaKind}|${digestInput}`)}`,
        mediaKind,
        index,
        assetIds: members.map((asset) => asset.id),
      }
    }),
  }
}

export function planStickerPacks(collection: PackPlanningCollection): StickerPackPlan {
  validatePackSize(collection.packSize)
  const selectedIds = new Set(collection.selectedAssetIds)
  const selected = collection.assets.filter((asset) => selectedIds.has(asset.id))
  selected.sort((left, right) => left.userOrder - right.userOrder)
  const staticPlan = planMediaPacks(
    collection.id,
    selected.filter((asset) => !asset.animated),
    'static',
    collection.packSize,
  )
  const animatedPlan = planMediaPacks(
    collection.id,
    selected.filter((asset) => asset.animated),
    'animated',
    collection.packSize,
  )

  return {
    packs: [...staticPlan.packs, ...animatedPlan.packs],
    warnings: [staticPlan.warning, animatedPlan.warning].filter(
      (warning): warning is PackPlanWarning => warning !== undefined,
    ),
  }
}
