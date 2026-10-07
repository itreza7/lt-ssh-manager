import { useEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}

export function Modal({ title, onClose, children, footer, width = 440 }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="panel animate-rise overflow-hidden shadow-[0_24px_80px_-20px_rgba(0,0,0,0.8)]"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="eyebrow !text-muted">{title}</h2>
          <button
            onClick={onClose}
            className="-mr-1 rounded-md px-2 text-lg leading-none text-faint transition-colors hover:text-fg"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line bg-black/20 px-5 py-3.5">{footer}</div>
        )}
      </div>
    </div>
  )
}

export function Button({
  children,
  variant = 'default',
  ...props
}: { variant?: 'default' | 'primary' | 'danger' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    default: 'border border-line bg-elevated/60 text-fg/85 hover:border-faint hover:bg-elevated',
    primary:
      'bg-accent text-ink font-semibold hover:shadow-[0_0_22px_-4px_var(--color-accent)] hover:brightness-110',
    danger: 'border border-danger/40 bg-danger/15 text-danger hover:bg-danger/25'
  }[variant]
  return (
    <button
      {...props}
      className={`rounded-lg px-3.5 py-1.5 text-sm transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${props.className ?? ''}`}
    >
      {children}
    </button>
  )
}

/** Asks for one line of text: a name, a path. Enter or the button confirms a non-blank value. */
export function PromptDialog({
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
        className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 font-mono text-sm text-fg outline-none focus:border-accent/60"
      />
    </Modal>
  )
}

/** One row of a right-click menu. */
export function MenuItem({
  children,
  onClick,
  danger
}: {
  children: ReactNode
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
