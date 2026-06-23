import { useEffect, useRef, useState } from 'react'

interface Props {
  onNewConnection: () => void
  onOpenSettings: () => void
}

interface Item {
  label: string
  accel?: string
  run: () => void
  separatorAfter?: boolean
}

export function TitleBar({ onNewConnection, onOpenSettings }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const [maximized, setMaximized] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.winIsMaximized().then(setMaximized)
    return window.api.onMaximizeChange(setMaximized)
  }, [])

  // close menus on outside click / Escape
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
    <div
      ref={barRef}
      className="drag relative z-30 flex h-9 shrink-0 items-center border-b border-line bg-surface/80 pl-2.5"
    >
      {/* brand mark */}
      <div className="no-drag flex items-center gap-2 pr-1">
        <span className="h-2 w-2 rounded-full bg-signal dot-glow text-signal" />
      </div>

      {/* menus */}
      <div className="no-drag flex items-center">
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
                      className="flex w-full items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg/85 transition-colors hover:bg-signal/15 hover:text-signal"
                    >
                      <span>{item.label}</span>
                      {item.accel && <span className="font-mono text-[10px] text-faint">{item.accel}</span>}
                    </button>
                    {item.separatorAfter && <div className="my-1 h-px bg-line-soft" />}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* draggable title */}
      <div className="drag flex flex-1 items-center justify-center">
        <span className="select-none font-mono text-[11px] tracking-[0.16em] text-faint">SSH MANAGER</span>
      </div>

      {/* settings */}
      <button
        onClick={onOpenSettings}
        title="Settings (Ctrl+,)"
        className="no-drag mr-1 grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-fg"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* window controls */}
      <div className="no-drag flex h-full items-stretch">
        <WinButton onClick={() => window.api.winMinimize()} label="minimize">
          <svg width="11" height="11" viewBox="0 0 11 11">
            <line x1="1.5" y1="5.5" x2="9.5" y2="5.5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </WinButton>
        <WinButton onClick={() => window.api.winToggleMaximize()} label="maximize">
          {maximized ? (
            <svg width="11" height="11" viewBox="0 0 11 11">
              <rect x="1.5" y="3" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M3.5 3 V1.5 H9.5 V7.5 H8" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 11 11">
              <rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </WinButton>
        <WinButton onClick={() => window.api.winClose()} label="close" danger>
          <svg width="11" height="11" viewBox="0 0 11 11">
            <line x1="1.5" y1="1.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
            <line x1="9.5" y1="1.5" x2="1.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </WinButton>
      </div>
    </div>
  )
}

function WinButton({
  children,
  onClick,
  label,
  danger
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`grid w-12 place-items-center text-muted transition-colors hover:text-fg ${
        danger ? 'hover:bg-danger hover:text-white' : 'hover:bg-elevated'
      }`}
    >
      {children}
    </button>
  )
}
