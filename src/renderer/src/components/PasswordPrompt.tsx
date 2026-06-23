import { useState } from 'react'
import { Modal, Button } from './Modal'

interface Props {
  title: string
  label: string
  onSubmit: (value: string | null) => void
}

export function PasswordPrompt({ title, label, onSubmit }: Props) {
  const [value, setValue] = useState('')
  return (
    <Modal
      title={title}
      onClose={() => onSubmit(null)}
      width={380}
      footer={
        <>
          <Button onClick={() => onSubmit(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => onSubmit(value)}>
            Connect
          </Button>
        </>
      }
    >
      <div className="eyebrow mb-1.5 block">{label}</div>
      <input
        autoFocus
        type="password"
        className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-signal/60 focus:ring-2 focus:ring-signal/15"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit(value)}
      />
    </Modal>
  )
}
