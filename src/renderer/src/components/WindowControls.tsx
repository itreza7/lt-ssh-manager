import { useEffect, useState } from 'react'

/** Minimize/maximize/close — non-macOS only. macOS supplies native traffic lights instead. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.winIsMaximized().then(setMaximized)
    return window.api.onMaximizeChange(setMaximized)
  }, [])

  return (
    <div className="flex h-full items-stretch">
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
