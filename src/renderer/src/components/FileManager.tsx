import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SftpEntry, SftpList, TransferProgress } from '../../../shared/types'
import { Button, Modal } from './Modal'

interface Props {
  connectionId: string
  password?: string
  initialPath?: string
  active: boolean
  /** Open a file in its own editor tab. */
  onOpenFile: (path: string, name: string) => void
  /** Report the current directory so it can be remembered per connection. */
  onCwdChange: (path: string) => void
}

// SFTP realpath resolves relative paths against the login dir, so a leading
// "~" can be treated as that base.
const expandTilde = (p: string): string => {
  const t = p.trim()
  if (t === '~') return '.'
  if (t.startsWith('~/')) return `.${t.slice(1)}`
  return t || '.'
}

type Status = 'connecting' | 'ready' | 'error'
type SortKey = 'name' | 'size' | 'mtime'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

function fmtTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameYear ? `${date} ${time}` : `${date} ${d.getFullYear()}`
}

const isDirLike = (e: SftpEntry): boolean =>
  e.type === 'directory' || (e.type === 'symlink' && e.target === 'directory')

function EntryIcon({ entry }: { entry: SftpEntry }) {
  if (isDirLike(entry)) return <span className="text-amber">▸▸</span>
  if (entry.type === 'symlink') return <span className="text-[#7aa2f7]">↳</span>
  return <span className="text-faint">▪</span>
}

// ---- small dialogs ----

function PromptDialog({
  title,
  label,
  initial,
  confirmLabel,
  onCancel,
  onConfirm
}: {
  title: string
  label: string
  initial: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const submit = (): void => {
    const v = value.trim()
    if (v) onConfirm(v)
  }
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <label className="eyebrow mb-2 block">{label}</label>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 font-mono text-sm text-fg outline-none focus:border-signal/60"
      />
    </Modal>
  )
}

