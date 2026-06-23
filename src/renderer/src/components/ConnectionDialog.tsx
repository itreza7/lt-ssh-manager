import { useState } from 'react'
import type { AuthMethod, Connection, ConnectionDraft } from '../../../shared/types'
import { Modal, Button } from './Modal'

interface Props {
  initial?: Connection | null
  secretsAvailable: boolean
  onCancel: () => void
  onSave: (draft: ConnectionDraft) => void
}

const field =
  'w-full rounded-lg border border-line bg-ink/60 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-signal/60 focus:ring-2 focus:ring-signal/15'
const label = 'eyebrow mb-1.5 block'

export function ConnectionDialog({ initial, secretsAvailable, onCancel, onSave }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(initial?.port ?? 22)
  const [username, setUsername] = useState(initial?.username ?? '')
  const [authMethod, setAuthMethod] = useState<AuthMethod>(initial?.authMethod ?? 'key')
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? '')
  const [password, setPassword] = useState('')
  const [sftpPath, setSftpPath] = useState(initial?.sftpPath ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [tmux, setTmux] = useState(initial?.tmux ?? false)
  const [tmuxSession, setTmuxSession] = useState(initial?.tmuxSession ?? '')
  const [tmuxDetachOthers, setTmuxDetachOthers] = useState(initial?.tmuxDetachOthers ?? false)
  const [tmuxControl, setTmuxControl] = useState(initial?.tmuxControl ?? false)

  const save = (): void => {
    if (!host.trim()) return
    onSave({
      id: initial?.id,
      name,
      host,
      port,
      username,
      authMethod,
      keyPath: authMethod === 'key' ? keyPath : undefined,
      sftpPath: sftpPath.trim() || undefined,
      notes,
      tmux,
      tmuxSession: tmux ? tmuxSession.trim() || undefined : undefined,
      tmuxDetachOthers: tmux ? tmuxDetachOthers : undefined,
      tmuxControl: tmux ? tmuxControl : undefined,
      password: authMethod === 'password' && password ? password : undefined
    })
  }

  return (
    <Modal
      title={initial ? 'Edit connection' : 'New connection'}
      onClose={onCancel}
      width={460}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3">
        <div>
          <div className={label}>Name</div>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Server" />
        </div>
        <div className="grid grid-cols-[1fr_90px] gap-3">
          <div>
            <div className={label}>Host</div>
            <input className={field} value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" />
          </div>
          <div>
            <div className={label}>Port</div>
            <input
              className={field}
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 22)}
            />
          </div>
        </div>
        <div>
          <div className={label}>Username</div>
          <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
        </div>
        <div>
          <div className={label}>Auth method</div>
          <select className={field} value={authMethod} onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}>
            <option value="key">SSH key</option>
            <option value="password">Password</option>
            <option value="agent">SSH agent</option>
          </select>
        </div>
        {authMethod === 'key' && (
          <div>
            <div className={label}>Private key</div>
            <div className="flex gap-2">
              <input className={field} value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="C:\Users\you\.ssh\id_ed25519" />
              <Button onClick={async () => {
                const p = await window.api.pickKeyFile()
                if (p) setKeyPath(p)
              }}>
                Browse…
              </Button>
            </div>
          </div>
        )}
        {authMethod === 'password' && (
          <div>
            <div className={label}>Password {secretsAvailable ? '(stored encrypted)' : '(keyring unavailable — per session)'}</div>
            <input
              className={field}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={initial ? '•••••••• (leave blank to keep)' : ''}
            />
          </div>
        )}
        <div>
          <div className={label}>Default SFTP folder</div>
          <input
            className={`${field} font-mono`}
            value={sftpPath}
            onChange={(e) => setSftpPath(e.target.value)}
            placeholder="/var/www  ·  blank = home"
          />
        </div>
        <div className="rounded-lg border border-line bg-ink/40 px-3 py-2.5">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="block text-sm text-fg">Open sessions in tmux</span>
              <span className="block text-[11px] text-faint">
                Wrap terminals in a persistent session — drops reattach instead of dying.
              </span>
            </span>
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-signal"
              checked={tmux}
              onChange={(e) => setTmux(e.target.checked)}
            />
          </label>
          {tmux && (
            <div className="mt-3 grid gap-3 border-t border-line-soft pt-3">
              <div>
                <div className={label}>Session name</div>
                <input
                  className={`${field} font-mono`}
                  value={tmuxSession}
                  onChange={(e) => setTmuxSession(e.target.value)}
                  placeholder="blank = connection name"
                />
              </div>
              <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-fg">
                <span>
                  Detach other clients on attach
                  <span className="block text-[11px] text-faint">
                    Grabs full window size instead of being clamped to a smaller peer.
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-signal"
                  checked={tmuxDetachOthers}
                  onChange={(e) => setTmuxDetachOthers(e.target.checked)}
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-fg">
                <span>
                  Control mode (tmux -CC)
                  <span className="block text-[11px] text-faint">
                    Render each tmux pane as its own terminal — native scrollback + copy, no
                    mouse mode. Splits/windows work via the usual tmux keys.
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-signal"
                  checked={tmuxControl}
                  onChange={(e) => setTmuxControl(e.target.checked)}
                />
              </label>
            </div>
          )}
        </div>
        <div>
          <div className={label}>Notes</div>
          <textarea className={`${field} h-16 resize-none`} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
    </Modal>
  )
}
