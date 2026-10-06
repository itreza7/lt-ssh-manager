import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMode } from '../../../../shared/chatProtocol'

/** A slash command Claude Code offers: a skill, a custom command, or one of the few built-ins this chat knows. */
export interface CommandInfo {
  name: string
  description: string
  source: string
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** The built-ins the chat can run (the rest of the TUI's commands are better used in the terminal). */
export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: 'compact', description: 'Summarize the conversation to free context', source: 'built-in' },
  { name: 'clear', description: 'Start a fresh session in this terminal', source: 'built-in' },
  { name: 'context', description: 'Show what fills the context window', source: 'built-in' },
  { name: 'usage', description: 'Show session cost and limits', source: 'built-in' },
  { name: 'effort', description: 'Set reasoning effort: low, medium, high, xhigh, max', source: 'built-in' }
]

export const MODE_ITEMS: { value: ChatMode; label: string }[] = [
  { value: 'default', label: 'Manual' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass permissions' }
]

export const modeLabel = (m: ChatMode): string => MODE_ITEMS.find((x) => x.value === m)?.label ?? m

/** Closes on a click outside or Escape. */
function usePopover(): { open: boolean; setOpen: (o: boolean) => void; ref: React.RefObject<HTMLDivElement | null> } {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
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
  return { open, setOpen, ref }
}

const pop = 'panel animate-rise absolute right-0 top-[calc(100%+4px)] z-20 w-60 p-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]'
const item = 'flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-40'

export function ModeMenu({ mode, disabled, onPick }: { mode: ChatMode | null; disabled: boolean; onPick: (m: ChatMode) => void }) {
  const { open, setOpen, ref } = usePopover()
  return (
    <div ref={ref} className="relative">
      <button
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title="Permission mode (Shift+Tab in the terminal)"
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] transition-colors disabled:opacity-60 ${
          mode === 'bypassPermissions' ? 'border-amber/40 text-amber' : mode === 'plan' ? 'border-signal/40 text-signal' : 'border-line text-muted'
        } ${disabled ? '' : 'hover:border-faint'}`}
      >
        {mode ? modeLabel(mode) : 'Mode'}
        {!disabled && <span className="text-[9px] text-faint">▾</span>}
      </button>
      {open && (
        <div className={pop}>
          {MODE_ITEMS.map((m) => (
            <button
              key={m.value}
              onClick={() => {
                setOpen(false)
                if (m.value !== mode) onPick(m.value)
              }}
              className={`${item} ${m.value === mode ? 'bg-accent/15 text-accent' : 'text-fg/85 hover:bg-elevated'}`}
            >
              {m.label}
              {m.value === mode && <span>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface ActionsProps {
  disabled: boolean
  /** Loads the skills and commands on first use. */
  commands: CommandInfo[] | null
  onNeedCommands: () => void
  onCompact: () => void
  onClear: () => void
  onEffort: (level: string) => void
  onContext: () => void
  onUsage: () => void
  /** A skill or command was picked: its name goes into the composer. */
  onPick: (name: string) => void
  onOpenTerminal?: () => void
}

type Sub = 'effort' | 'skills' | null

/** The "⋯" menu: what Claude Code's slash commands do, one click away. */
export function ActionsMenu(p: ActionsProps) {
  const { open, setOpen, ref } = usePopover()
  const [sub, setSub] = useState<Sub>(null)
  const [q, setQ] = useState('')

  const close = (): void => {
    setOpen(false)
    setSub(null)
    setQ('')
  }
  const run = (fn: () => void) => () => {
    close()
    fn()
  }
  const toggleSub = (s: Exclude<Sub, null>) => () => {
    setSub((cur) => (cur === s ? null : s))
    if (s === 'skills') p.onNeedCommands()
  }

  const list = useMemo(() => {
    // The built-ins have their own rows; this list is the user's skills and commands.
    const all = (p.commands ?? []).filter((c) => c.source !== 'built-in')
    const needle = q.trim().toLowerCase()
    return needle ? all.filter((c) => c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle)) : all
  }, [p.commands, q])

  const row = (label: ReactNode, onClick: () => void, extra?: ReactNode, enabled = !p.disabled) => (
    <button disabled={!enabled} onClick={onClick} className={`${item} text-fg/85 hover:bg-elevated`}>
      <span>{label}</span>
      {extra}
    </button>
  )

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        title="Actions"
        className={`grid h-[34px] w-8 place-items-center rounded-lg border bg-ink/60 text-base leading-none text-fg transition-colors ${
          open ? 'border-accent/60' : 'border-line hover:border-faint'
        }`}
      >
        ⋯
      </button>
      {open && (
        <div className={pop}>
          {row('Compact', run(p.onCompact))}
          {row('Clear…', run(p.onClear))}
          {row('Effort', toggleSub('effort'), <span className="text-[10px] text-faint">{sub === 'effort' ? '▾' : '▸'}</span>)}
          {sub === 'effort' && (
            <div className="mb-1 ml-2 border-l border-line-soft pl-1">
              {EFFORTS.map((l) => (
                <button key={l} disabled={p.disabled} onClick={run(() => p.onEffort(l))} className={`${item} text-fg/80 hover:bg-elevated`}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {row('Context', run(p.onContext))}
          {row('Usage', run(p.onUsage))}
          <div className="my-1 h-px bg-line-soft" />
          <button onClick={toggleSub('skills')} className={`${item} text-fg/85 hover:bg-elevated`}>
            <span>Skills &amp; commands</span>
            <span className="text-[10px] text-faint">{sub === 'skills' ? '▾' : '▸'}</span>
          </button>
          {sub === 'skills' && (
            <div className="mb-1 mt-0.5 px-1">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                className="mb-1 w-full rounded-md border border-line bg-ink/60 px-2 py-1 text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
              />
              <div className="max-h-56 overflow-y-auto">
                {p.commands === null ? (
                  <div className="px-2 py-1.5 text-[12px] text-faint">Loading…</div>
                ) : list.length === 0 ? (
                  <div className="px-2 py-1.5 text-[12px] text-faint">{q ? 'No match.' : 'None found.'}</div>
                ) : (
                  list.map((c) => (
                    <button
                      key={`${c.source}:${c.name}`}
                      onClick={run(() => p.onPick(c.name))}
                      title={c.description}
                      className="block w-full rounded-md px-2 py-1 text-left transition-colors hover:bg-elevated"
                    >
                      <span className="block truncate font-mono text-[12px] text-fg/90">/{c.name}</span>
                      {c.description && <span className="block truncate text-[11px] text-faint">{c.description}</span>}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
          {p.onOpenTerminal && (
            <>
              <div className="my-1 h-px bg-line-soft" />
              {row('Open in terminal', run(p.onOpenTerminal), undefined, true)}
            </>
          )}
        </div>
      )}
    </div>
  )
}
