import { useEffect, useState } from 'react'
import type { TunnelDef, TunnelStatus, TunnelType } from '../../../shared/types'
import { Button, Modal } from './Modal'
import { Select } from './Select'

interface Props {
  connectionId: string
  connectionName: string
  password?: string
  active: boolean
}

const TYPE_META: Record<TunnelType, { label: string; tag: string; hint: string }> = {
  local: {
    label: 'Local  (-L)',
    tag: 'L',
    hint: 'Listen locally, forward to a host reachable from the server.'
  },
  remote: {
    label: 'Remote  (-R)',
    tag: 'R',
    hint: 'Listen on the server, forward back to a host reachable from here.'
  },
  dynamic: {
    label: 'Dynamic  (-D)',
    tag: 'D',
    hint: 'A local SOCKS5 proxy that routes through the server.'
  }
}

const STATE_DOT: Record<TunnelStatus['state'], string> = {
  active: 'bg-emerald-400 dot-glow',
  starting: 'bg-amber-400 animate-pulse',
  error: 'bg-red-500',
  stopped: 'bg-white/25'
}

// A compact "L 127.0.0.1:8080 → example.com:80"-style summary.
function describe(d: TunnelDef): string {
  const bind = `${d.bindAddr || '127.0.0.1'}:${d.bindPort}`
  if (d.type === 'dynamic') return `${bind}  ·  SOCKS5`
  const dst = `${d.dstHost || '127.0.0.1'}:${d.dstPort ?? '?'}`
  return d.type === 'remote' ? `${bind} ⇠ ${dst}` : `${bind} → ${dst}`
}

const blankDef = (): TunnelDef => ({
  id: crypto.randomUUID(),
  type: 'local',
  bindAddr: '127.0.0.1',
  bindPort: 0,
  dstHost: '',
  dstPort: 0
})

