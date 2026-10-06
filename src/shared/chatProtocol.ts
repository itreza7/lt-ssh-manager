// The chat tab is a second view of a real Claude Code TUI running in tmux on a
// remote host. Nothing runs Claude on the chat's behalf: the chat reads what
// Claude Code itself writes, and types into its tmux pane.
//
//   ~/.claude/sessions/<pid>.json                  one per live Claude (status file)
//   ~/.claude/projects/<slug>/<sessionId>.jsonl    the session's transcript
//
// The terminal tab and the chat tab show the same session; either can be used.
// How keys are sent to the TUI is in tuiKeys.ts; how transcript records become
// ChatEvents is in transcriptEvents.ts.

import type { TuiPrompt } from './tuiKeys'

/** Permission mode as Claude Code records it (`permission-mode` records). */
export type ChatMode = 'bypassPermissions' | 'default' | 'acceptEdits' | 'plan'

/** A live Claude, read from its status file and joined with `tmux list-panes -a`. */
export interface ChatSession {
  sessionId: string
  pid: number
  cwd: string
  /** The status file's `name` (the session title Claude Code shows), if any. */
  name?: string
  /** Claude Code's own status. `waiting` can also be set by a hook, so it is a label only. */
  status: 'idle' | 'busy' | 'waiting' | 'shell' | string
  waitingFor?: string
  /** `cli` for the TUI; `sdk-cli` and others cannot be driven. */
  entrypoint?: string
  version?: string
  /** tmux target, present when the Claude runs in a tmux pane that still exists. */
  tmux?: { session: string; window: string; pane: string }
  /** True when the chat can type into it: an interactive TUI in a live tmux pane. */
  drivable: boolean
  /** Status file's mtime (ms), for sorting. */
  updatedAt: number
}

/** A content block as the chat renders it (the transcript's, minus signatures). */
export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

export interface ChatImage {
  /** e.g. image/png, image/jpeg, image/gif, image/webp */
  mediaType: string
  /** base64, no data: prefix */
  data: string
}

/** What the reducer (renderer/lib/chatState.ts) consumes. Built by transcriptEvents.ts. */
export type ChatEvent =
  /** A user message (typed text, not tool results). */
  | { t: 'user'; id: string; text: string; images?: ChatImage[] }
  /** All blocks of one assistant message so far; a later event for the same msgId replaces it. */
  | { t: 'assistant'; msgId: string; blocks: ChatBlock[]; parentToolUseId: string | null }
  /** Output of a tool call. `content` is capped at 20 000 chars. */
  | { t: 'tool_result'; toolUseId: string; content: string; isError: boolean; parentToolUseId: string | null; truncated?: boolean }
  /** From the status file poll. `ended` = no live Claude for this session. */
  | { t: 'status'; status: 'idle' | 'busy' | 'waiting' | 'ended'; waitingFor?: string }
  | { t: 'mode'; mode: ChatMode }
  | { t: 'model'; model: string }
  /** The git branch the session works on (`gitBranch` of a user/assistant record), when it changes. */
  | { t: 'branch'; branch: string }
  /**
   * An AskUserQuestion (`question`) or ExitPlanMode (`plan`) tool_use that has no
   * tool_result yet. reqId is the tool_use id. A permission prompt has no
   * transcript record; it appears as status `waiting` + waitingFor.
   */
  | { t: 'request'; reqId: string; kind: 'question' | 'plan'; toolName: string; input: unknown }
  /** The request's tool_result arrived (answered, here or in the terminal). */
  | { t: 'request_done'; reqId: string }
  /** End of a turn (`system/turn_duration`). */
  | { t: 'result'; durationMs?: number }
  /** Context was compacted. */
  | { t: 'compact'; id: string; trigger: 'manual' | 'auto'; preTokens?: number }
  /** Usage of the last assistant message, for the context meter. */
  | { t: 'usage'; inputTokens: number }
  /**
   * A Workflow, or an Agent/Task run in the background. Emitted on the tool_use
   * (`taskId` and `dir` not known yet) and again on its tool_result with them; the
   * reducer merges by `toolUseId`. `dir` is the workflow's transcript directory on
   * the host (for chat:journal). `phases` are the titles from the script's meta.
   */
  | { t: 'task'; taskId?: string; toolUseId: string; kind: 'workflow' | 'agent'; name: string; phases: string[]; dir?: string }
  /**
   * A task finished (a `<task-notification>` user record). Match by `toolUseId`, or
   * `taskId`. May arrive without its `task` when a load starts mid-file.
   */
  | { t: 'task_done'; toolUseId?: string; taskId?: string; status: string; summary?: string }
  /** Output of a local command such as /context (`local-command-stdout`), ANSI stripped. */
  | { t: 'note'; id: string; title: string; text: string }

// ---- IPC: renderer <-> main (window.api.chat*) ----

export interface ChatTarget {
  connectionId: string
  password?: string
}

/** A batch of whole transcript records from a live stream; `next` is the byte offset after them. */
export interface ChatStreamData {
  streamId: string
  records: unknown[]
  next: number
}

/** Records from before a stream's start, read on demand; `start` is where they begin (0 = the file's top). */
export interface ChatOlder {
  records: unknown[]
  start: number
}

export interface ChatStreamEnd {
  streamId: string
  /** Absent on a clean close (unstream). */
  error?: string
}

export type { TuiPrompt, TuiPromptOption } from './tuiKeys'

/**
 * The two lines under Claude Code's input box, read off the screen. `segments` are
 * the user's own statusLine, split at " · " and shown as they are (`model` is the
 * first one). `mode` and `modeExtras` come from the mode line below it ("1 shell"
 * and the like, without the key hints).
 */
export interface TuiFooter {
  segments: string[]
  model?: string
  mode?: ChatMode
  modeExtras: string[]
  /** "9% until auto-compact", shown above the input box when context runs low: the 9. */
  autoCompactLeft?: number
}

/** What chat:prompt answers with, from one screen capture. */
export interface ChatScreenInfo {
  prompt: TuiPrompt | null
  footer: TuiFooter | null
}

/** One agent of a running workflow, from its journal.jsonl (chat:journal). */
export interface WorkflowAgent {
  agentId: string
  label: string
  phase?: string
  state: 'running' | 'done'
  /** First 200 characters of its result, once done. */
  preview?: string
  agentType?: string
}

/** A skill or custom command the host offers (chat:commands). */
export interface ChatCommandInfo {
  name: string
  description: string
  source: 'skill' | 'command' | 'project-skill' | 'project-command'
}

/**
 * An answer typed into the TUI, read off the prompt card. `digit` and `label`
 * are the option as the card showed it; main refuses it if the screen differs.
 * `text` is for a free-text option. `tab` moves on (multi-select, next question).
 */
export type ChatAnswer = { kind: 'option'; digit: string; label: string; text?: string } | { kind: 'tab' }

/**
 * Result of anything that types into the pane. `draft` = the TUI input holds
 * unsent text, so nothing was typed; `screen` = the expected prompt was not on
 * screen (answered elsewhere, or a layout this build does not know).
 */
export type ChatKeysResult = { ok: true } | { ok: false; reason: 'draft' | 'screen' | 'no-pane' | 'error'; message?: string }
