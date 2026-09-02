import { useState, type ReactNode } from 'react'
import { InfoIcon as Info } from '@phosphor-icons/react/Info'
import { XIcon as X } from '@phosphor-icons/react/X'

export function DismissibleInfoNotice({
  title,
  ariaLabel,
  closeLabel,
  className,
  children,
}: {
  title: string
  ariaLabel: string
  closeLabel: string
  className?: string
  children: ReactNode
}) {
  const [visible, setVisible] = useState(true)
  if (!visible) return null

  return (
    <aside
      className={`dismissible-info-notice${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel}
    >
      <Info size={18} />
      <div>
        <strong>{title}</strong>
        {children}
      </div>
      <button type="button" aria-label={closeLabel} onClick={() => setVisible(false)}>
        <X size={16} />
      </button>
    </aside>
  )
}
