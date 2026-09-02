import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/WarningCircle'
import { XIcon as X } from '@phosphor-icons/react/X'

export function ProductBanner({
  tone,
  message,
  actionLabel,
  onAction,
  onDismiss,
}: {
  tone: 'error' | 'notice'
  message: string
  actionLabel?: string
  onAction?(): void
  onDismiss(): void
}) {
  const isError = tone === 'error'
  const Icon = isError ? WarningCircle : CheckCircle
  const hasAction = Boolean(actionLabel && onAction)

  return (
    <div
      className={`product-banner ${tone}${hasAction ? ' has-action' : ''}`}
      role={isError ? 'alert' : 'status'}
    >
      <Icon size={18} />
      <span>{message}</span>
      {hasAction && (
        <button className="product-banner-action" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      <button
        className="product-banner-dismiss"
        type="button"
        onClick={onDismiss}
        aria-label={isError ? '关闭错误' : '关闭提示'}
      >
        <X size={16} />
      </button>
    </div>
  )
}
