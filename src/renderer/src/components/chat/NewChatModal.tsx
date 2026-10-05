import { useState } from 'react'
import type { ChatMode } from '../../../../shared/chatProtocol'
import { Button, Modal } from '../Modal'
import { Select } from '../Select'

export interface NewChatChoice {
  cwd: string
  model?: string
  mode: ChatMode
}

interface Props {
  host: string
  /** Pre-filled directory; '~' when nothing better is known. */
  defaultDir: string
  /** Starts the chat; rejects with a message to show in the form. */
  onStart: (choice: NewChatChoice) => Promise<void>
  onClose: () => void
}

const MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'claude-haiku-4-5', label: 'Haiku' }
]

const MODES: { value: ChatMode; label: string }[] = [
  { value: 'bypass', label: "Don't ask" },
  { value: 'default', label: 'Ask first' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'plan', label: 'Plan' }
]

const label = 'eyebrow mb-1.5 block'

export function NewChatModal({ host, defaultDir, onStart, onClose }: Props) {
  const [dir, setDir] = useState(defaultDir)
  const [model, setModel] = useState('default')
  const [mode, setMode] = useState<ChatMode>('bypass')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (): Promise<void> => {
    if (!dir.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onStart({ cwd: dir.trim(), model: model === 'default' ? undefined : model, mode })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`New chat · ${host}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !dir.trim()} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start ▸'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className={label}>Directory</span>
          <input
            autoFocus
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void start()}
            spellCheck={false}
            className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 font-mono text-xs text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
          />
        </label>
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <span className={label}>Model</span>
            <Select value={model} options={MODELS} onChange={setModel} width={176} />
          </div>
          <div className="min-w-0 flex-1">
            <span className={label}>Permissions</span>
            <Select value={mode} options={MODES} onChange={(m) => setMode(m as ChatMode)} width={176} />
          </div>
        </div>
        {error && (
          <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</p>
        )}
      </div>
    </Modal>
  )
}
