import type { ReactNode } from 'react'
import { ImagesIcon as Images } from '@phosphor-icons/react/Images'
import { UploadSimpleIcon as UploadSimple } from '@phosphor-icons/react/UploadSimple'
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/WechatLogo'

import type { CollectionView, ImportMode } from '../../../shared/domain.js'
import { StickerPicker } from './StickerPicker.js'
import { WorkspaceHeading } from './WorkspaceHeading.js'

export function LibraryPage({
  collection,
  onSelection,
  onOrder,
  onDelete,
  onLocalImport,
  onWechat,
  wechatPanel,
}: {
  collection: CollectionView
  onSelection(ids: string[]): void
  onOrder(ids: string[]): void
  onDelete(ids: string[]): void
  onLocalImport(mode: ImportMode): void
  onWechat(): void
  wechatPanel: ReactNode
}) {
  return (
    <div className="page-workspace">
      <WorkspaceHeading
        title="我的表情库"
        description="浏览、管理所有已经导入本应用的表情包素材。单击可查看文件名、预览、复制、删除。支持框选及拖拽排序。"
        aside={
          <div className="heading-actions">
            <button className="secondary-button" type="button" onClick={onWechat}>
              <WechatLogo size={16} />
              微信导入
            </button>
            <button className="primary-button" type="button" onClick={() => onLocalImport('files')}>
              <UploadSimple size={16} />
              本机导入
            </button>
          </div>
        }
      />
      {wechatPanel && <div className="page-inline-panel">{wechatPanel}</div>}
      {collection.assets.length ? (
        <StickerPicker
          assets={collection.assets}
          selectedIds={collection.selectedAssetIds}
          orderedIds={[...collection.assets]
            .sort((a, b) => a.userOrder - b.userOrder)
            .map((asset) => asset.id)}
          mode="library"
          onSelection={onSelection}
          onOrder={onOrder}
          onDelete={onDelete}
        />
      ) : (
        <div className="empty-state">
          <Images size={36} />
          <h3>表情库还是空的</h3>
          <p>从本机或微信导入后，素材会安全保存到这里。</p>
        </div>
      )}
    </div>
  )
}
