import { useEffect, useRef, useState } from 'react'
import { fmtAccel } from '../lib/platform'

interface Props {
  onNewConnection: () => void
}

interface Item {
  label: string
  accel?: string
  run: () => void
  separatorAfter?: boolean
}

/**
 * File/Edit/View dropdown menu — non-macOS only. macOS gets a real menu bar
 * (menu.ts) instead; rendering both would give every command two homes and no
 * reason to prefer either.
 */
export function MenuBar({ onNewConnection }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = (fn: () => void) => () => {
    setOpen(null)
    fn()
  }

  const menus: Record<string, Item[]> = {
    File: [
      { label: 'New Connection…', accel: 'Ctrl+N', run: run(onNewConnection), separatorAfter: true },
      { label: 'Quit', accel: 'Ctrl+Q', run: run(() => window.api.winClose()) }
    ],
    Edit: [
      { label: 'Cut', accel: 'Ctrl+X', run: run(() => window.api.editAction('cut')) },
      { label: 'Copy', accel: 'Ctrl+C', run: run(() => window.api.editAction('copy')) },
      { label: 'Paste', accel: 'Ctrl+V', run: run(() => window.api.editAction('paste')), separatorAfter: true },
      { label: 'Select All', accel: 'Ctrl+A', run: run(() => window.api.editAction('selectAll')) }
    ],
    View: [
      { label: 'Zoom In', accel: 'Ctrl++', run: run(() => window.api.viewAction('zoomIn')) },
      { label: 'Zoom Out', accel: 'Ctrl+-', run: run(() => window.api.viewAction('zoomOut')) },
      { label: 'Reset Zoom', accel: 'Ctrl+0', run: run(() => window.api.viewAction('zoomReset')), separatorAfter: true },
      { label: 'Toggle Full Screen', accel: 'F11', run: run(() => window.api.viewAction('fullscreen')) },
      { label: 'Toggle Dev Tools', accel: 'Ctrl+Shift+I', run: run(() => window.api.viewAction('devtools')) }
    ]
  }

  return (
    <div ref={barRef} className="flex items-center">
      {Object.keys(menus).map((name) => (
        <div key={name} className="relative">
          <button
            onClick={() => setOpen((o) => (o === name ? null : name))}
            onMouseEnter={() => open && setOpen(name)}
            className={`rounded-md px-2.5 py-1 text-[13px] transition-colors ${
              open === name ? 'bg-elevated text-fg' : 'text-muted hover:text-fg'
            }`}
          >
            {name}
          </button>
          {open === name && (
            <div className="panel animate-rise absolute left-0 top-[calc(100%+4px)] min-w-56 p-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]">
              {menus[name].map((item) => (
                <div key={item.label}>
                  <button
                    onClick={item.run}
                    className="flex w-full items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg/85 transition-colors hover:bg-accent/15 hover:text-accent"
                  >
                    <span>{item.label}</span>
                    {item.accel && (
                      <span className="font-mono text-[10px] text-faint">{fmtAccel(item.accel)}</span>
                    )}
                  </button>
                  {item.separatorAfter && <div className="my-1 h-px bg-line-soft" />}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
