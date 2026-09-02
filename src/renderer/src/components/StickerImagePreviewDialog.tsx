import { useState } from 'react'
import { CheckIcon as Check } from '@phosphor-icons/react/Check'
import { CopySimpleIcon as CopySimple } from '@phosphor-icons/react/CopySimple'
import { TrashIcon as Trash } from '@phosphor-icons/react/Trash'
import { XIcon as X } from '@phosphor-icons/react/X'

import { Dialog } from './Dialog.js'
import { ProgressiveImage } from './ProgressiveImage.js'

export interface PreviewableSticker {
  id: string
  displayName: string
  previewUrl: string
  animated: boolean
  width: number
  height: number
}

type CopyStatus = 'idle' | 'copying' | 'copied' | 'failed'

export function StickerImagePreviewDialog({
  asset,
  onClose,
  onCopy,
  onDelete,
}: {
  asset: PreviewableSticker
  onClose: () => void
  onCopy?: () => void | Promise<void>
  onDelete?: () => void | Promise<void>
}) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')

  async function copyImage() {
    if (!onCopy || copyStatus === 'copying') return
    setCopyStatus('copying')
    try {
      await onCopy()
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
  }

  return (
    <Dialog className="preview-dialog" ariaLabel={`预览 ${asset.displayName}`} onClose={onClose}>
      <button className="preview-close" type="button" onClick={onClose} aria-label="关闭预览">
        <X size={18} />
      </button>
      <ProgressiveImage src={asset.previewUrl} alt={asset.displayName} eager />
      <strong>{asset.displayName}</strong>
      <div className="preview-footer">
        <div className="preview-meta">
          <span>
            {asset.animated ? '动图' : '静态'} · {asset.width} × {asset.height}
          </span>
          {onCopy && (
            <button
              type="button"
              disabled={copyStatus === 'copying'}
              aria-live="polite"
              title={asset.animated ? '复制动图首帧' : '复制图片'}
              onClick={() => void copyImage()}
            >
              {copyStatus === 'copied' ? <Check size={13} /> : <CopySimple size={13} />}
              {copyStatus === 'copying'
                ? '复制中'
                : copyStatus === 'copied'
                  ? '已复制'
                  : copyStatus === 'failed'
                    ? '重试复制'
                    : '复制'}
            </button>
          )}
        </div>
        {onDelete && (
          <button
            className="preview-delete"
            type="button"
            aria-label={`删除 ${asset.displayName}`}
            onClick={() => void onDelete()}
          >
            <Trash size={14} />
            删除
          </button>
        )}
      </div>
    </Dialog>
  )
}
