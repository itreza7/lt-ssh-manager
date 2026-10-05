import type { ChatSummary } from '../../../../shared/chatProtocol'

/** Last path segment: the folder name that identifies the work. */
export const leaf = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** What a chat is called in lists: the relay's label, else the folder. */
export const chatLabel = (c: ChatSummary): string => c.state?.title || c.config.title || leaf(c.config.cwd)

/** Tab title for a chat. */
export const chatTabTitle = (c: ChatSummary): string => `Chat · ${chatLabel(c).slice(0, 32)}`

/** The state a list row shows: the relay's own, or stopped when its tmux session is gone. */
export function chatRowStatus(c: ChatSummary): 'idle' | 'running' | 'waiting' | 'stopped' {
  if (!c.alive || !c.state || c.state.status === 'exited') return 'stopped'
  return c.state.status === 'running' || c.state.status === 'waiting' ? c.state.status : 'idle'
}

export const CHAT_DOT: Record<ReturnType<typeof chatRowStatus>, string> = {
  idle: 'bg-faint',
  running: 'bg-signal dot-glow animate-pulse',
  waiting: 'bg-amber dot-glow',
  stopped: 'bg-danger/50'
}
