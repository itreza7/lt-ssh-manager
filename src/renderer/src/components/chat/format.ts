import type { ChatMode, ChatSession } from '../../../../shared/chatProtocol'

/** Last path segment: the folder name that identifies the work. */
export const leaf = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** What a session is called in lists: Claude Code's own title, else the folder. */
export const chatLabel = (c: Pick<ChatSession, 'name' | 'cwd'>): string => c.name || leaf(c.cwd)

/** Tab title for a chat. */
export const chatTabTitle = (c: Pick<ChatSession, 'name' | 'cwd'>): string => `Chat · ${chatLabel(c).slice(0, 32)}`

/** What a chat is doing, as the header and lists show it. `shell` and unknown values read as idle. */
export type ChatStatus = 'idle' | 'busy' | 'waiting' | 'ended'

export const chatStatusOf = (c: Pick<ChatSession, 'status'> | null): ChatStatus =>
  c === null ? 'ended' : c.status === 'busy' || c.status === 'waiting' ? c.status : 'idle'

export function statusLabel(status: ChatStatus, waitingFor?: string): string {
  switch (status) {
    case 'busy':
      return 'Working…'
    case 'waiting':
      return waitingFor ? `Waiting: ${waitingFor}` : 'Waiting'
    case 'ended':
      return 'Ended'
    default:
      return 'Idle'
  }
}

export const CHAT_DOT: Record<ChatStatus, string> = {
  idle: 'bg-faint',
  busy: 'bg-signal dot-glow animate-pulse',
  waiting: 'bg-amber dot-glow',
  ended: 'bg-danger/50'
}

export const MODE_LABEL: Record<ChatMode, string> = {
  bypassPermissions: "Don't ask",
  default: 'Ask first',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan'
}
