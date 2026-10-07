import type { ChatMode, ChatSession } from '../../../../shared/chatProtocol'

/** Last path segment: the folder name that identifies the work. */
/** Window event: the live chat list changed (a /clear moved a session), so lists re-read it now. */
export const CHATS_CHANGED = 'ssh-manager:chats-changed'

export const leaf = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * What a session is called in lists: its folder, plus the worktree when it runs in
 * one (`<repo>/.claude/worktrees/<name>` → "repo · name"). Claude Code's own title
 * changes with the conversation; the folder says where the work is.
 */
export function chatLabel(c: Pick<ChatSession, 'cwd'>): string {
  const wt = /^(.*)\/\.claude\/worktrees\/([^/]+)/.exec(c.cwd)
  return wt ? `${leaf(wt[1])} · ${wt[2]}` : leaf(c.cwd)
}

/** Lists show chats by label, A to Z; two in the same folder by Claude's title. */
export const sortChats = <T extends Pick<ChatSession, 'cwd' | 'name'>>(list: T[]): T[] =>
  [...list].sort(
    (a, b) =>
      chatLabel(a).localeCompare(chatLabel(b), undefined, { numeric: true, sensitivity: 'base' }) ||
      (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true, sensitivity: 'base' })
  )

/** Tab title for a chat. */
export const chatTabTitle = (c: Pick<ChatSession, 'cwd'>): string => `Chat · ${chatLabel(c).slice(0, 32)}`

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
  plan: 'Plan',
  auto: 'Auto'
}
