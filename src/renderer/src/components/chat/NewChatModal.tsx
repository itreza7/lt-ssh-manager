import { useState } from 'react'
import { Button, Modal } from '../Modal'

interface Props {
  host: string
  /** Pre-filled directory; '~' when nothing better is known. */
  defaultDir: string
  /** Starts Claude in that directory; rejects with a message to show in the form. */
  onStart: (cwd: string) => Promise<void>
  onClose: () => void
}

export function NewChatModal({ host, defaultDir, onStart, onClose }: Props) {
  const [dir, setDir] = useState(defaultDir)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (): Promise<void> => {
    if (!dir.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onStart(dir.trim())
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
          <span className="eyebrow mb-1.5 block">Directory</span>
          <input
            autoFocus
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void start()}
            spellCheck={false}
            className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 font-mono text-xs text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
          />
        </label>
        {error && (
          <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</p>
        )}
      </div>
    </Modal>
  )
}
