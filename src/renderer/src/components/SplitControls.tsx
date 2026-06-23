import type { SplitDirection } from '../../../shared/types'

interface Props {
  /** Current pane count (1 = single view). */
  count: number
  direction: SplitDirection
  /** Collapse back to a single pane (keeps the focused pane's tab). */
  onSingle: () => void
  /** Switch into / between split layouts. */
  onSplit: (direction: SplitDirection, count: number) => void
}

// Tab-bar controls for splitting the screen into 2–3 panes, by columns or rows.
export function SplitControls({ count, direction, onSingle, onSplit }: Props) {
  const split = count > 1
  const isCols = split && direction === 'columns'
  const isRows = split && direction === 'rows'

  const btn = (active: boolean): string =>
    `grid h-6 w-6 place-items-center rounded-md border transition-colors ${
      active
        ? 'border-signal/50 bg-signal/15 text-signal'
        : 'border-transparent text-faint hover:bg-elevated/60 hover:text-fg'
    }`

  return (
    <div className="flex items-center gap-1">
      <button title="Single pane" aria-label="Single pane" className={btn(count === 1)} onClick={onSingle}>
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="1.5" y="2.5" width="11" height="9" rx="1" />
        </svg>
      </button>
      <button
        title="Split into columns"
        aria-label="Split into columns"
        className={btn(isCols)}
        onClick={() => onSplit('columns', split ? count : 2)}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="1.5" y="2.5" width="11" height="9" rx="1" />
          <line x1="7" y1="2.5" x2="7" y2="11.5" />
        </svg>
      </button>
      <button
        title="Split into rows"
        aria-label="Split into rows"
        className={btn(isRows)}
        onClick={() => onSplit('rows', split ? count : 2)}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="1.5" y="2.5" width="11" height="9" rx="1" />
          <line x1="1.5" y1="7" x2="12.5" y2="7" />
        </svg>
      </button>
      {split && (
        <div className="ml-0.5 flex items-center gap-0.5 border-l border-line pl-1.5">
          {[2, 3].map((n) => (
            <button
              key={n}
              title={`${n} panes`}
              aria-label={`${n} panes`}
              onClick={() => onSplit(direction, n)}
              className={`grid h-6 w-6 place-items-center rounded-md font-mono text-[11px] transition-colors ${
                count === n ? 'bg-elevated text-fg' : 'text-faint hover:bg-elevated/60 hover:text-fg'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