export function TunnelManager({ connectionId, connectionName, password, active }: Props) {
  const [defs, setDefs] = useState<TunnelDef[]>([])
  const [statuses, setStatuses] = useState<Record<string, TunnelStatus>>({})
  const [editing, setEditing] = useState<TunnelDef | null>(null) // null = closed
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void window.api.tunnelList(connectionId).then((d) => {
      setDefs(d)
      setLoaded(true)
    })
    void window.api.tunnelStatuses().then((all) => {
      const mine: Record<string, TunnelStatus> = {}
      for (const s of all) if (s.connectionId === connectionId) mine[s.defId] = s
      setStatuses(mine)
    })
    return window.api.onTunnelStatus((s) => {
      if (s.connectionId !== connectionId) return
      setStatuses((prev) => {
        const next = { ...prev }
        if (s.state === 'stopped') delete next[s.defId]
        else next[s.defId] = s
        return next
      })
    })
  }, [connectionId])

  const persist = (next: TunnelDef[]): void => {
    setDefs(next)
    void window.api.tunnelSave(connectionId, next)
  }

  const saveDef = (def: TunnelDef): void => {
    const i = defs.findIndex((d) => d.id === def.id)
    persist(i >= 0 ? defs.map((d) => (d.id === def.id ? def : d)) : [...defs, def])
    setEditing(null)
  }

  const removeDef = (def: TunnelDef): void => {
    if (statuses[def.id]) window.api.tunnelStop(def.id)
    persist(defs.filter((d) => d.id !== def.id))
  }

  const start = (def: TunnelDef): void => {
    setStatuses((p) => ({
      ...p,
      [def.id]: { defId: def.id, connectionId, state: 'starting', conns: 0 }
    }))
    void window.api.tunnelStart({ connectionId, defId: def.id, password })
  }

  return (
    <div className="h-full overflow-y-auto px-10 py-9" style={{ visibility: active ? 'visible' : 'hidden' }}>
      <div className="mx-auto max-w-3xl">
        <div className="animate-rise mb-7 flex items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="eyebrow mb-2">Port forwarding</div>
            <h1 className="truncate text-3xl font-bold tracking-tight text-fg">{connectionName}</h1>
            <p className="mt-1.5 text-sm text-muted">
              Local, remote and dynamic SOCKS tunnels over this connection.
            </p>
          </div>
          <Button variant="primary" onClick={() => setEditing(blankDef())}>
            + New tunnel
          </Button>
        </div>

        {loaded && defs.length === 0 && (
          <div className="panel animate-rise flex flex-col items-center gap-3 px-6 py-12 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-signal/10 font-mono text-signal ring-1 ring-signal/25">
              ⇄
            </div>
            <p className="text-sm text-muted">No tunnels yet.</p>
            <p className="eyebrow">forward a port to get started</p>
          </div>
        )}

        <div className="space-y-2.5">
          {defs.map((d, i) => {
            const st = statuses[d.id]
            const running = !!st && st.state !== 'stopped'
            const meta = TYPE_META[d.type]
            return (
              <div
                key={d.id}
                style={{ animationDelay: `${i * 30}ms` }}
                className="panel animate-rise flex items-center gap-4 px-4 py-3.5"
              >
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-black/30 font-mono text-sm font-bold text-signal ring-1 ring-line-soft"
                  title={meta.label}
                >
                  {meta.tag}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">
                      {d.label || meta.label}
                    </span>
                    <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[st?.state ?? 'stopped']}`} />
                    {st?.state === 'active' && (
                      <span className="font-mono text-[11px] text-faint">
                        {st.conns} conn{st.conns === 1 ? '' : 's'}
                      </span>
                    )}
                    {st?.state === 'error' && (
                      <span className="truncate font-mono text-[11px] text-danger" title={st.error}>
                        {st.error}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[12px] text-muted">{describe(d)}</div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {running ? (
                    <Button variant="danger" onClick={() => window.api.tunnelStop(d.id)}>
                      Stop
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={() => start(d)}>
                      Start ▸
                    </Button>
                  )}
                  <button
                    onClick={() => setEditing(d)}
                    disabled={running}
                    className="rounded-md px-2 py-1.5 text-faint transition-colors hover:text-fg disabled:opacity-30"
                    title="Edit"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => removeDef(d)}
                    className="rounded-md px-2 py-1.5 text-faint transition-colors hover:text-danger"
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {editing && (
        <TunnelForm
          initial={editing}
          existing={defs.some((d) => d.id === editing.id)}
          onCancel={() => setEditing(null)}
          onSave={saveDef}
        />
      )}
    </div>
  )
}

function TunnelForm({
  initial,
  existing,
  onCancel,
  onSave
}: {
  initial: TunnelDef
  existing: boolean
  onCancel: () => void
  onSave: (def: TunnelDef) => void
}) {
  const [type, setType] = useState<TunnelType>(initial.type)
  const [label, setLabel] = useState(initial.label ?? '')
  const [bindAddr, setBindAddr] = useState(initial.bindAddr || '127.0.0.1')
  const [bindPort, setBindPort] = useState(initial.bindPort ? String(initial.bindPort) : '')
  const [dstHost, setDstHost] = useState(initial.dstHost ?? '')
  const [dstPort, setDstPort] = useState(initial.dstPort ? String(initial.dstPort) : '')

  const needsDst = type !== 'dynamic'
  const bind = Number(bindPort)
  const dst = Number(dstPort)
  const valid =
    Number.isInteger(bind) &&
    bind > 0 &&
    bind < 65536 &&
    (!needsDst || (dstHost.trim() !== '' && Number.isInteger(dst) && dst > 0 && dst < 65536))

  const bindLabel = type === 'remote' ? 'Remote bind' : 'Local bind'
  const bindAddrHint = type === 'remote' ? '127.0.0.1 (use 0.0.0.0 to expose)' : '127.0.0.1'

  const submit = (): void => {
    if (!valid) return
    onSave({
      id: initial.id,
      type,
      label: label.trim() || undefined,
      bindAddr: bindAddr.trim() || '127.0.0.1',
      bindPort: bind,
      dstHost: needsDst ? dstHost.trim() : undefined,
      dstPort: needsDst ? dst : undefined
    })
  }

  return (
    <Modal
      title={existing ? 'Edit tunnel' : 'New tunnel'}
      width={460}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!valid}>
            {existing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Type">
          <Select
            width={260}
            value={type}
            onChange={(v) => setType(v as TunnelType)}
            options={(Object.keys(TYPE_META) as TunnelType[]).map((t) => ({
              value: t,
              label: TYPE_META[t].label
            }))}
          />
          <p className="mt-1.5 text-[12px] leading-relaxed text-faint">{TYPE_META[type].hint}</p>
        </Field>

        <Field label="Label (optional)">
          <Input value={label} onChange={setLabel} placeholder="e.g. Postgres" />
        </Field>

        <div className="grid grid-cols-[1fr_88px] gap-3">
          <Field label={`${bindLabel} address`}>
            <Input value={bindAddr} onChange={setBindAddr} placeholder={bindAddrHint} mono />
          </Field>
          <Field label="Port">
            <Input value={bindPort} onChange={setBindPort} placeholder="8080" mono />
          </Field>
        </div>

        {needsDst && (
          <div className="grid grid-cols-[1fr_88px] gap-3">
            <Field label={type === 'remote' ? 'Forward to (from here)' : 'Forward to (from server)'}>
              <Input value={dstHost} onChange={setDstHost} placeholder="localhost" mono />
            </Field>
            <Field label="Port">
              <Input value={dstPort} onChange={setDstPort} placeholder="5432" mono />
            </Field>
          </div>
        )}

        <p className="rounded-md border border-line-soft bg-black/20 px-3 py-2 font-mono text-[12px] text-muted">
          {previewLine(type, bindAddr, bindPort, dstHost, dstPort)}
        </p>
      </div>
    </Modal>
  )
}

function previewLine(
  type: TunnelType,
  bindAddr: string,
  bindPort: string,
  dstHost: string,
  dstPort: string
): string {
  const b = `${bindAddr || '127.0.0.1'}:${bindPort || '?'}`
  if (type === 'dynamic') return `SOCKS5 proxy on ${b}`
  const d = `${dstHost || '?'}:${dstPort || '?'}`
  return type === 'remote' ? `server:${b}  ⇠  ${d}` : `${b}  →  ${d}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-1.5 block">{label}</span>
      {children}
    </label>
  )
}

function Input({
  value,
  onChange,
  placeholder,
  mono
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-line bg-ink/60 px-2.5 py-1.5 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-signal/60 ${
        mono ? 'font-mono' : ''
      }`}
    />
  )
}
