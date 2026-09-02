import { TrashIcon as Trash } from '@phosphor-icons/react/Trash'
import { XIcon as X } from '@phosphor-icons/react/X'

import type { PreparedSnapshotSummary, PreparedSnapshotView } from '../../../shared/domain.js'
import { Dialog } from './Dialog.js'
import { ProgressiveImage } from './ProgressiveImage.js'

interface ArchivesPageProps {
  snapshots: PreparedSnapshotSummary[]
  onOpen(id: string): void
  onUse(id: string): void
  onDelete(id: string): void
}

export function ArchivesPage({ snapshots, onOpen, onUse, onDelete }: ArchivesPageProps) {
  return (
    <div className="page-workspace">
      <header className="workspace-heading">
        <div>
          <h2>表情分组存档</h2>
          <p>已保存的准备结果。点击「使用」即可载入原分组与配置，直接进入传输确认。</p>
        </div>
      </header>
      {snapshots.length === 0 ? (
        <p className="inline-note">
          还没有存档。在导出流程第 4 步勾选「保留本次准备结果」即可保存。
        </p>
      ) : (
        <SavedResults snapshots={snapshots} onOpen={onOpen} onUse={onUse} onDelete={onDelete} />
      )}
    </div>
  )
}

function SavedResults({ snapshots, onOpen, onUse, onDelete }: ArchivesPageProps) {
  return (
    <section className="saved-results">
      <h3>表情分组存档</h3>
      <div>
        {snapshots.map((snapshot) => (
          <article key={snapshot.id}>
            <button className="saved-result-main" type="button" onClick={() => onOpen(snapshot.id)}>
              <strong>{snapshot.name}</strong>
              <small>
                {new Date(snapshot.createdAt).toLocaleString('zh-CN')} · {snapshot.assetCount} 张 ·{' '}
                {snapshot.groupCount} 组 ·{' '}
                {snapshot.destination === 'whatsapp' ? 'WhatsApp' : '本地文件夹'}
              </small>
            </button>
            <button className="saved-result-use" type="button" onClick={() => onUse(snapshot.id)}>
              使用
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={`删除 ${snapshot.name}`}
              onClick={() => onDelete(snapshot.id)}
            >
              <Trash size={16} />
            </button>
          </article>
        ))}
      </div>
    </section>
  )
}

export function SnapshotPreviewDialog({
  snapshot,
  onClose,
}: {
  snapshot: PreparedSnapshotView
  onClose(): void
}) {
  return (
    <Dialog
      className="snapshot-preview-dialog"
      surfaceAs="section"
      ariaLabelledBy="snapshot-preview-title"
      onClose={onClose}
    >
      <header>
        <div>
          <h2 id="snapshot-preview-title">{snapshot.name}</h2>
          <p>
            {snapshot.destination === 'whatsapp' ? 'WhatsApp' : '本地文件夹'}，{snapshot.assetCount}{' '}
            张素材，{snapshot.groupCount} 组
          </p>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭预览">
          <X size={18} />
        </button>
      </header>
      <div className="snapshot-preview-groups">
        {snapshot.groups.map((group) => (
          <article key={group.id}>
            <div>
              <strong>{group.name}</strong>
              <small>{group.items.length} 张</small>
            </div>
            <div>
              {group.items.map((item) => (
                <ProgressiveImage src={item.previewUrl} alt="" key={item.id} />
              ))}
            </div>
          </article>
        ))}
      </div>
      <footer>
        <span>这是独立保存的不可变副本，删除源素材后仍可安全预览。</span>
        <button className="primary-button" type="button" onClick={onClose}>
          完成
        </button>
      </footer>
    </Dialog>
  )
}
