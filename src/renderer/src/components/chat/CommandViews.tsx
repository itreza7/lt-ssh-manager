import { useState } from 'react'
import type { CommandInfo } from './Menus'
import type { UsageLimit } from '../../../../shared/tuiKeys'
import { UsageList } from '../ChatComposer'

const card = 'animate-rise rounded-xl border border-sel bg-panel px-4 py-3'

const Dismiss = ({ onClick }: { onClick: () => void }) => (
  <button onClick={onClick} title="Dismiss" className="ml-auto shrink-0 rounded-md px-1.5 text-base leading-none text-faint transition-colors hover:text-fg">
    ×
  </button>
)

/** /help in the app: every command and skill, searchable. A pick puts "/name " in the composer. */
export function HelpCard({ commands, onPick, onDismiss }: { commands: CommandInfo[]; onPick: (name: string) => void; onDismiss: () => void }) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase().replace(/^\//, '')
  const shown = commands.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle))
  return (
    <div className={card}>
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-medium text-title">Commands</span>
        <span className="text-[12px] text-faint">{commands.length}</span>
        <Dismiss onClick={onDismiss} />
      </div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search commands…"
        className="my-2 w-full rounded-lg border border-sel bg-ink px-3 py-1.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-[#444]"
      />
      <div className="max-h-80 overflow-y-auto">
        {shown.map((c) => (
          <button
            key={`${c.source}:${c.name}`}
            onClick={() => onPick(c.name)}
            className="flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-line"
          >
            <span className="shrink-0 font-mono text-[12.5px] text-fg">/{c.name}</span>
            <span dir="auto" className="min-w-0 truncate text-[12px] text-faint">
              {c.description}
            </span>
          </button>
        ))}
        {shown.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-faint">No command matches.</p>}
      </div>
    </div>
  )
}

/** /usage in the app: the plan limits as bars. */
export function UsageCard({ limits, onDismiss }: { limits: UsageLimit[]; onDismiss: () => void }) {
  return (
    <div className={card}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[14px] font-medium text-title">Plan usage limits</span>
        <Dismiss onClick={onDismiss} />
      </div>
      <UsageList limits={limits} />
    </div>
  )
}
