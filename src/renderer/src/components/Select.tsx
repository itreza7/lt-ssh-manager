import { useEffect, useRef, useState, type CSSProperties } from 'react'

export interface SelectOption {
  value: string
  label: string
  /** optional per-option style (e.g. font-family preview) */
  style?: CSSProperties
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  width?: number
}

// Themed dropdown — replaces the native <select>, whose popup is drawn by the
// OS and can't be styled (poor contrast against the dark UI).
export function Select({ value, options, onChange, width = 176 }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative" style={{ width }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-ink/60 px-2.5 py-1.5 text-left text-sm text-fg transition-colors ${
          open ? 'border-signal/60' : 'border-line hover:border-faint'
        }`}
      >
        <span className="truncate" style={current?.style}>
          {current?.label ?? value}
        </span>
        <span className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="panel absolute right-0 z-20 mt-1 max-h-64 w-full overflow-y-auto p-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]">
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                o.value === value ? 'bg-signal/15 text-signal' : 'text-fg/85 hover:bg-elevated'
              }`}
            >
              <span className="truncate" style={o.style}>
                {o.label}
              </span>
              {o.value === value && <span className="shrink-0 text-signal">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
