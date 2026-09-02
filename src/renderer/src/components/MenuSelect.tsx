import { useEffect, useRef, useState } from 'react'
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown'
import { CheckIcon as Check } from '@phosphor-icons/react/Check'

export interface MenuSelectOption<Value extends string> {
  value: Value
  label: string
}

export function MenuSelect<Value extends string>({
  value,
  options,
  ariaLabel,
  disabled = false,
  onChange,
}: {
  value: Value
  options: MenuSelectOption<Value>[]
  ariaLabel: string
  disabled?: boolean
  onChange(value: Value): void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const label = options.find((option) => option.value === value)?.label ?? options[0]?.label ?? ''

  useEffect(() => {
    if (!open) return
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div className="source-filter" ref={root}>
      <button
        className="source-filter-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <CaretDown size={15} weight="bold" />
      </button>
      {open && (
        <div className="source-filter-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              className={option.value === value ? 'is-selected' : ''}
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} weight="bold" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
