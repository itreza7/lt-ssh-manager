/** The Chat / Terminal switch of a Claude session: the two views of the same tmux pane. */
export function ModeSwitch({
  mode,
  onChat,
  onTerminal,
  className = ''
}: {
  mode: 'chat' | 'terminal'
  onChat?: () => void
  onTerminal?: () => void
  className?: string
}) {
  const seg = (on: boolean): string =>
    `rounded-[6px] px-2 py-0.5 transition-colors ${on ? 'bg-sel text-title' : 'text-muted hover:text-title'}`
  return (
    <div className={`no-drag flex shrink-0 items-center gap-0.5 rounded-lg bg-elevated p-0.5 text-[12.5px] leading-4 ${className}`}>
      <button className={seg(mode === 'chat')} onClick={mode === 'chat' ? undefined : onChat} title="Show as chat">
        Chat
      </button>
      <button className={seg(mode === 'terminal')} onClick={mode === 'terminal' ? undefined : onTerminal} title="Show the tmux terminal">
        Terminal
      </button>
    </div>
  )
}
