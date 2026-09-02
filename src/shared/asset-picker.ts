import type { StickerAsset, StickerSourceKind } from './domain.js'

export type AssetPickerMediaFilter = 'all' | 'static' | 'animated'
export type AssetPickerSort = 'user-order' | 'source-order' | 'imported-newest' | 'imported-oldest'

export interface AssetPickerFilter {
  query?: string
  sourceKinds?: StickerSourceKind[]
  albumIds?: string[]
  sourceIds?: string[]
  sourceAccountIds?: string[]
  manualImportIds?: string[]
  media?: AssetPickerMediaFilter
  sort?: AssetPickerSort
}

export interface AssetPickerSelection {
  selectedAssetIds: string[]
  orderedAssetIds: string[]
}

export function filterAndSortAssets<T extends StickerAsset>(
  assets: readonly T[],
  filter: AssetPickerFilter,
): T[] {
  const query = filter.query?.trim().toLocaleLowerCase('zh-Hans-CN') ?? ''
  const sourceKinds = new Set(filter.sourceKinds ?? [])
  const albumIds = new Set(filter.albumIds ?? [])
  const sourceIds = new Set(filter.sourceIds ?? [])
  const sourceAccountIds = new Set(filter.sourceAccountIds ?? [])
  const manualImportIds = new Set(filter.manualImportIds ?? [])
  const media = filter.media ?? 'all'

  const visible = assets.filter((asset) => {
    if (media === 'static' && asset.animated) return false
    if (media === 'animated' && !asset.animated) return false
    if (sourceKinds.size > 0 && !asset.sources.some((source) => sourceKinds.has(source.kind))) {
      return false
    }
    if (
      albumIds.size > 0 &&
      !asset.sources.some((source) => {
        const albumId =
          source.album?.id ??
          (source.kind === 'wechat4' || source.kind === 'wechat-legacy'
            ? 'wechat-personal'
            : undefined)
        return albumId !== undefined && albumIds.has(albumId)
      })
    ) {
      return false
    }
    if (sourceIds.size > 0 && !asset.sources.some((source) => sourceIds.has(source.id))) {
      return false
    }
    if (
      sourceAccountIds.size > 0 &&
      !asset.sources.some(
        (source) => source.accountId !== undefined && sourceAccountIds.has(source.accountId),
      )
    ) {
      return false
    }
    if (
      manualImportIds.size > 0 &&
      !asset.sources.some(
        (source) =>
          source.kind === 'local' &&
          source.importBatchId !== undefined &&
          manualImportIds.has(source.importBatchId),
      )
    ) {
      return false
    }
    if (!query) return true
    return [asset.displayName, ...asset.sources.map((source) => source.label)].some((value) =>
      value.toLocaleLowerCase('zh-Hans-CN').includes(query),
    )
  })

  const sort = filter.sort ?? 'user-order'
  return [...visible].sort((left, right) => {
    if (sort === 'source-order') return left.sourceOrder - right.sourceOrder
    if (sort === 'imported-newest' || sort === 'imported-oldest') {
      const difference = Date.parse(left.importedAt) - Date.parse(right.importedAt)
      return sort === 'imported-newest' ? -difference : difference
    }
    return left.userOrder - right.userOrder
  })
}

export function normalizePickerSelection(
  state: AssetPickerSelection,
  knownAssetIds: readonly string[],
): AssetPickerSelection {
  const known = new Set(knownAssetIds)
  const selectedAssetIds = unique(state.selectedAssetIds).filter((id) => known.has(id))
  const selected = new Set(selectedAssetIds)
  const orderedAssetIds = unique(state.orderedAssetIds).filter((id) => selected.has(id))
  const ordered = new Set(orderedAssetIds)
  for (const id of selectedAssetIds) {
    if (!ordered.has(id)) orderedAssetIds.push(id)
  }
  return { selectedAssetIds, orderedAssetIds }
}

export function togglePickerAsset(
  state: AssetPickerSelection,
  assetId: string,
): AssetPickerSelection {
  const selected = new Set(state.selectedAssetIds)
  if (selected.has(assetId)) {
    return {
      selectedAssetIds: state.selectedAssetIds.filter((id) => id !== assetId),
      orderedAssetIds: state.orderedAssetIds.filter((id) => id !== assetId),
    }
  }
  return {
    selectedAssetIds: [...state.selectedAssetIds, assetId],
    orderedAssetIds: [...state.orderedAssetIds, assetId],
  }
}

export function setVisiblePickerSelection(
  state: AssetPickerSelection,
  visibleAssetIds: readonly string[],
  selected: boolean,
): AssetPickerSelection {
  const visible = new Set(visibleAssetIds)
  if (!selected) {
    return {
      selectedAssetIds: state.selectedAssetIds.filter((id) => !visible.has(id)),
      orderedAssetIds: state.orderedAssetIds.filter((id) => !visible.has(id)),
    }
  }

  const selectedSet = new Set(state.selectedAssetIds)
  const orderedSet = new Set(state.orderedAssetIds)
  const selectedAssetIds = [...state.selectedAssetIds]
  const orderedAssetIds = [...state.orderedAssetIds]
  for (const id of visibleAssetIds) {
    if (!selectedSet.has(id)) {
      selectedSet.add(id)
      selectedAssetIds.push(id)
    }
    if (!orderedSet.has(id)) {
      orderedSet.add(id)
      orderedAssetIds.push(id)
    }
  }
  return { selectedAssetIds, orderedAssetIds }
}

export function reorderPickerSelection(
  state: AssetPickerSelection,
  activeId: string,
  overId: string,
): AssetPickerSelection {
  const from = state.orderedAssetIds.indexOf(activeId)
  const to = state.orderedAssetIds.indexOf(overId)
  if (from < 0 || to < 0 || from === to) return state
  const orderedAssetIds = [...state.orderedAssetIds]
  const [active] = orderedAssetIds.splice(from, 1)
  orderedAssetIds.splice(to, 0, active!)
  return { ...state, orderedAssetIds }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
