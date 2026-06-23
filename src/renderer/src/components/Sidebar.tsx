import type { Connection } from '../../../shared/types'

interface Props {
  connections: Connection[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onEdit: (conn: Connection) => void
  onDelete: (conn: Connection) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

const authLabel: Record<Connection['authMethod'], string> = {
  key: 'KEY',
  password: 'PWD',
  agent: 'AGENT'
}

const initials = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '·'

export function Sidebar({
  connections,
  selectedId,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
  collapsed,
  onToggleCollapse
}: Props) {
  if (collapsed) {
    return (
      <div className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-line bg-surface/80 py-3">
        <button
          onClick={onToggleCollapse}
          title="Expand connections"
          className="grid h-8 w-8 place-items-center rounded-md bg-signal/15 ring-1 ring-signal/30 transition-colors hover:bg-signal/25"
        >
          <span className="h-2 w-2 rounded-full bg-signal dot-glow text-signal" />
        </button>

        <button
          onClick={onAdd}
          title="New connection (Ctrl+N)"
          className="grid h-8 w-8 place-items-center rounded-md border border-line text-faint transition-colors hover:border-signal/40 hover:text-signal"
        >
          +
        </button>

        <div className="my-0.5 h-px w-6 bg-line" />

        <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto">
          {connections.map((c) => {
            const selected = selectedId === c.id
            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                title={`${c.name} — ${c.username ? `${c.username}@` : ''}${c.host}:${c.port}`}
                className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-lg font-mono text-[11px] font-semibold transition-colors ${
                  selected
                    ? 'bg-signal-soft/50 text-fg ring-1 ring-signal/40'
                    : 'bg-elevated/40 text-muted hover:bg-elevated/70 hover:text-fg'
                }`}
              >
                {selected && (
                  <span className="absolute -left-1.5 inset-y-1.5 w-[2px] rounded-full bg-signal dot-glow text-signal" />
                )}
                {initials(c.name)}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-line bg-surface/80">
      {/* brand */}
      <div className="flex shrink-0 items-center gap-2.5 px-4 pb-3 pt-4">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-signal/15 ring-1 ring-signal/30">
          <span className="h-2 w-2 rounded-full bg-signal dot-glow text-signal" />
        </div>
        <div className="leading-tight">
          <div className="font-mono text-[13px] font-semibold tracking-[0.14em] text-fg">
            SSH<span className="text-signal">·</span>MANAGER
          </div>
          <div className="eyebrow !text-[9px]">control deck</div>
        </div>
      </div>

      {/* section header */}
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <span className="eyebrow">
          Connections <span className="text-faint/60">· {connections.length}</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onAdd}
            title="New connection (Ctrl+N)"
            className="grid h-6 w-6 place-items-center rounded-md border border-line text-faint transition-colors hover:border-signal/40 hover:text-signal"
          >
            +
          </button>
          <button
            onClick={onToggleCollapse}
            title="Collapse sidebar"
            className="grid h-6 w-6 place-items-center rounded-md border border-line text-faint transition-colors hover:border-signal/40 hover:text-signal"
          >
            «
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {connections.length === 0 && (
          <p className="px-3 py-8 text-center text-xs leading-relaxed text-faint">
            No connections yet.
            <br />
            Hit <span className="font-mono text-muted">+</span> to add your first host.
          </p>
        )}

        {connections.map((c, i) => {
          const selected = selectedId === c.id
          return (
            <div
              key={c.id}
              onClick={() => onSelect(c.id)}
              style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
              className={`group animate-rise relative mb-1 cursor-pointer rounded-lg px-3 py-2.5 transition-colors ${
                selected ? 'bg-signal-soft/40' : 'hover:bg-elevated/50'
              }`}
            >
              {selected && (
                <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-signal dot-glow text-signal" />
              )}
              <div className="flex items-center justify-between gap-2">
                <span className={`truncate text-sm font-medium ${selected ? 'text-fg' : 'text-fg/90'}`}>
                  {c.name}
                </span>
                <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onEdit(c)
                    }}
                    className="rounded px-1.5 text-xs text-faint hover:text-fg"
                    title="Edit"
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(c)
                    }}
                    className="rounded px-1.5 text-xs text-faint hover:text-danger"
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="truncate font-mono text-[11px] text-muted">
                  {c.username ? `${c.username}@` : ''}
                  {c.host}
                  <span className="text-faint">:{c.port}</span>
                </span>
                <span className="ml-auto shrink-0 rounded border border-line px-1 py-px font-mono text-[9px] tracking-wider text-faint">
                  {authLabel[c.authMethod]}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
