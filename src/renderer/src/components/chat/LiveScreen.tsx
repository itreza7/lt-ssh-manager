import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatKeysResult, ChatTarget } from '../../../../shared/chatProtocol'
import { screenItemKey, type ScreenItem, type ScreenModel } from '../../../../shared/tuiKeys'
import { Spinner } from './Blocks'

const POLL_MS = 700
// A key press shows its effect a moment later.
const AFTER_KEY_MS = 150
const RECHECK_MS = 250
// Esc presses to close a screen with sub-screens (/config needs two).
const CLOSE_PRESSES = 3
// "↓ 20 more": how far one click scrolls.
const SCROLL_STEP = 10

const KEY_OF: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Escape: 'Escape',
  Backspace: 'BSpace',
  PageUp: 'PPage',
  PageDown: 'NPage',
  Home: 'Home',
  End: 'End',
  ' ': 'Space'
}

const BUTTONS: { label: string; key: string }[] = [
  { label: '↑', key: 'Up' },
  { label: '↓', key: 'Down' },
  { label: '←', key: 'Left' },
  { label: '→', key: 'Right' },
  { label: 'Tab', key: 'Tab' },
  { label: 'Enter', key: 'Enter' },
  { label: 'Esc', key: 'Escape' }
]

// /status's "Version:   2.1.292" lines.
const KEY_VALUE_RE = /^([^:]{1,40}):\s{2,}(.+)$/

const pill = 'rounded-md bg-sel px-2 py-0.5 text-[12px] text-fg transition-colors hover:bg-white/[0.12] disabled:opacity-50'

/**
 * A screen a slash command opened in the TUI (/config, /mcp, /resume…), shown as app UI:
 * tabs, a search box and rows you click. Each click moves the TUI's own selection there
 * and presses Enter, so the TUI stays the one source of truth. A screen it cannot read
 * shows as text with key buttons. Keys typed while it has focus go to the screen too.
 * It closes itself once the screen is gone.
 */
