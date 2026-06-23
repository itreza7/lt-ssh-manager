import type { HostKeyPrompt } from '../../../shared/types'
import { Modal, Button } from './Modal'

interface Props {
  prompt: HostKeyPrompt
  onRespond: (accept: boolean) => void
}

export function HostKeyDialog({ prompt, onRespond }: Props) {
  return (
    <Modal
      title={prompt.changed ? '⚠ Host key CHANGED' : 'Unknown host key'}
      onClose={() => onRespond(false)}
      width={480}
      footer={
        <>
          <Button onClick={() => onRespond(false)}>Reject</Button>
          <Button variant={prompt.changed ? 'danger' : 'primary'} onClick={() => onRespond(true)}>
            {prompt.changed ? 'Trust anyway' : 'Trust & continue'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {prompt.changed && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-danger">
            The host key for this server has <b>changed</b> since you last connected. This could be a
            man-in-the-middle attack — only continue if you know why it changed.
          </p>
        )}
        <p className="text-fg/70">
          The authenticity of{' '}
          <b className="font-mono text-fg">
            {prompt.host}:{prompt.port}
          </b>{' '}
          can't be established.
        </p>
        <div className="rounded-lg border border-line bg-ink/60 p-3 font-mono text-xs">
          <div className="eyebrow mb-1">{prompt.keyType}</div>
          <div className="break-all text-signal">{prompt.fingerprint}</div>
        </div>
        <p className="text-faint">Trusting saves this key; future connections verify against it.</p>
      </div>
    </Modal>
  )
}
