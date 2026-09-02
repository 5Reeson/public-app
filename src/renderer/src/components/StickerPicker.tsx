import { useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { DotsSixIcon as Grip } from '@phosphor-icons/react/DotsSix'
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react/MagnifyingGlass'
import { SquareIcon as Square } from '@phosphor-icons/react/Square'

import type { CollectionView, StickerSourceKind } from '../../../shared/domain.js'
import { MenuSelect } from './MenuSelect.js'
import { ProgressiveImage } from './ProgressiveImage.js'
import { StickerImagePreviewDialog } from './StickerImagePreviewDialog.js'
import { useBoxSelection } from './useBoxSelection.js'
import { useProgressiveCount } from './useProgressiveCount.js'

type Asset = CollectionView['assets'][number]

const INITIAL_TILE_COUNT = 72
const TILE_BATCH_SIZE = 48

export interface StickerPickerProps {
  assets: Asset[]
  selectedIds: string[]
  orderedIds: string[]
  mode: 'library' | 'export'
  onSelection(ids: string[]): void
  onOrder(ids: string[]): void
  onDelete?(ids: string[]): void | Promise<void>
  toolbar?: 'full' | 'wechat-import'
  allowCopy?: boolean
}

function sourceKey(asset: Asset): string[] {
  return asset.sources.flatMap((source) => [
    `kind:${source.kind}`,
    ...(source.accountId ? [`account:${source.accountId}`] : []),
    ...(source.importBatchId ? [`batch:${source.importBatchId}`] : []),
  ])
}

function albumRefs(
  asset: Asset,
): Array<{ id: string; name: string; kind: 'personal' | 'official' }> {
  return asset.sources.flatMap((source) => {
    if (source.album) return [source.album]
    return source.kind === 'wechat4' || source.kind === 'wechat-legacy'
      ? [{ id: 'wechat-personal', name: '个人收藏', kind: 'personal' as const }]
      : []
  })
}

export function StickerPicker({
  assets,
  selectedIds,
  orderedIds,
  mode,
  onSelection,
  onOrder,
  onDelete,
  toolbar = 'full',
  allowCopy = true,
}: StickerPickerProps) {
  const [query, setQuery] = useState('')
  const [media, setMedia] = useState<'all' | 'static' | 'animated'>('all')
  const [source, setSource] = useState('all')
  const [album, setAlbum] = useState('all')
  const [sort, setSort] = useState<'user-order' | 'reverse-order'>('user-order')
  const [preview, setPreview] = useState<Asset | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const sourceOptions = useMemo(() => {
    const options = new Map<string, { label: string; rank: number }>()
    for (const asset of assets) {
      for (const item of asset.sources) {
        const rank = sourceKindRank(item.kind)
        options.set(`kind:${item.kind}`, { label: sourceKindLabel(item.kind), rank })
        if (item.accountId) {
          options.set(`account:${item.accountId}`, { label: item.label, rank: rank + 1 })
        }
      }
    }
    return [...options]
      .sort(
        (left, right) =>
          left[1].rank - right[1].rank || left[1].label.localeCompare(right[1].label, 'zh-Hans-CN'),
      )
      .map(([value, option]) => [value, option.label] as [string, string])
  }, [assets])
  const albumOptions = useMemo(() => {
    const options = new Map<string, { label: string; personal: boolean }>()
    for (const asset of assets) {
      for (const item of albumRefs(asset)) {
        options.set(item.id, { label: item.name, personal: item.kind === 'personal' })
      }
    }
    return [...options]
      .sort((left, right) => {
        if (left[1].personal !== right[1].personal) return left[1].personal ? -1 : 1
        return left[1].label.localeCompare(right[1].label, 'zh-Hans-CN')
      })
      .map(([value, item]) => [value, item.label] as [string, string])
  }, [assets])
  const mediaCounts = useMemo(
    () => ({
      static: assets.filter((asset) => !asset.animated).length,
      animated: assets.filter((asset) => asset.animated).length,
    }),
    [assets],
  )
  const baseOrder = useMemo(
    () =>
      assets
        .slice()
        .sort((a, b) => a.userOrder - b.userOrder)
        .map((asset) => asset.id),
    [assets],
  )
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-Hans-CN')
    const orderIndex = new Map(baseOrder.map((id, index) => [id, index]))
    const filtered = assets
      .filter(
        (asset) =>
          !normalizedQuery ||
          [asset.displayName, ...albumRefs(asset).map((item) => item.name)].some((value) =>
            value.toLocaleLowerCase('zh-Hans-CN').includes(normalizedQuery),
          ),
      )
      .filter((asset) => media === 'all' || asset.animated === (media === 'animated'))
      .filter((asset) => source === 'all' || sourceKey(asset).includes(source))
      .filter((asset) => album === 'all' || albumRefs(asset).some((item) => item.id === album))
    return filtered.sort((left, right) => {
      const difference =
        (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      return sort === 'reverse-order' ? -difference : difference
    })
  }, [album, assets, baseOrder, media, query, sort, source])
  const filterKey = `${query}\u0000${media}\u0000${source}\u0000${album}\u0000${sort}\u0000${assets.length}`
  const progressive = useProgressiveCount({
    total: visible.length,
    initialCount: INITIAL_TILE_COUNT,
    batchSize: TILE_BATCH_SIZE,
    resetKey: filterKey,
  })
  const renderedAssets = visible.slice(0, progressive.visibleCount)
  const selectedOrder = useMemo(
    () => new Map(selectedIds.map((id, index) => [id, index])),
    [selectedIds],
  )

  useEffect(() => {
    if (preview && !assets.some((asset) => asset.id === preview.id)) setPreview(null)
  }, [assets, preview])

  function toggle(id: string) {
    if (selected.has(id)) {
      onSelection(selectedIds.filter((candidate) => candidate !== id))
      if (mode === 'export') onOrder(orderedIds.filter((candidate) => candidate !== id))
    } else {
      onSelection([...selectedIds, id])
      if (mode === 'export') onOrder([...orderedIds, id])
    }
  }

  function selectMany(ids: string[]) {
    const additions = ids.filter((id) => !selected.has(id))
    if (!additions.length) return
    onSelection([...selectedIds, ...additions])
    if (mode === 'export') {
      const ordered = new Set(orderedIds)
      const orderAdditions = additions.filter((id) => !ordered.has(id))
      if (orderAdditions.length) onOrder([...orderedIds, ...orderAdditions])
    }
  }

  const boxSelection = useBoxSelection({
    excludeSelector: '.picker-select, .picker-drag',
    onSelectIds: selectMany,
  })

  async function copyPreviewImage() {
    if (!preview) return
    const api = window.stickerApp
    if (!api) throw new Error('桌面桥接不可用')
    await api.copyAssetImage(preview.id)
  }

  function dragEnd(event: DragEndEvent) {
    const active = String(event.active.id)
    const over = event.over ? String(event.over.id) : undefined
    if (!over || active === over) return
    if (mode === 'export' && (!selected.has(active) || !selected.has(over))) return
    const order = mode === 'export' ? [...orderedIds] : [...baseOrder]
    const from = order.indexOf(active)
    const to = order.indexOf(over)
    if (from < 0 || to < 0) return
    order.splice(to, 0, ...order.splice(from, 1))
    onOrder(order)
  }

  const animatedSelected = assets.filter((asset) => selected.has(asset.id) && asset.animated).length
  return (
    <section
      className={`sticker-picker ${mode}${toolbar === 'wechat-import' ? ' wechat-import' : ''}`}
    >
      <div className="picker-toolbar">
        <div className="picker-media-tabs" aria-label="按类型筛选">
          {(['all', 'static', 'animated'] as const).map((value) => (
            <button
              className={media === value ? 'is-active' : ''}
              type="button"
              key={value}
              onClick={() => setMedia(value)}
            >
              {value === 'all'
                ? `全部 ${assets.length}`
                : value === 'static'
                  ? `静态 ${mediaCounts.static}`
                  : `动图 ${mediaCounts.animated}`}
            </button>
          ))}
        </div>
        {toolbar === 'full' && (
          <>
            <label className="picker-search">
              <Search size={16} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索表情名称"
              />
            </label>
            <SourceFilter value={source} options={sourceOptions} onChange={setSource} />
            {albumOptions.length > 0 && (
              <AlbumFilter value={album} options={albumOptions} onChange={setAlbum} />
            )}
          </>
        )}
        <SortFilter value={sort} onChange={setSort} />
      </div>
      <div className="picker-selection-bar">
        <span>
          <strong>{selectedIds.length}</strong> 张已选择 · 包含 {animatedSelected} 张动图
          <small>拖过缩略图可框选多张</small>
        </span>
        <div>
          <button
            type="button"
            onClick={() => {
              selectMany(visible.map((asset) => asset.id))
            }}
          >
            全选当前结果
          </button>
          <button
            type="button"
            onClick={() => {
              onSelection([])
              if (mode === 'export') onOrder([])
            }}
          >
            取消选择
          </button>
          {mode === 'library' && onDelete && (
            <button
              className="danger-text"
              type="button"
              disabled={!selectedIds.length}
              onClick={() => onDelete(selectedIds)}
            >
              删除所选
            </button>
          )}
        </div>
      </div>
      {visible.length ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
          <SortableContext
            items={renderedAssets.map((asset) => asset.id)}
            strategy={rectSortingStrategy}
          >
            <div
              className="picker-grid"
              ref={boxSelection.gridRef}
              onPointerDown={boxSelection.onPointerDown}
              onDragStart={(event) => {
                if (!(event.target as HTMLElement).closest('.picker-drag')) {
                  event.preventDefault()
                }
              }}
              onClickCapture={boxSelection.onClickCapture}
            >
              <div
                className="box-selection-marquee"
                ref={boxSelection.marqueeRef}
                hidden
                aria-hidden="true"
              />
              {renderedAssets.map((asset) => (
                <PickerTile
                  key={asset.id}
                  asset={asset}
                  selected={selected.has(asset.id)}
                  index={selectedOrder.get(asset.id) ?? -1}
                  onToggle={() => toggle(asset.id)}
                  onPreview={() => setPreview(asset)}
                  dragEnabled={
                    sort === 'user-order' && (mode === 'library' || selected.has(asset.id))
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="picker-empty">没有符合当前筛选条件的表情。</div>
      )}
      {progressive.hasMore && (
        <button
          className="progressive-load-more"
          type="button"
          ref={progressive.sentinelRef}
          onClick={progressive.showMore}
        >
          已显示 {progressive.visibleCount} / {visible.length} 张，继续加载
        </button>
      )}
      {preview && (
        <StickerImagePreviewDialog
          asset={preview}
          onClose={() => setPreview(null)}
          {...(allowCopy ? { onCopy: copyPreviewImage } : {})}
          {...(onDelete ? { onDelete: () => onDelete([preview.id]) } : {})}
        />
      )}
    </section>
  )
}

function SortFilter({
  value,
  onChange,
}: {
  value: 'user-order' | 'reverse-order'
  onChange(value: 'user-order' | 'reverse-order'): void
}) {
  return (
    <MenuSelect
      value={value}
      options={[
        { value: 'user-order', label: '当前排序' },
        { value: 'reverse-order', label: '倒序排序' },
      ]}
      ariaLabel="排序表情"
      onChange={onChange}
    />
  )
}

function SourceFilter({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<[string, string]>
  onChange(value: string): void
}) {
  const allOptions: Array<[string, string]> = [['all', '全部来源'], ...options]
  return (
    <MenuSelect
      value={value}
      options={allOptions.map(([option, label]) => ({ value: option, label }))}
      ariaLabel="按来源筛选"
      onChange={onChange}
    />
  )
}

function AlbumFilter({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<[string, string]>
  onChange(value: string): void
}) {
  return (
    <MenuSelect
      value={value}
      options={[
        { value: 'all', label: '全部专辑' },
        ...options.map(([option, label]) => ({ value: option, label })),
      ]}
      ariaLabel="按所属专辑筛选"
      onChange={onChange}
    />
  )
}

function PickerTile({
  asset,
  selected,
  index,
  onToggle,
  onPreview,
  dragEnabled,
}: {
  asset: Asset
  selected: boolean
  index: number
  onToggle(): void
  onPreview(): void
  dragEnabled: boolean
}) {
  const sortable = useSortable({ id: asset.id, disabled: !dragEnabled })
  return (
    <article
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`picker-tile${selected ? ' is-selected' : ''}${sortable.isDragging ? ' is-dragging' : ''}`}
      data-box-selection-id={asset.id}
    >
      <button className="picker-preview" type="button" onClick={onPreview}>
        <ProgressiveImage src={asset.previewUrl} alt={asset.displayName} />
      </button>
      <button className="picker-select" type="button" aria-pressed={selected} onClick={onToggle}>
        {selected ? <span>{index + 1}</span> : <Square size={15} />}
      </button>
      <button
        className="picker-drag"
        type="button"
        disabled={!dragEnabled}
        aria-label={`拖动排序 ${asset.displayName}`}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <Grip size={17} />
      </button>
      {asset.animated && <span className="picker-media-badge">动图</span>}
    </article>
  )
}

function sourceKindLabel(kind: StickerSourceKind): string {
  return kind === 'local'
    ? '本机导入'
    : kind === 'wechat4'
      ? '所有新版微信账号'
      : '所有旧版微信账号'
}

function sourceKindRank(kind: StickerSourceKind): number {
  return kind === 'local' ? 0 : kind === 'wechat4' ? 10 : 20
}
