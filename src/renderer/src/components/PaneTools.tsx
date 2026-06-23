import type { SplitDirection } from '../../../shared/types'

interface Props {
  /** Split axis — picks horizontal vs vertical move arrows. */
  direction: SplitDirection
  canMovePrev: boolean
  canMoveNext: boolean
  /** Swap this pane with the previous one (left / up). */
  onMovePrev: () => void
  /** Swap this pane with the next one (right / down). */
  onMoveNext: () => void
  /** Collapse the split to show only this pane ("detach back to a normal tab"). */
  onDetach: () => void
  /** Remove just this pane from the split. */
  onClose: () => void
}

// Per-pane controls, shown only while its pane is hovered. They are both
// invisible AND click-through (pointer-events-none) until then, so they never
// intercept clicks/selection over the terminal or editor underneath.
export function PaneTools({ direction, canMovePrev, canMoveNext, onMovePrev, onMoveNext, onDetach, onClose }: Props) {
  const cols = direction === 'columns'
  const btn =
    'grid h-5 w-5 place-items-center rounded text-faint transition-colors hover:bg-elevated hover:text-fg'
  // a left-pointing chevron, rotated to point in the move direction
  const chevron = (dir: 'prev' | 'next'): number =>
    cols ? (dir === 'prev' ? 0 : 180) : dir === 'prev' ? 90 : 270
  const Chevron = ({ dir }: { dir: 'prev' | 'next' }) => (
    <svg
      width="11"
      height="11"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      style={{ transform: `rotate(${chevron(dir)}deg)` }}
    >
      <path d="M9 2.5 4.5 7 9 11.5" />
    </svg>
  )
  return (
    // Stop mousedown from bubbling to the pane wrapper's focus handler: otherwise
    // pressing a tool first re-focuses the pane (a re-render) and that swallows
    // the button's own click, so the action only takes on the *second* press.
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border border-line bg-surface/85 p-0.5 opacity-0 backdrop-blur-sm transition-opacity group-hover/pane:pointer-events-auto group-hover/pane:opacity-100"
    >
      {canMovePrev && (
        <button onClick={onMovePrev} className={btn} title={cols ? 'Move left' : 'Move up'} aria-label="Move pane back">
          <Chevron dir="prev" />
        </button>
      )}
      {canMoveNext && (
        <button
          onClick={onMoveNext}
          className={btn}
          title={cols ? 'Move right' : 'Move down'}
          aria-label="Move pane forward"
        >
          <Chevron dir="next" />
        </button>
      )}
      <button onClick={onDetach} className={btn} title="Detach to full screen" aria-label="Detach pane to full screen">
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M5 1.75H2.25v2.75M9 1.75h2.75v2.75M5 12.25H2.25V9.5M9 12.25h2.75V9.5" />
        </svg>
      </button>
      <button
        onClick={onClose}
        title="Close this pane"
        aria-label="Close this pane"
        className="grid h-5 w-5 place-items-center rounded text-faint transition-colors hover:bg-danger/80 hover:text-white"
      >
        <svg width="11" height="11" viewBox="0 0 11 11">
          <line x1="1.5" y1="1.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1.3" />
          <line x1="9.5" y1="1.5" x2="1.5" y2="9.5" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
    </div>
  )
}
