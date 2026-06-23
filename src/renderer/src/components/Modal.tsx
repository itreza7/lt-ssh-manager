import type { ReactNode } from 'react'

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
      'bg-signal text-ink font-semibold hover:shadow-[0_0_22px_-4px_var(--color-signal)] hover:brightness-110',
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