function ChmodDialog({
  entry,
  onCancel,
  onConfirm
}: {
  entry: SftpEntry
  onCancel: () => void
  onConfirm: (mode: number) => void
}) {
  const [bits, setBits] = useState(entry.mode & 0o777)
  const groups = [
    { label: 'Owner', shift: 6 },
    { label: 'Group', shift: 3 },
    { label: 'Public', shift: 0 }
  ]
  const flags = [
    { label: 'r', bit: 4 },
    { label: 'w', bit: 2 },
    { label: 'x', bit: 1 }
  ]
  const toggle = (shift: number, bit: number): void => setBits((b) => b ^ (bit << shift))
  const octal = bits.toString(8).padStart(3, '0')
  return (
    <Modal
      title={`Permissions · ${entry.name}`}
      width={400}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => onConfirm(bits)}>
            Apply {octal}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.label} className="flex items-center justify-between">
            <span className="text-sm text-fg/85">{g.label}</span>
            <div className="flex gap-2">
              {flags.map((f) => {
                const on = (bits >> g.shift) & f.bit
                return (
                  <button
                    key={f.label}
                    onClick={() => toggle(g.shift, f.bit)}
                    className={`grid h-9 w-9 place-items-center rounded-md border font-mono text-sm transition-colors ${
                      on
                        ? 'border-signal/50 bg-signal/15 text-signal'
                        : 'border-line text-faint hover:border-faint'
                    }`}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        <div className="border-t border-line-soft pt-3 text-center font-mono text-sm text-muted">
          {octal} · {permView(bits)}
        </div>
      </div>
    </Modal>
  )
}

function permView(mode: number): string {
  const rwx = (n: number): string => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`
  return rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7)
}

// ---- main ----

export function FileManager({
  connectionId,
  password,
  initialPath,
  active,
  onOpenFile,
  onCwdChange
}: Props) {
  const [status, setStatus] = useState<Status>('connecting')
  const [openError, setOpenError] = useState<string | null>(null)
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showHidden, setShowHidden] = useState(true)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [history, setHistory] = useState<string[]>([])
  const [transfers, setTransfers] = useState<TransferProgress[]>([])
  const [dragging, setDragging] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null) // address bar input

  // dialog state
  const [prompt, setPrompt] = useState<
    | { kind: 'mkdir' }
    | { kind: 'rename'; entry: SftpEntry }
    | null
  >(null)
  const [chmod, setChmod] = useState<SftpEntry | null>(null)
  const [confirm, setConfirm] = useState<SftpEntry[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpEntry | null } | null>(null)

  const list = useCallback(
    async (path: string) => {
      setLoading(true)
      setListError(null)
      try {
        const res: SftpList = await window.api.sftpList({ connectionId, path })
        setCwd(res.path)
        setEntries(res.entries)
        setSelected(new Set())
        onCwdChange(res.path)
      } catch (e) {
        setListError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectionId]
  )

  // Open the SFTP channel once, then list the home directory.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await window.api.sftpOpen({ connectionId, password })
        if (cancelled) return
        setStatus('ready')
        await list(initialPath ? expandTilde(initialPath) : '.')
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setOpenError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      window.api.sftpClose(connectionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  // Live transfer progress.
  useEffect(() => {
    const off = window.api.onSftpProgress((p) => {
      setTransfers((prev) => {
        const next = prev.filter((t) => t.transferId !== p.transferId)
        next.push(p)
        return next
      })
      if (p.done && !p.error && p.kind === 'upload') void list(cwd)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  const navigate = useCallback(
    (path: string) => {
      setHistory((h) => (cwd ? [...h, cwd] : h))
      void list(path)
    },
    [cwd, list]
  )

  const goUp = (): void => {
    if (!cwd || cwd === '/') return
    const parent = cwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
    navigate(parent)
  }
  const goBack = (): void => {
    setHistory((h) => {
      if (h.length === 0) return h
      const prev = h[h.length - 1]
      void list(prev)
      return h.slice(0, -1)
    })
  }
  const goHome = (): void => navigate('.')

  const openEntry = (e: SftpEntry): void => {
    if (isDirLike(e)) navigate(e.path)
    else onOpenFile(e.path, e.name) // opens in its own editor tab
  }

  const rowClick = (e: React.MouseEvent, entry: SftpEntry): void => {
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s)
        next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path)
        return next
      })
    } else {
      setSelected(new Set([entry.path]))
    }
  }

  const visible = useMemo(() => {
    const filtered = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))
    const dirFirst = (e: SftpEntry): number => (isDirLike(e) ? 0 : 1)
    return [...filtered].sort((a, b) => {
      const d = dirFirst(a) - dirFirst(b)
      if (d !== 0) return d
      let cmp = 0
      if (sort.key === 'name') cmp = a.name.localeCompare(b.name)
      else if (sort.key === 'size') cmp = a.size - b.size
      else cmp = a.mtime - b.mtime
      return cmp * sort.dir
    })
  }, [entries, showHidden, sort])

  const selectedEntries = useMemo(
    () => visible.filter((e) => selected.has(e.path)),
    [visible, selected]
  )

  // ---- actions ----
  const doMkdir = async (name: string): Promise<void> => {
    setPrompt(null)
    const path = cwd.endsWith('/') ? cwd + name : `${cwd}/${name}`
    try {
      await window.api.sftpMkdir({ connectionId, path })
      await list(cwd)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }
  const doRename = async (entry: SftpEntry, name: string): Promise<void> => {
    setPrompt(null)
    const dir = entry.path.split('/').slice(0, -1).join('/') || '/'
    const to = dir.endsWith('/') ? dir + name : `${dir}/${name}`
    try {
      await window.api.sftpRename({ connectionId, from: entry.path, to })
      await list(cwd)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }
  const doDelete = async (items: SftpEntry[]): Promise<void> => {
    setConfirm(null)
    try {
      for (const it of items) {
        await window.api.sftpDelete({ connectionId, path: it.path, isDir: it.type === 'directory' })
      }
      await list(cwd)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }
  const doChmod = async (entry: SftpEntry, mode: number): Promise<void> => {
    setChmod(null)
    try {
      await window.api.sftpChmod({ connectionId, path: entry.path, mode })
      await list(cwd)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }
  const doDownload = async (items: SftpEntry[]): Promise<void> => {
    for (const it of items.filter((e) => e.type !== 'directory')) {
      await window.api.sftpDownload({
        connectionId,
        remotePath: it.path,
        name: it.name,
        transferId: crypto.randomUUID()
      })
    }
  }
  const doUploadPick = async (): Promise<void> => {
    await window.api.sftpUploadPick({ connectionId, remoteDir: cwd, transferId: crypto.randomUUID() })
  }

  // ---- drag & drop ----
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.pathForFile(f))
      .filter((p): p is string => !!p)
    if (paths.length) {
      void window.api.sftpUploadPaths({ connectionId, remoteDir: cwd, paths, transferId: crypto.randomUUID() })
    }
  }

  // close context menu on any outside interaction
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const activeTransfers = transfers.filter((t) => !t.done)
  const crumbs = useMemo(() => {
    const parts = cwd.split('/').filter(Boolean)
    const acc: { label: string; path: string }[] = [{ label: '/', path: '/' }]
    let cur = ''
    for (const p of parts) {
      cur += `/${p}`
      acc.push({ label: p, path: cur })
    }
    return acc
  }, [cwd])

  if (status === 'connecting') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        <span className="animate-glow mr-2 text-signal">⟳</span> Opening SFTP channel…
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <div className="text-sm text-danger">Could not open SFTP.</div>
        <div className="max-w-md font-mono text-xs text-faint">{openError}</div>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full flex-col bg-ink"
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragging) setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      {/* toolbar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-surface/60 px-3 py-2">
        <ToolBtn label="Back" disabled={history.length === 0} onClick={goBack}>
          ←
        </ToolBtn>
        <ToolBtn label="Up" disabled={cwd === '/' || !cwd} onClick={goUp}>
          ↑
        </ToolBtn>
        <ToolBtn label="Home" onClick={goHome}>
          ⌂
        </ToolBtn>
        <ToolBtn label="Refresh" onClick={() => void list(cwd)}>
          <span className={loading ? 'animate-glow' : ''}>⟳</span>
        </ToolBtn>

        {/* address bar — breadcrumb, or an editable path input */}
        {editingPath !== null ? (
          <input
            autoFocus
            value={editingPath}
            onChange={(e) => setEditingPath(e.target.value)}
            onBlur={() => setEditingPath(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                navigate(expandTilde(editingPath))
                setEditingPath(null)
              } else if (e.key === 'Escape') {
                setEditingPath(null)
              }
            }}
            placeholder="/var/www  ·  ~/  ·  Enter to go"
            className="mx-2 min-w-0 flex-1 rounded-lg border border-signal/60 bg-ink/60 px-2.5 py-1 font-mono text-[12px] text-fg outline-none placeholder:text-faint"
          />
        ) : (
          <div
            onDoubleClick={() => setEditingPath(cwd)}
            title="Double-click to type a path"
            className="mx-2 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-ink/60 px-2 py-1 font-mono text-[12px]"
          >
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex shrink-0 items-center">
                {i > 1 && <span className="px-0.5 text-faint">/</span>}
                <button
                  onClick={() => navigate(c.path)}
                  className={`rounded px-1 py-0.5 transition-colors hover:bg-elevated hover:text-fg ${
                    i === crumbs.length - 1 ? 'text-signal' : 'text-muted'
                  }`}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>
        )}
        <ToolBtn label="Type a path" onClick={() => setEditingPath((v) => (v === null ? cwd : null))}>
          ✎
        </ToolBtn>

        <ToolBtn label="New folder" onClick={() => setPrompt({ kind: 'mkdir' })}>
          ＋
        </ToolBtn>
        <ToolBtn label="Upload" onClick={() => void doUploadPick()}>
          ⤓
        </ToolBtn>
        <button
          onClick={() => setShowHidden((v) => !v)}
          title="Toggle hidden files"
          className={`rounded-md border px-2 py-1 text-xs transition-colors ${
            showHidden ? 'border-signal/50 bg-signal/15 text-signal' : 'border-line text-muted hover:border-faint'
          }`}
        >
          .hidden
        </button>
      </div>

      {/* listing */}
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto">
        {listError && (
          <div className="m-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {listError}
          </div>
        )}

        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
            <tr className="border-b border-line text-left">
              <Th onClick={() => setSort((s) => ({ key: 'name', dir: s.key === 'name' ? (s.dir * -1 as 1 | -1) : 1 }))} sort={sort} col="name" className="pl-4">
                Name
              </Th>
              <Th onClick={() => setSort((s) => ({ key: 'size', dir: s.key === 'size' ? (s.dir * -1 as 1 | -1) : 1 }))} sort={sort} col="size" className="w-28 text-right">
                Size
              </Th>
              <Th onClick={() => setSort((s) => ({ key: 'mtime', dir: s.key === 'mtime' ? (s.dir * -1 as 1 | -1) : 1 }))} sort={sort} col="mtime" className="w-40">
                Modified
              </Th>
              <th className="w-28 px-3 py-2 font-mono text-[11px] font-normal uppercase tracking-wider text-faint">
                Perms
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => {
              const sel = selected.has(e.path)
              return (
                <tr
                  key={e.path}
                  onClick={(ev) => rowClick(ev, e)}
                  onDoubleClick={() => void openEntry(e)}
                  onContextMenu={(ev) => {
                    ev.preventDefault()
                    if (!sel) setSelected(new Set([e.path]))
                    setMenu({ x: ev.clientX, y: ev.clientY, entry: e })
                  }}
                  className={`cursor-pointer border-b border-line-soft/60 transition-colors ${
                    sel ? 'bg-signal/12' : 'hover:bg-elevated/40'
                  }`}
                >
                  <td className="flex items-center gap-2.5 py-2 pl-4 pr-3">
                    <span className="w-5 shrink-0 text-center text-xs">
                      <EntryIcon entry={e} />
                    </span>
                    <span className={`truncate ${isDirLike(e) ? 'text-fg' : 'text-fg/80'}`}>{e.name}</span>
                    {e.isSymlink && e.target && (
                      <span className="font-mono text-[10px] text-faint">→ {e.target}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-muted">
                    {e.type === 'directory' ? '—' : fmtBytes(e.size)}
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] text-muted">{fmtTime(e.mtime)}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-faint">{e.permissions}</td>
                </tr>
              )
            })}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={4} className="py-10 text-center text-sm text-faint">
                  {entries.length === 0 ? 'This folder is empty.' : 'No visible files (hidden are filtered).'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>

        {/* navigation loading overlay */}
        {loading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-ink/55 backdrop-blur-[1px]">
            <div className="flex items-center gap-2.5 rounded-lg border border-line bg-panel/90 px-4 py-2.5 text-sm text-muted shadow-lg">
              <span className="animate-glow text-signal">⟳</span>
              Loading…
            </div>
          </div>
        )}
      </div>

      {/* selection action bar (bottom — keeps the list from shifting) */}
      {selectedEntries.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-elevated/40 px-3 py-2 text-xs">
          <span className="text-muted">{selectedEntries.length} selected</span>
          <div className="flex-1" />
          <Button onClick={() => void doDownload(selectedEntries)}>Download</Button>
          {selectedEntries.length === 1 && (
            <>
              <Button onClick={() => setPrompt({ kind: 'rename', entry: selectedEntries[0] })}>Rename</Button>
              <Button onClick={() => setChmod(selectedEntries[0])}>Permissions</Button>
            </>
          )}
          <Button variant="danger" onClick={() => setConfirm(selectedEntries)}>
            Delete
          </Button>
        </div>
      )}

      {/* status / transfers */}
      <div className="flex shrink-0 items-center gap-3 border-t border-line bg-surface/60 px-3 py-1.5 text-[11px] text-faint">
        <span className="font-mono">{visible.length} items</span>
        <div className="flex-1" />
        {transfers.length > 0 && (
          <button onClick={() => setTransfers([])} className="text-muted hover:text-fg">
            clear transfers
          </button>
        )}
      </div>

      {activeTransfers.length > 0 && (
        <div className="absolute bottom-9 right-4 z-20 w-72 space-y-2">
          {activeTransfers.map((t) => {
            const pct = t.total > 0 ? Math.round((t.transferred / t.total) * 100) : 0
            return (
              <div key={t.transferId} className="panel p-3 shadow-lg">
                <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-fg/85">
                    {t.kind === 'upload' ? '⤒' : '⤓'} {t.name}
                  </span>
                  <span className="shrink-0 font-mono text-faint">{pct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
                  <div
                    className="h-full rounded-full bg-signal transition-[width] duration-150"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* drag overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 m-2 flex items-center justify-center rounded-xl border-2 border-dashed border-signal/60 bg-signal/10 backdrop-blur-sm">
          <div className="text-center">
            <div className="text-2xl text-signal">⤓</div>
            <div className="mt-1 text-sm text-signal">Drop files to upload to {cwd}</div>
          </div>
        </div>
      )}

      {/* context menu */}
      {menu && (
        <div
          className="panel fixed z-40 min-w-44 overflow-hidden py-1 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.8)]"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.entry &&
            (isDirLike(menu.entry) ? (
              <MenuItem onClick={() => menu.entry && navigate(menu.entry.path)}>Open</MenuItem>
            ) : (
              <>
                <MenuItem onClick={() => menu.entry && void openEntry(menu.entry)}>Edit / view</MenuItem>
                <MenuItem onClick={() => menu.entry && void doDownload([menu.entry])}>Download</MenuItem>
              </>
            ))}
          {menu.entry && <MenuItem onClick={() => setPrompt({ kind: 'rename', entry: menu.entry! })}>Rename</MenuItem>}
          {menu.entry && <MenuItem onClick={() => setChmod(menu.entry)}>Permissions</MenuItem>}
          {menu.entry && (
            <MenuItem danger onClick={() => setConfirm(selectedEntries.length > 1 ? selectedEntries : [menu.entry!])}>
              Delete{selectedEntries.length > 1 ? ` (${selectedEntries.length})` : ''}
            </MenuItem>
          )}
          <div className="my-1 border-t border-line-soft" />
          <MenuItem onClick={() => setPrompt({ kind: 'mkdir' })}>New folder</MenuItem>
          <MenuItem onClick={() => void doUploadPick()}>Upload here</MenuItem>
          <MenuItem onClick={() => void list(cwd)}>Refresh</MenuItem>
        </div>
      )}

      {/* dialogs */}
      {prompt?.kind === 'mkdir' && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          initial=""
          confirmLabel="Create"
          onCancel={() => setPrompt(null)}
          onConfirm={(v) => void doMkdir(v)}
        />
      )}
      {prompt?.kind === 'rename' && (
        <PromptDialog
          title="Rename"
          label="New name"
          initial={prompt.entry.name}
          confirmLabel="Rename"
          onCancel={() => setPrompt(null)}
          onConfirm={(v) => void doRename(prompt.entry, v)}
        />
      )}
      {chmod && <ChmodDialog entry={chmod} onCancel={() => setChmod(null)} onConfirm={(m) => void doChmod(chmod, m)} />}
      {confirm && (
        <Modal
          title="Confirm delete"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => void doDelete(confirm)}>
                Delete {confirm.length > 1 ? `${confirm.length} items` : ''}
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg/80">
            Permanently delete{' '}
            {confirm.length === 1 ? (
              <span className="font-mono text-fg">{confirm[0].name}</span>
            ) : (
              `${confirm.length} items`
            )}
            ? Directories are removed with all their contents.
          </p>
        </Modal>
      )}
    </div>
  )
}

function ToolBtn({
  children,
  label,
  disabled,
  onClick
}: {
  children: React.ReactNode
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-md border border-line text-muted transition-colors hover:border-signal/40 hover:text-signal disabled:opacity-30"
    >
      {children}
    </button>
  )
}

function Th({
  children,
  onClick,
  sort,
  col,
  className = ''
}: {
  children: React.ReactNode
  onClick: () => void
  sort: { key: SortKey; dir: 1 | -1 }
  col: SortKey
  className?: string
}) {
  return (
    <th
      onClick={onClick}
      className={`cursor-pointer px-3 py-2 font-mono text-[11px] font-normal uppercase tracking-wider text-faint transition-colors hover:text-muted ${className}`}
    >
      {children}
      {sort.key === col && <span className="ml-1 text-signal">{sort.dir === 1 ? '▲' : '▼'}</span>}
    </th>
  )
}

function MenuItem({
  children,
  onClick,
  danger
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3.5 py-1.5 text-left text-sm transition-colors hover:bg-elevated ${
        danger ? 'text-danger hover:bg-danger/15' : 'text-fg/85'
      }`}
    >
      {children}
    </button>
  )
}
