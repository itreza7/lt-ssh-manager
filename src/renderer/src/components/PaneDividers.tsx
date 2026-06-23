import { useRef, type RefObject, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { SplitDirection } from '../../../shared/types'

interface Props {
  direction: SplitDirection
  sizes: number[] // pane fractions, summing to 1
  /** The split container; used to convert pointer travel into a size fraction. */
  containerRef: RefObject<HTMLDivElement | null>
  onResize: (sizes: number[]) => void
}

const MIN = 0.12 // a pane can't be dragged below this fraction of the container

// Draggable dividers sitting on each pane boundary. Dragging shifts size between
// the two adjacent panes; the panes themselves are absolutely positioned by the
// caller from `sizes`, so this only has to report new fractions.
export function PaneDividers({ direction, sizes, containerRef, onResize }: Props) {
  const raf = useRef<number | null>(null)
  const cols = direction === 'columns'

  if (sizes.length < 2) return null

  const startDrag = (j: number) => (e: ReactPointerEvent) => {
    e.preventDefault()
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const total = cols ? rect.width : rect.height
    if (total <= 0) return
    const origin = cols ? e.clientX : e.clientY
    const base = sizes.slice()
    const a = base[j]
    const b = base[j + 1]

    const move = (ev: PointerEvent): void => {
      let delta = ((cols ? ev.clientX : ev.clientY) - origin) / total
      delta = Math.max(-a + MIN, Math.min(b - MIN, delta))
      const next = base.slice()
      next[j] = a + delta
      next[j + 1] = b - delta
      if (raf.current != null) cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(() => onResize(next))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  let acc = 0
  return (
    <>
      {sizes.slice(0, -1).map((s, j) => {
        acc += s
        const pos = `${(acc * 100).toFixed(4)}%`
        const style: CSSProperties = cols
          ? { left: pos, top: 0, bottom: 0, width: 11, transform: 'translateX(-50%)' }
          : { top: pos, left: 0, right: 0, height: 11, transform: 'translateY(-50%)' }
        return (
          <div
            key={j}
            onPointerDown={startDrag(j)}
            style={style}
            className={`group absolute z-20 flex items-center justify-center ${
              cols ? 'cursor-col-resize' : 'cursor-row-resize'
            }`}
          >
            <div
              className={`rounded-full bg-line transition-colors group-hover:bg-signal/70 ${
                cols ? 'h-10 w-[2px]' : 'h-[2px] w-10'
              }`}
            />
          </div>
        )
      })}
    </>
  )
}
