interface Option {
  id: string
  label: string
}

interface Props {
  /** Open tabs that could be shown in this empty pane (everything not already in the view). */
  options: Option[]
  onPick: (id: string) => void
  /** Remove this empty pane from the split. */
  onClose: () => void
}

// Shown inside an empty split pane: pick one of the other open tabs to join it
// into this pane (that tab then stops being a separate tab in the bar).
export function PanePicker({ options, onPick, onClose }: Props) {
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-3 bg-ink/40 p-4 text-center">
      <button
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded text-faint transition-colors hover:bg-danger/80 hover:text-white"
        title="Close this pane"
        aria-label="Close this pane"
      >
        ×
      </button>
      <p className="eyebrow">empty pane</p>
      {options.length ? (
        <>
          <p className="text-xs text-muted">Choose a tab to show here</p>
          <div className="flex max-h-full flex-wrap items-center justify-center gap-2 overflow-auto">
            {options.map((o) => (
              <button
                key={o.id}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onPick(o.id)}
                className="max-w-[220px] truncate rounded-lg border border-line bg-elevated/50 px-3 py-1.5 font-mono text-[12px] text-fg/80 transition-colors hover:border-signal/50 hover:bg-signal/15 hover:text-signal"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="text-xs text-faint">Open another tab from the sidebar to add it here.</p>
      )}
    </div>
  )
}
