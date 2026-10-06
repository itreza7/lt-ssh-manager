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

const box = 'animate-rise absolute z-20 rounded-[10px] border border-sel bg-elevated p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]'
const pop = `${box} right-0 top-[calc(100%+4px)] w-60`
const popLeft = `${box} left-0 top-[calc(100%+4px)] w-60`
// The composer's row sits at the bottom of the window: its menus open upward.
const popUp = `${box} bottom-[calc(100%+4px)] left-0 w-60`
const item = 'flex h-7 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-[13px] text-fg transition-colors hover:bg-sel disabled:opacity-40 disabled:hover:bg-transparent'
const search = 'mb-1 h-7 w-full rounded-md border border-sel bg-panel px-2 text-[13px] text-fg outline-none placeholder:text-faint focus:border-[#444]'
const ghost = 'no-drag grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-white/[0.06] hover:text-title disabled:opacity-40 disabled:hover:bg-transparent'

const Check = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

const Chevron = ({ right }: { right?: boolean }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0 text-faint"
    style={right ? { transform: 'rotate(-90deg)' } : undefined}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export function ModeMenu({ mode, disabled, onPick, up }: { mode: ChatMode | null; disabled: boolean; onPick: (m: ChatMode) => void; up?: boolean }) {
  const { open, setOpen, ref } = usePopover()
  return (
    <div ref={ref} className="no-drag relative">
      <button
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title="Permission mode (Shift+Tab in the terminal)"
        className={`flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[12.5px] text-muted transition-colors disabled:opacity-100 ${disabled ? '' : 'hover:bg-white/[0.06]'}`}
      >
        {mode ? modeLabel(mode) : 'Mode'}
        {!disabled && <Chevron />}
      </button>
      {open && (
        <div className={up ? popUp : pop}>
          {MODE_ITEMS.map((m) => (
            <button
              key={m.value}
              onClick={() => {
                setOpen(false)
                if (m.value !== mode) onPick(m.value)
              }}
              className={item}
            >
              {m.label}
              {m.value === mode && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A small dropdown for a composer setting (model, effort). Opens upward. */
export function PickMenu({
  title,
  value,
  options,
  placeholder,
  disabled,
  onPick
}: {
  title: string
  value: string
  options: { value: string; label: string }[]
  /** Shown when `value` is none of the options. */
  placeholder?: string
  disabled?: boolean
  onPick: (value: string) => void
}) {
  const { open, setOpen, ref } = usePopover()
  const current = options.find((o) => o.value === value)
  return (
    <div ref={ref} className="no-drag relative">
      <button
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title={title}
        className={`flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[12.5px] text-fg transition-colors disabled:opacity-100 ${disabled ? '' : 'hover:bg-white/[0.06]'}`}
      >
        {current?.label ?? placeholder ?? value}
        {!disabled && <Chevron />}
      </button>
      {open && (
        <div className={`${box} bottom-[calc(100%+4px)] right-0 w-40`}>
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                setOpen(false)
                if (o.value !== value) onPick(o.value)
              }}
              className={item}
            >
              {o.label}
              {o.value === value && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The composer's "+": every skill and command, searchable. A pick puts "/name " in the box. */
export function CommandPicker({
  commands,
  disabled,
  onNeedCommands,
  onPick
}: {
  commands: CommandInfo[]
  disabled?: boolean
  onNeedCommands: () => void
  onPick: (name: string) => void
}) {
  const { open, setOpen, ref } = usePopover()
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? commands.filter((c) => c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle)) : commands
  }, [commands, q])
  return (
    <div ref={ref} className="no-drag relative">
      <button
        disabled={disabled}
        onClick={() => {
          if (!open) onNeedCommands()
          setQ('')
          setOpen(!open)
        }}
        title="Skills & commands"
        className={`${ghost} ${open ? 'bg-white/[0.06] text-title' : ''}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M12 5v14" />
        </svg>
      </button>
      {open && (
        <div className={`${box} bottom-[calc(100%+4px)] left-0 w-72`}>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className={search}
          />
          <div className="max-h-56 overflow-y-auto">
            {list.length === 0 ? (
              <div className="px-2 py-1.5 text-[13px] text-faint">{q ? 'No match.' : 'None found.'}</div>
            ) : (
              list.map((c) => (
                <button
                  key={`${c.source}:${c.name}`}
                  onClick={() => {
                    setOpen(false)
                    onPick(c.name)
                  }}
                  title={c.description}
                  className="block w-full rounded-md px-2 py-1 text-left transition-colors hover:bg-sel"
                >
                  <span className="block truncate font-mono text-[13px] text-fg">/{c.name}</span>
                  {c.description && <span className="block truncate text-[12px] text-faint">{c.description}</span>}
                </button>
              ))
            )}
          </div>
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
  /** The trigger: a ⌄ beside the title, or a ⋮ at the right. */
  variant?: 'chevron' | 'dots'
}

type Sub = 'effort' | 'skills' | null

/** The actions menu: what Claude Code's slash commands do, one click away. */
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
    <button disabled={!enabled} onClick={onClick} className={item}>
      <span>{label}</span>
      {extra}
    </button>
  )

  return (
    <div ref={ref} className="no-drag relative">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        title="Actions"
        className={`${ghost} ${open ? 'bg-white/[0.06] text-title' : ''}`}
      >
        {p.variant === 'chevron' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="5" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="12" cy="19" r="1" />
          </svg>
        )}
      </button>
      {open && (
        <div className={p.variant === 'chevron' ? popLeft : pop}>
          {row('Compact', run(p.onCompact))}
          {row('Clear…', run(p.onClear))}
          {row('Effort', toggleSub('effort'), <Chevron right={sub !== 'effort'} />)}
          {sub === 'effort' && (
            <div className="mb-1 ml-2 border-l border-sel pl-1">
              {EFFORTS.map((l) => (
                <button key={l} disabled={p.disabled} onClick={run(() => p.onEffort(l))} className={item}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {row('Context', run(p.onContext))}
          {row('Usage', run(p.onUsage))}
          <div className="my-1 h-px bg-sel" />
          <button onClick={toggleSub('skills')} className={item}>
            <span>Skills &amp; commands</span>
            <Chevron right={sub !== 'skills'} />
          </button>
          {sub === 'skills' && (
            <div className="mb-1 mt-0.5 px-1">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                className={search}
              />
              <div className="max-h-56 overflow-y-auto">
                {p.commands === null ? (
                  <div className="px-2 py-1.5 text-[13px] text-faint">Loading…</div>
                ) : list.length === 0 ? (
                  <div className="px-2 py-1.5 text-[13px] text-faint">{q ? 'No match.' : 'None found.'}</div>
                ) : (
                  list.map((c) => (
                    <button
                      key={`${c.source}:${c.name}`}
                      onClick={run(() => p.onPick(c.name))}
                      title={c.description}
                      className="block w-full rounded-md px-2 py-1 text-left transition-colors hover:bg-sel"
                    >
                      <span className="block truncate font-mono text-[13px] text-fg">/{c.name}</span>
                      {c.description && <span className="block truncate text-[12px] text-faint">{c.description}</span>}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
          {p.onOpenTerminal && (
            <>
              <div className="my-1 h-px bg-sel" />
              {row('Open in terminal', run(p.onOpenTerminal), undefined, true)}
            </>
          )}
        </div>
      )}
    </div>
  )
}
