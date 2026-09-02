import { useState } from 'react'
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/MagnifyingGlass'
import { XIcon as X } from '@phosphor-icons/react/X'

import { Dialog } from './Dialog.js'

export function WhatsAppQrPreview({ src }: { src: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        className="login-qr-trigger"
        type="button"
        aria-label="放大查看 WhatsApp 登录二维码"
        onClick={() => setOpen(true)}
      >
        <img src={src} alt="WhatsApp 登录二维码" />
        <span className="login-qr-hover" aria-hidden="true">
          <MagnifyingGlass size={26} weight="bold" />
        </span>
      </button>

      {open && (
        <Dialog
          className="preview-dialog whatsapp-qr-preview-dialog"
          ariaLabel="放大查看 WhatsApp 登录二维码"
          onClose={() => setOpen(false)}
        >
          <button
            className="preview-close"
            type="button"
            autoFocus
            aria-label="关闭二维码预览"
            onClick={() => setOpen(false)}
          >
            <X size={18} />
          </button>
          <img src={src} alt="WhatsApp 登录二维码大图" />
        </Dialog>
      )}
    </>
  )
}
