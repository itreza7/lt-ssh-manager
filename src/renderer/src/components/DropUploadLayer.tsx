import type { DropStatus } from '../lib/useDropUpload'
import { IMAGE_PASTE_ACCEL } from '../lib/xtermAttach'

/**
 * The chrome for drop-to-upload, in two pieces because the tmux view needs them
 * in different places: the "let go here" affordance belongs to the one pane
 * under the pointer, while the status of a batch belongs to the tab.
 *
 * Both are absolutely positioned overlays, never docked siblings — the same
 * constraint the prompt composer documents. A docked element changes the
 * terminal host's box, the ResizeObserver turns that into a PTY resize, and
 * under tmux that reflows the session for *every* attached client. Hovering a
 * file over a pane must not reformat someone else's window.
 */

/**
 * Shown over the terminal that would receive the files.
 *
 * `pointer-events-none` is load-bearing, not tidiness: this appears directly
 * under the pointer mid-drag, and an overlay that swallowed events would read as
 * "the files left the terminal" and cancel the very drop it was drawn to invite.
 */
export function DropHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-ink/70 p-4 backdrop-blur-[1px]">
      <div className="animate-rise flex flex-col items-center gap-1.5 rounded-[0.85rem] border border-dashed border-accent/60 bg-panel/80 px-7 py-6 text-center">
        <div className="eyebrow text-accent">drop to upload</div>
        <p className="text-sm text-fg">Files go to a private folder on the host</p>
        <p className="text-[11px] text-faint">
          The path is typed at your cursor — nothing runs. Images: {IMAGE_PASTE_ACCEL}
        </p>
      </div>
    </div>
  )
}

/**
 * Progress and outcome for the last batch. Top edge, not bottom: the composer
 * owns the bottom, and the prompt is the last row anything should cover.
 */
export function DropStatusBar({
  status,
  onDismiss
}: {
  status: DropStatus | null
  onDismiss: () => void
}) {
  if (!status) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-2">
      <div className="panel animate-rise flex max-w-[92%] items-center gap-2.5 px-3 py-1.5 shadow-lg shadow-ink/40">
        {status.kind === 'busy' ? (
          <span className="animate-glow shrink-0 text-accent">⟳</span>
        ) : status.kind === 'done' ? (
          <span className="shrink-0 text-accent">✓</span>
        ) : status.kind === 'error' ? (
          <span className="shrink-0 text-danger">!</span>
        ) : (
          <span className="shrink-0 text-faint">·</span>
        )}
        <span
          className={`truncate text-xs ${
            status.kind === 'error'
              ? 'text-danger'
              : status.kind === 'done'
                ? 'font-mono text-fg'
                : 'text-fg'
          }`}
          title={status.text}
        >
          {status.text}
        </span>
        {status.kind === 'busy' && status.pct !== undefined && (
          <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-line">
            <span
              className="block h-full bg-accent transition-[width] duration-150"
              style={{ width: `${Math.round(status.pct * 100)}%` }}
            />
          </span>
        )}
        <button
          onClick={onDismiss}
          title="Dismiss"
          className="pointer-events-auto shrink-0 px-1 text-faint transition-colors hover:text-fg"
        >
          ×
        </button>
      </div>
    </div>
  )
}

/** Both pieces at once — what a single-terminal tab wants. */
export function DropUploadLayer({
  over,
  status,
  onDismiss
}: {
  over: boolean
  status: DropStatus | null
  onDismiss: () => void
}) {
  return (
    <>
      {over && <DropHint />}
      <DropStatusBar status={status} onDismiss={onDismiss} />
    </>
  )
}