export function LiveScreen({ title, target, pane, active, onClose }: { title: string; target: ChatTarget; pane: string; active: boolean; onClose: () => void }) {
  const [data, setData] = useState<{ text: string; screen: ScreenModel | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // What is on its way: a row's key, a tab label, or 'keys'.
  const [doing, setDoing] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Two reads in a row with no screen: it is closed (one could be a redraw).
  const misses = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const read = async (): Promise<boolean> => {
    try {
      const d = await window.api.chatScreen({ ...target, pane })
      if (d === null) {
        if (++misses.current >= 2) onCloseRef.current()
        // Check again soon, so other commands are not blocked by a card that is already gone.
        else setTimeout(() => void read(), RECHECK_MS)
        return false
      }
      misses.current = 0
      setData((prev) => (JSON.stringify(prev) === JSON.stringify(d) ? prev : d))
      return true
    } catch {
      /* a dropped link: the next read tries again */
      return true
    }
  }

  useEffect(() => {
    if (!active) return
    let off = false
    const loop = async (): Promise<void> => {
      await read()
      if (!off) timer.current = setTimeout(() => void loop(), POLL_MS)
    }
    void loop()
    return () => {
      off = true
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pane])

  useEffect(() => {
    if (active) box.current?.focus()
  }, [active])

  const run = async (what: string, call: () => Promise<ChatKeysResult>): Promise<void> => {
    setDoing(what)
    try {
      const r = await call()
      setError(r.ok ? null : r.reason === 'screen' ? 'The screen is closed.' : (r.message ?? 'Could not do that.'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await new Promise((r) => setTimeout(r, AFTER_KEY_MS))
    await read()
    setDoing(null)
  }
  const send = (keys: string[], typed?: string): Promise<void> =>
    run('keys', () => window.api.chatDialogKeys({ ...target, pane, keys, ...(typed ? { text: typed } : {}) }))
  const pick = (item: ScreenItem): Promise<void> => {
    const key = screenItemKey(item)
    return run(key, () => window.api.chatScreenPick({ ...target, pane, key, press: 'Enter' }))
  }
  const tab = (label: string): Promise<void> => run(`tab:${label}`, () => window.api.chatScreenTab({ ...target, pane, label }))
  // One Esc at a time, each only while a screen is still open: an Esc on the plain
  // screen would interrupt Claude.
  const close = async (): Promise<void> => {
    setDoing('close')
    for (let i = 0; i < CLOSE_PRESSES; i++) {
      const r = await window.api.chatDialogKeys({ ...target, pane, keys: ['Escape'] }).catch(() => null)
      if (!r?.ok) break
      await new Promise((res) => setTimeout(res, AFTER_KEY_MS * 2))
      if (!(await read())) break
    }
    setDoing(null)
  }
  // The search box types into the screen's own filter.
  const search = (next: string): void => {
    let same = 0
    while (same < query.length && same < next.length && query[same] === next[same]) same++
    const back = query.length - same
    const typed = next.slice(same)
    setQuery(next)
    if (back || typed) void send(Array<string>(back).fill('BSpace'), typed || undefined)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === 'Tab') {
      e.preventDefault()
      void send([e.shiftKey ? 'BTab' : 'Tab'])
    } else if (KEY_OF[e.key]) {
      e.preventDefault()
      void send([KEY_OF[e.key]])
    } else if (e.key.length === 1) {
      e.preventDefault()
      void send([], e.key)
    }
  }

  const s = data?.screen
  const native = !!s && (s.items.length > 0 || s.intro.length > 0)

  return (
    <div ref={box} tabIndex={0} onKeyDown={onKeyDown} className="rounded-xl border border-sel bg-panel outline-none transition-colors focus:border-[#555]">
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className="text-[14px] font-medium text-title">{s?.title || title}</span>
        {doing && <Spinner className="text-faint" />}
        <span className="ml-auto" />
        {native && (
          <button onClick={() => void send(['Escape'])} disabled={!!doing} className={pill} title="Back (Esc)">
            Back
          </button>
        )}
        <button onClick={() => void close()} disabled={!!doing} className={pill} title="Close this screen">
          Close
        </button>
      </div>

      {s && s.tabs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 px-4">
          {s.tabs.map((t) => (
            <button
              key={t.label}
              disabled={!!doing}
              onClick={() => !t.active && void tab(t.label)}
              className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[12.5px] transition-colors ${t.active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-white/[0.06]'}`}
            >
              {t.label}
              {doing === `tab:${t.label}` && <Spinner />}
            </button>
          ))}
        </div>
      )}

      {native ? (
        <div className="px-4 pb-3 pt-2">
          {s.search !== null && (
            <input
              value={query}
              onChange={(e) => search(e.target.value)}
              placeholder={s.search}
              dir="auto"
              className="mb-2 w-full rounded-lg border border-sel bg-ink px-3 py-1.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-[#444]"
            />
          )}
          <Intro lines={s.intro} />
          {s.above > 0 && (
            <button onClick={() => void send(Array<string>(SCROLL_STEP).fill('Up'))} disabled={!!doing} className="mb-1 text-[12px] text-faint hover:text-fg">
              ↑ {s.above} more
            </button>
          )}
          <Rows items={s.items} doing={doing} onPick={(i) => void pick(i)} />
          {s.below > 0 && (
            <button onClick={() => void send(Array<string>(SCROLL_STEP).fill('Down'))} disabled={!!doing} className="mt-1 text-[12px] text-faint hover:text-fg">
              ↓ {s.below} more
            </button>
          )}
          {s.outro.map((l, i) => (
            <p key={i} dir="auto" className="mt-2 text-[12px] text-faint">
              {l}
            </p>
          ))}
        </div>
      ) : (
        <>
          <pre dir="ltr" className="max-h-96 overflow-auto whitespace-pre px-4 py-2 font-mono text-[12px] leading-relaxed text-fg/85">
            {data?.text ?? 'Opening…'}
          </pre>
          <div className="flex flex-wrap items-center gap-1 border-t border-sel px-3 py-1.5">
            {BUTTONS.map((b) => (
              <button key={b.key} onMouseDown={(e) => e.preventDefault()} onClick={() => void send([b.key])} className={`${pill} font-mono`}>
                {b.label}
              </button>
            ))}
          </div>
        </>
      )}
      {(error || (native && s.hint)) && (
        <div className="border-t border-sel px-4 py-1.5 text-[11.5px]">
          {error ? <span className="text-amber">{error}</span> : <span className="text-faint">{s?.hint}</span>}
        </div>
      )}
    </div>
  )
}

/** The lines above the rows: a key/value table when they are "Key:  value" (/status). */
function Intro({ lines }: { lines: string[] }) {
  if (!lines.length) return null
  const pairs = lines.map((l) => KEY_VALUE_RE.exec(l))
  if (pairs.every(Boolean))
    return (
      <table className="mb-2 w-full text-[13px]">
        <tbody>
          {pairs.map((p, i) => (
            <tr key={i}>
              <td className="whitespace-nowrap py-0.5 pr-4 align-top text-muted">{p![1]}</td>
              <td dir="auto" className="break-all py-0.5 text-fg">
                {p![2]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  return (
    <div className="mb-2 space-y-0.5">
      {lines.map((l, i) => (
        <p key={i} dir="auto" className="text-[12.5px] text-muted">
          {l}
        </p>
      ))}
    </div>
  )
}

const MARK_ICON: Record<NonNullable<ScreenItem['mark']>, { icon: string; cls: string }> = {
  ok: { icon: '✓', cls: 'text-green-400' },
  error: { icon: '✕', cls: 'text-red-400' },
  warn: { icon: '!', cls: 'text-amber' }
}

/** The rows, under their section headings. */
function Rows({ items, doing, onPick }: { items: ScreenItem[]; doing: string | null; onPick: (i: ScreenItem) => void }) {
  let section: string | undefined
  return (
    <div className="space-y-0.5">
      {items.map((it) => {
        const key = screenItemKey(it)
        const heading = it.section !== section ? it.section : undefined
        section = it.section
        const bool = it.value === 'true' || it.value === 'false'
        return (
          <div key={key}>
            {heading && <div className="eyebrow mb-1 mt-3 text-faint">{heading}</div>}
            <button
              disabled={!!doing}
              onClick={() => onPick(it)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-line ${it.selected ? 'bg-white/[0.04]' : ''}`}
            >
              {it.mark && <span className={`w-3 shrink-0 text-center text-[12px] ${MARK_ICON[it.mark].cls}`}>{MARK_ICON[it.mark].icon}</span>}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  {it.tag && <span className="shrink-0 rounded bg-sel px-1 text-[10.5px] text-muted">{it.tag}</span>}
                  <span dir="auto" className="truncate text-[13px] text-fg">
                    {it.label}
                  </span>
                </span>
                {it.detail && (
                  <span dir="auto" className="block truncate text-[11.5px] text-faint">
                    {it.detail}
                  </span>
                )}
              </span>
              {doing === key ? (
                <Spinner className="text-accent" />
              ) : bool ? (
                <Switch on={it.value === 'true'} />
              ) : (
                it.value && (
                  <span dir="auto" className="max-w-[45%] shrink-0 truncate text-[12px] text-muted">
                    {it.value}
                  </span>
                )
              )}
              {it.sub && <span className="shrink-0 text-faint">›</span>}
            </button>
          </div>
        )
      })}
    </div>
  )
}

const Switch = ({ on }: { on: boolean }) => (
  <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-sel'}`}>
    <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${on ? 'left-3.5' : 'left-0.5'}`} />
  </span>
)
