// How the chat tab drives a real Claude Code TUI running in a tmux pane.
//
// The chat never talks to Claude directly: it types into the pane, exactly as a
// person at the terminal would. Every key sequence here was confirmed against
// Claude Code 2.1.291 in a throwaway tmux session. Each action has a screen
// marker that must be visible (tmux capture-pane) before its keys are sent —
// the status file's `waiting` is also set by hooks (e.g. an approval gate), so
// it is never enough on its own to press a key.
import type { ChatMode, TuiFooter } from './chatProtocol'

/** tmux key names, as `tmux send-keys` takes them. */
export const KEY = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  shiftTab: 'BTab',
  left: 'Left'
} as const

/**
 * Sending a message: `tmux load-buffer` the text, `paste-buffer -p` (bracketed,
 * so newlines don't submit), wait ~300 ms, then Enter. A long paste shows as
 * "[Pasted text #1 +3 lines]" and still submits whole.
 *
 * Only into an empty input. Clearing a draft is not safe: Ctrl+U clears one line,
 * and Ctrl+C on an empty input arms "Press Ctrl-C again to exit". The input line
 * is the one starting with PROMPT_CHAR between the two rules; it is empty when
 * nothing follows the prompt, or when what follows is dim (ESC[2m) — that is a
 * ghost suggestion, not text. Read it with `capture-pane -e -p`.
 */
export const PROMPT_CHAR = '❯'
export const SEND_SETTLE_MS = 300

/** True if the input line (from `capture-pane -e -p`) holds real, unsent text. */
export function inputHasDraft(screenWithEscapes: string): boolean {
  const lines = screenWithEscapes.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = lines[i].replace(/\x1b\[[0-9;]*m/g, '')
    const at = plain.indexOf(PROMPT_CHAR)
    if (at < 0 || plain.slice(0, at).trim() !== '') continue
    // The bottom-most prompt line is the input box; the ones above are sent
    // messages echoed in the history. The input pads with a no-break space.
    // Text after the prompt, escapes kept, so a dim (ghost) start can be seen.
    const raw = lines[i].slice(lines[i].indexOf(PROMPT_CHAR) + PROMPT_CHAR.length).replace(/^[ \u00a0]/, '')
    const visible = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\u00a0/g, ' ').trim()
    if (!visible) return false
    return !/^(\x1b\[[0-9;]*m)*\x1b\[2m/.test(raw.replace(/^\x1b\[(?:39|0)m/, ''))
  }
  return false
}

/**
 * The input box's rows (plain `capture-pane -p`), without the prompt and the two-space
 * indent; null if there is no input box. A long line wraps into several rows.
 */
export function inputRows(screen: string): string[] | null {
  const lines = screen.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(PROMPT_CHAR)) continue
    const rows = [lines[i].slice(PROMPT_CHAR.length)]
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('─'); j++) rows.push(lines[j])
    return rows.map((r) => r.replace(/\u00a0/g, ' ').replace(/^ {1,2}/, '').trimEnd())
  }
  return null
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
const PASTED_ROW = /^\[Pasted text #\d+ \+(\d+) lines\]$/

/**
 * Where `text` sits in queued messages pulled back into the input (`inputRows`): its first
 * and last row. A multi-line one may show as its "[Pasted text #1 +3 lines]" row. Null
 * unless it is there exactly once.
 */
export function queuedRows(rows: string[], text: string): { start: number; end: number } | null {
  const want = squash(text)
  const lineCount = text.trim().split('\n').length
  const hits: { start: number; end: number }[] = []
  for (let s = 0; s < rows.length; s++) {
    const m = PASTED_ROW.exec(rows[s].trim())
    if (m && lineCount > 1 && Number(m[1]) === lineCount - 1) hits.push({ start: s, end: s })
    let joined = ''
    for (let e = s; e < rows.length; e++) {
      joined = squash(`${joined} ${rows[e]}`)
      if (joined === want) hits.push({ start: s, end: e })
      if (joined.length >= want.length) break
    }
  }
  return hits.length === 1 ? hits[0] : null
}

/** The dim suggested prompt in an empty input line (from `capture-pane -e -p`), or null. */
export function inputSuggestion(screenWithEscapes: string): string | null {
  const lines = screenWithEscapes.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = lines[i].replace(/\x1b\[[0-9;]*m/g, '')
    const at = plain.indexOf(PROMPT_CHAR)
    if (at < 0 || plain.slice(0, at).trim() !== '') continue
    const raw = lines[i].slice(lines[i].indexOf(PROMPT_CHAR) + PROMPT_CHAR.length).replace(/^[ \u00a0]/, '')
    const visible = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\u00a0/g, ' ').trim()
    if (!visible || !/^(\x1b\[[0-9;]*m)*\x1b\[2m/.test(raw.replace(/^\x1b\[(?:39|0)m/, ''))) return null
    // The welcome screen's hint is not a suggestion to send.
    return /^Try "/.test(visible) ? null : visible
  }
  return null
}

/**
 * The background-task rows under the footer while one is selected (↓ from an empty
 * input): a hint line "Enter to view · x to stop" (or "x to clear" on a finished
 * one), then one row per task, the selected one starting with ❯:
 *
 *     ❯ ◯ alpha-probe                   ▱▱▱▱  0/2 · 44s · ↓ 61.9k tokens
 *       ◯ beta-probe-with-a-rather-lo…  ▱▱▱▱  0/2 · 44s · ↓ 61.9k tokens
 *
 * Null when no row is selected. Names longer than the column end in "…".
 */
export interface FooterTasks {
  /** The selected row is stopped or done already ("x to clear"). */
  selectedDone: boolean
  rows: { label: string; selected: boolean }[]
}
const TASK_HINT_RE = /Enter to view · x to (stop|clear)/
const TASK_ROW_RE = /^(❯| )[ \u00a0]\S[ \u00a0](.+?)(?:\s{2,}|$)/
export function footerTasks(screen: string): FooterTasks | null {
  const lines = screen.split('\n').map((l) => l.trimEnd())
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TASK_HINT_RE.test(lines[i])) {
      at = i
      break
    }
  }
  if (at < 0) return null
  const rows: FooterTasks['rows'] = []
  for (const l of lines.slice(at + 1)) {
    // A blank line can sit between the hint and the rows.
    if (!l.trim() && !rows.length) continue
    const m = TASK_ROW_RE.exec(l)
    if (!m) break
    rows.push({ label: m[2].trim(), selected: m[1] === '❯' })
  }
  if (!rows.some((r) => r.selected)) return null
  return { selectedDone: TASK_HINT_RE.exec(lines[at])![1] === 'clear', rows }
}

/** A footer task row's label is this task: the same name, or its start cut with "…". */
export function taskRowIs(label: string, name: string): boolean {
  const n = name.trim()
  return label.endsWith('…') ? n.startsWith(label.slice(0, -1).trimEnd()) && label.length > 1 : label === n
}

/** SGR escapes off a `capture-pane -e -p` screen: what plain `capture-pane -p` gives. */
export const stripSgr = (screen: string): string => screen.replace(/\x1b\[[0-9;]*m/g, '')

/**
 * AskUserQuestion. Options are numbered from 1; the option after the last one is
 * "Type something" (free text). Marker: MARK.question plus the question's text.
 *
 * - Single select: the option's digit selects and moves on.
 * - Multi select: digits toggle ([✔]); Tab moves to the next question.
 * - Free text: the "Type something" digit, then the text pasted *without* -p,
 *   then Enter.
 * - More than one question: after the last, a "Review your answers" screen;
 *   digit 1 submits. With a single question there is no review screen.
 */
export const MARK = {
  question: 'Enter to select ·',
  review: 'Review your answers',
  /** ExitPlanMode. Option 1 approves ("Yes, …"). */
  plan: 'Would you like to proceed?',
  /** The plan option whose digit, then text + Enter, keeps planning with feedback. */
  planFeedback: 'Tell Claude what to change',
  /** A tool permission prompt ("Do you want to create a.txt?"). Option 1 is "Yes". */
  permission: 'Do you want to',
  /** Claude's first start in a folder it was not told to trust. */
  trust: 'Yes, I trust this folder',
  /** `/model x` asks this when the conversation is cached; digit 1 confirms. */
  modelConfirm: 'Switch model?',
  /** The empty input while messages wait for the running turn; ↑ pulls them all back into it. */
  queued: 'Press up to edit queued messages'
} as const

/** Interrupt a running turn (only while the status file says busy). */
export const INTERRUPT = KEY.escape

/**
 * Permission mode: Shift+Tab cycles it, and the footer's last line names it. To
 * set a mode, press Shift+Tab until that line contains the mode's text (give up
 * after MODE_MAX_PRESSES). Which modes are in the cycle depends on how Claude
 * was started — "bypass" only when it was launched with that allowed (in 2.1.292:
 * manual → accept edits → plan → bypass → auto).
 */
export const MODE_FOOTER = {
  bypassPermissions: 'bypass permissions on',
  acceptEdits: 'accept edits on',
  plan: 'plan mode on',
  auto: 'auto mode on',
  default: 'manual mode on'
} as const
export type TuiMode = keyof typeof MODE_FOOTER
/** Per-line key hints in the mode line that are not state. */
const FOOTER_HINT_RE = /shift\+tab|for agents/i

/**
 * The footer under the input box on a plain `capture-pane -p` screen, or null when
 * there is no input box (a dialog is open) or nothing under it. The input box is the
 * bottom-most line starting with PROMPT_CHAR; the footer is the next two non-empty
 * lines after the rule that closes it. Line 1 is the user's own statusLine (absent if
 * they have none), line 2 the mode line. Shown as read: nothing assumes where a
 * statusLine segment sits, except that the first one is the model.
 */
export function parseFooter(screen: string): TuiFooter | null {
  const lines = screen.split('\n').map((l) => l.trimEnd())
  let input = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf(PROMPT_CHAR)
    if (at >= 0 && lines[i].slice(0, at).trim() === '') {
      input = i
      break
    }
  }
  if (input < 0) return null
  let rule = -1
  for (let i = input + 1; i < lines.length; i++) {
    if (SOLID_RULE_RE.test(lines[i])) {
      rule = i
      break
    }
  }
  if (rule < 0) return null
  const under = lines
    .slice(rule + 1)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
  // A dialog's own footer ("Esc to cancel", "Enter to select") is not a status line.
  if (!under.length || under.some((l) => /Esc to cancel|Enter to select/i.test(l))) return null

  const modeAt = under.findIndex((l) => Object.values(MODE_FOOTER).some((m) => l.includes(m)))
  const statusLine = modeAt === 0 ? undefined : under[0]
  const modeLine = modeAt >= 0 ? under[modeAt] : under[1]
  const split = (l: string): string[] => l.split(' · ').map((x) => x.trim()).filter(Boolean)

  const segments = statusLine ? split(statusLine) : []
  let mode: ChatMode | undefined
  let modeExtras: string[] = []
  if (modeAt >= 0) {
    mode = (Object.keys(MODE_FOOTER) as TuiMode[]).find((k) => modeLine.includes(MODE_FOOTER[k]))
    modeExtras = split(modeLine)
      .slice(1)
      .map((x) => x.replace(/\(shift\+tab[^)]*\)/i, '').trim())
      .filter((x) => x && !FOOTER_HINT_RE.test(x))
  }
  // Right above the box's top rule, when context runs low.
  let autoCompactLeft: number | undefined
  for (let i = Math.max(0, input - 4); i < input; i++) {
    const m = /(\d+(?:\.\d+)?)% until auto-compact/i.exec(lines[i])
    if (m) autoCompactLeft = Number(m[1])
  }
  return {
    segments,
    ...(segments[0] ? { model: segments[0] } : {}),
    ...(mode ? { mode } : {}),
    modeExtras,
    ...(autoCompactLeft !== undefined ? { autoCompactLeft } : {})
  }
}
// Manual, accept edits, plan, bypass (only when allowed), auto: checked in 2.1.292.
export const MODE_MAX_PRESSES = 5

/** One numbered option of a dialog, as read off the screen. */
export interface TuiPromptOption {
  digit: string
  label: string
  description?: string
  /** Multi-select only: whether the box shows [✔]. */
  checked?: boolean
  /** "Type something" / "Tell Claude what to change": the digit, then text, then Enter. */
  freeText: boolean
}

/** A dialog Claude Code has open, read off `capture-pane -p`. */
export interface TuiPrompt {
  kind: 'question' | 'review' | 'plan' | 'permission'
  /** The dialog text above the options, trimmed (a plan keeps up to ~150 lines). */
  body: string
  options: TuiPromptOption[]
  multi: boolean
  /** Tab does something: a multi-select, or a header with several questions. */
  canTab: boolean
  /** A header with several questions (← tabs →): ← goes back to the one before. */
  canBack: boolean
  /**
   * A plan's file, from the footer ("ctrl+g to edit in Vim · ~/.claude/plans/x.md"). The
   * screen holds only the plan's end, and its ExitPlanMode record is not in the
   * transcript until it is answered, so the file is where the whole plan is.
   */
  planFile?: string
}

const OPTION_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(?:\[( |✔|x)\]\s*)?(.*)$/
const SOLID_RULE_RE = /^[\s─━═]{5,}$/
const DASH_RULE_RE = /^[\s╌╍┄┅]{3,}$/
const FOOTER_RE = /(Esc to cancel|Enter to select|Tab to amend|ctrl\+g|ctrl-g)/i
const FREE_TEXT_RE = /^(Type something|Tell Claude what to change)/i
/** A plan file Claude Code names in a plan dialog's footer: ~/.claude/plans/<name>.md or its absolute form. */
export const PLAN_FILE_RE = /((?:~|\/[\w.\/-]*?)\/\.claude\/plans\/[\w.-]+\.md)\b/
const BODY_CAP = { plan: 150, permission: 60, question: 20, review: 20 } as const

/**
 * The dialog on a plain `capture-pane -p` screen, or null. The options are the
 * last run of lines numbered 1, 2, 3… (rules and indented description lines may
 * sit between them); the body is what is above them, up to the box's top rule.
 * The kind comes from a marker in the body or the footer, never from the whole
 * screen, so old conversation text cannot fake a dialog.
 */
export function parsePrompt(screen: string): TuiPrompt | null {
  const lines = screen.split('\n').map((l) => l.trimEnd())
  let last = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_RE.test(lines[i])) {
      last = i
      break
    }
  }
  if (last < 0) return null
  // Walk up while the numbers count down to 1.
  let expect = Number(OPTION_RE.exec(lines[last])![1])
  let first = -1
  for (let i = last; i >= 0 && expect >= 1; i--) {
    const m = OPTION_RE.exec(lines[i])
    if (!m) continue
    if (Number(m[1]) !== expect) break
    if (expect === 1) first = i
    expect--
  }
  if (first < 0) return null

  const options: TuiPromptOption[] = []
  let multi = false
  let end = last
  for (let i = first; i < lines.length; i++) {
    const m = OPTION_RE.exec(lines[i])
    if (!m) continue
    const label = m[3].trim()
    const checked = m[2] === undefined ? undefined : m[2] !== ' '
    if (checked !== undefined) multi = true
    const desc: string[] = []
    let k = i + 1
    for (; k < lines.length; k++) {
      const l = lines[k]
      if (!l.trim() || OPTION_RE.test(l) || SOLID_RULE_RE.test(l) || DASH_RULE_RE.test(l) || FOOTER_RE.test(l) || !/^\s{3,}\S/.test(l)) break
      desc.push(l.trim())
    }
    if (i === last) end = k - 1
    options.push({
      digit: m[1],
      label,
      ...(desc.length ? { description: desc.join(' ') } : {}),
      ...(checked !== undefined ? { checked } : {}),
      freeText: FREE_TEXT_RE.test(label)
    })
    i = k - 1
  }

  // Body: up to the box's top rule, newest lines kept.
  const above: string[] = []
  for (let i = first - 1; i >= 0; i--) {
    if (SOLID_RULE_RE.test(lines[i])) break
    if (DASH_RULE_RE.test(lines[i])) continue
    above.unshift(lines[i])
  }
  const footer = lines.slice(end + 1, end + 6).join('\n')
  const bodyText = above.join('\n')
  const kind: TuiPrompt['kind'] | null = bodyText.includes(MARK.review)
    ? 'review'
    : bodyText.includes(MARK.plan)
      ? 'plan'
      : footer.includes(MARK.question)
        ? 'question'
        : bodyText.includes(MARK.permission)
          ? 'permission'
          : null
  if (!kind) return null

  const body = above.slice(-BODY_CAP[kind]).join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '')
  const tabHeader = above.some((l) => l.includes('←') && l.includes('→'))
  const planFile = kind === 'plan' ? PLAN_FILE_RE.exec(footer)?.[1] : undefined
  return { kind, body, options, multi, canTab: multi || tabHeader, canBack: tabHeader, ...(planFile ? { planFile } : {}) }
}

/** The effort levels `/effort <level>` takes silently (plain `/effort` opens a slider dialog). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** The marker every dialog command (/usage, /status) shows in its footer. */
export const DIALOG_FOOTER = 'Esc to cancel'
const DIALOG_TEXT_CAP = 60
// A hint ("Scroll wheel is sending arrow keys…") may sit inside the edge row.
const DIALOG_EDGE_RE = /^\s*▔{5,}/
// A dialog taller than the pane shows ↓ (and ↑) at the right end of a line.
const SCROLL_MARK_RE = /\s+[↑↓]\s*$/

/**
 * True if a dialog is open. A tall one (/usage in a short pane) is cut off at the
 * bottom, so its "Esc to cancel" footer is not on screen: then it is the ▔ top edge
 * with no input box under it.
 */
export function isDialogOpen(screen: string): boolean {
  if (screen.includes(DIALOG_FOOTER)) return true
  return parseFooter(screen) === null && screen.split('\n').some((l) => DIALOG_EDGE_RE.test(l))
}

/** True if the open dialog has more below what is on screen (Down scrolls it). */
export function dialogHasMore(screen: string): boolean {
  if (screen.includes(DIALOG_FOOTER)) return false
  const lines = screen.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  return lines.slice(-3).some((l) => /↓$/.test(l))
}

/**
 * The body of a command dialog on a plain `capture-pane -p` screen: the lines between
 * its top edge (or the last solid rule) and the "Esc to cancel" line, or the bottom
 * of the screen when the dialog is cut off there. Null when no such dialog is on screen.
 */
export function parseDialogText(screen: string): string | null {
  const lines = screen.split('\n').map((l) => l.trimEnd())
  let end = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(DIALOG_FOOTER)) {
      end = i
      break
    }
  }
  if (end < 0) {
    if (!isDialogOpen(screen)) return null
    end = lines.length
  }
  // A dialog's top edge is a row of ▔. Without one, the nearest solid rule above.
  let start = 0
  for (let i = end - 1; i >= 0; i--) {
    if (DIALOG_EDGE_RE.test(lines[i])) {
      start = i + 1
      break
    }
  }
  if (!start) {
    for (let i = end - 1; i >= 0; i--) {
      if (SOLID_RULE_RE.test(lines[i])) {
        start = i + 1
        break
      }
    }
  }
  const body = lines.slice(Math.max(start, end - DIALOG_TEXT_CAP), end).map((l) => l.replace(SCROLL_MARK_RE, ''))
  const text = body.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '')
  return text || null
}

/**
 * Two reads of a scrolled dialog as one text. Its top rows (the tab row) stay put while
 * the rest scrolls: those, and the lines `b` repeats from the end of `a`, are kept once.
 */
export function joinScrolled(a: string, b: string): string {
  const x = a.split('\n')
  let y = b.split('\n')
  let fixed = 0
  while (fixed < x.length && fixed < y.length - 1 && x[fixed] === y[fixed]) fixed++
  y = y.slice(fixed)
  for (let k = Math.min(x.length, y.length); k > 0; k--) {
    if (x.slice(-k).join('\n') === y.slice(0, k).join('\n')) return [...x, ...y.slice(k)].join('\n')
  }
  return [...x, ...y].join('\n')
}

/** One row of an open TUI screen (/config, /mcp, /resume…), as `parseScreen` reads it. */
export interface ScreenItem {
  label: string
  /** The text right of the label: a setting's value, a server's tool count. */
  value?: string
  /** A dim line under the row (/resume's "4 minutes ago · main"). */
  detail?: string
  /** A leading "[User]" style tag (/hooks). */
  tag?: string
  /** ✔ / ✘ / ⚠ in front of the row (/mcp). */
  mark?: 'ok' | 'error' | 'warn'
  /** The bold heading the row sits under. */
  section?: string
  /** A numbered row's digit (/model). */
  digit?: string
  /** Ends in ›: opens a further screen. */
  sub?: boolean
  selected: boolean
}

/** An open TUI screen in parts, for a native view of it. */
export interface ScreenModel {
  title: string
  tabs: { label: string; active: boolean }[]
  /** Lines above the rows: a description, or /status's "Key: value" lines. */
  intro: string[]
  /** The search box's placeholder, when the screen has one. */
  search: string | null
  items: ScreenItem[]
  /** Rows scrolled out of view above and below ("↓ 20 more"). */
  above: number
  below: number
  outro: string[]
  /** The key hint at the bottom ("Enter to confirm · Esc to cancel"). */
  hint: string
}

/** Identifies a row across reads: its value can change (a toggle), its place can scroll. */
export const screenItemKey = (i: Pick<ScreenItem, 'section' | 'label' | 'tag'>): string => `${i.section ?? ''}\u0000${i.tag ?? ''}\u0000${i.label}`

interface Run {
  text: string
  bold: boolean
  fg: number | null
  /** Reverse video or a background colour: the active tab. */
  lit: boolean
}

/** One screen line with escapes, as styled runs. */
function styleRuns(raw: string): Run[] {
  const runs: Run[] = []
  let bold = false
  let fg: number | null = null
  let inv = false
  let bg = false
  const parts = raw.split(/\x1b\[([0-9;]*)m/)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) runs.push({ text: parts[i], bold, fg, lit: inv || bg })
      continue
    }
    const codes = parts[i] === '' ? [0] : parts[i].split(';').map(Number)
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k]
      if (c === 0) [bold, fg, inv, bg] = [false, null, false, false]
      else if (c === 1) bold = true
      else if (c === 22) bold = false
      else if (c === 7) inv = true
      else if (c === 27) inv = false
      else if (c === 39) fg = null
      else if (c === 49) bg = false
      else if (c === 38 && codes[k + 1] === 5) {
        fg = codes[k + 2]
        k += 2
      } else if (c === 48 && codes[k + 1] === 5) {
        bg = true
        k += 2
      } else if (c >= 30 && c <= 37) fg = c - 30
      else if (c >= 40 && c <= 47) bg = true
    }
  }
  return runs
}

// Claude Code's grey: hints, descriptions, counts.
const DIM_FG = 246
const SCREEN_HINT_RE = /(Esc to|to cancel|to close|to go back|to navigate|to confirm)/i
const MORE_RE = /^\s*([↑↓])\s*(\d+)\s+more\b/
const MORE_TAIL_RE = /^\s*…\s*\+(\d+)/
const MARKS: Record<string, ScreenItem['mark']> = { '✔': 'ok', '✘': 'error', '⚠': 'warn' }

/**
 * An open screen read off a `capture-pane -e -p` capture: title, tabs, rows and hint. Null
 * when no screen is open, or it has nothing a native view can show (then the text is).
 */
export function parseScreen(screenWithEscapes: string): ScreenModel | null {
  // Links (OSC 8) wrap their text in escapes stripSgr does not take out.
  const raws = screenWithEscapes.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').split('\n')
  const plains = raws.map((l) => stripSgr(l).trimEnd())
  if (!isDialogOpen(plains.join('\n'))) return null
  let start = -1
  for (let i = plains.length - 1; i >= 0; i--) {
    if (DIALOG_EDGE_RE.test(plains[i])) {
      start = i + 1
      break
    }
  }
  if (start < 0) return null
  const m: ScreenModel = { title: '', tabs: [], intro: [], search: null, items: [], above: 0, below: 0, outro: [], hint: '' }
  let end = plains.length
  for (let i = plains.length - 1; i >= start; i--) {
    if (!plains[i].trim()) continue
    if (SCREEN_HINT_RE.test(plains[i])) {
      m.hint = plains[i].trim()
      end = i
      // A long hint wraps: its first half is the line above.
      if (i - 1 >= start && plains[i - 1].trim() && !/^\s*(❯|\d+\.)/.test(plains[i - 1].trim()) && /·/.test(plains[i - 1]) && plains[i - 1].length > 100) {
        m.hint = `${plains[i - 1].trim()} ${m.hint}`
        end = i - 1
      }
    }
    break
  }
  let section: string | undefined
  for (let i = start; i < end; i++) {
    const plain = plains[i]
    const text = plain.trim()
    if (!text) continue
    const runs = styleRuns(raws[i]).filter((r) => r.text.trim())
    const indent = plain.length - plain.trimStart().length
    const bold = runs.length > 0 && runs[0].bold
    const dim = runs.length > 0 && runs.every((r) => r.fg === DIM_FG)
    if (/^[╭╰]/.test(text)) continue
    if (/^│/.test(text)) {
      m.search = text.replace(/^│\s*⌕?\s*/, '').replace(/\s*│$/, '').trim() || 'Search…'
      continue
    }
    if (!m.title) {
      const chunks = text.split(/\s{2,}/)
      if (chunks.length >= 3 && runs.some((r) => r.lit)) {
        m.title = chunks[0]
        m.tabs = chunks.slice(1).map((label) => ({ label, active: runs.some((r) => r.lit && r.text.trim() === label) }))
      } else m.title = text
      continue
    }
    const more = MORE_RE.exec(plain)
    if (more && /^\s*[↑↓]\s*\d+\s+more\s*$/.test(plain)) {
      if (more[1] === '↑') m.above = Number(more[2])
      else m.below = Number(more[2])
      continue
    }
    const tail = MORE_TAIL_RE.exec(plain)
    if (tail) {
      m.below = Math.max(m.below, Number(tail[1]))
      continue
    }
    const selected = /^\s*❯\s/.test(plain)
    const arrow = /^\s*[↑↓]\s/.test(plain)
    if (!selected && !arrow && indent < 5) {
      ;(m.items.length ? m.outro : m.intro).push(text)
      continue
    }
    if (!selected && dim) {
      const last = m.items[m.items.length - 1]
      if (last && !last.detail) last.detail = text
      else (m.items.length ? m.outro : m.intro).push(text)
      continue
    }
    if (!selected && bold) {
      section = text.split(/\s{2,}/)[0].replace(/\s*\(.*\)$/, '')
      continue
    }
    let body = text.replace(/^[❯↑↓]\s*/, '')
    const item: ScreenItem = { label: '', selected }
    const digit = /^(\d+)\.\s+/.exec(body)
    if (digit) {
      item.digit = digit[1]
      body = body.slice(digit[0].length)
    }
    const mark = MARKS[body[0]]
    if (mark) {
      item.mark = mark
      body = body.slice(1).trim()
    }
    let parts = body.split(/\s{2,}/)
    const tag = /^\[([^\]]+)\]\s*(.*)$/.exec(parts[0])
    if (tag && (tag[2] || parts.length > 1)) {
      item.tag = tag[1]
      parts = tag[2] ? [tag[2], ...parts.slice(1)] : parts.slice(1)
    }
    item.label = parts[0]
    if (parts.length > 1) item.value = parts.slice(1).join(' · ')
    for (const k of ['value', 'label'] as const) {
      const v = item[k]
      if (v && /\s*›$/.test(v)) {
        item.sub = true
        item[k] = v.replace(/\s*›$/, '')
      }
    }
    if (section) item.section = section
    m.items.push(item)
  }
  if (!m.title) return null
  return m
}

/** One plan limit from the /usage text: "Current session", "22% used", "Resets 11pm (UTC)". */
export interface UsageLimit {
  label: string
  percent: number
  resets?: string
}

/** The limits on the /usage screen, in order; empty when the text holds none. */
export function parseUsage(text: string): UsageLimit[] {
  const lines = text.split('\n').map((l) => l.trim())
  const out: UsageLimit[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = /^Current (session|week)\b(.*)$/i.exec(lines[i])
    if (!head) continue
    let percent: number | undefined
    let resets: string | undefined
    for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
      const pct = /(\d+(?:\.\d+)?)%\s+used/i.exec(lines[k])
      if (pct) percent = Number(pct[1])
      const r = /^Resets\s+(.+)$/i.exec(lines[k])
      if (r) resets = r[1]
    }
    if (percent === undefined) continue
    const extra = head[2].trim().replace(/^\((.*)\)$/, '$1')
    const label = head[1].toLowerCase() === 'session' ? 'Session' : `Weekly${extra ? ' · ' + extra : ''}`
    out.push({ label, percent, ...(resets ? { resets } : {}) })
  }
  return out
}

/** True if the option with `digit` is on the screen with exactly `label` (a card may be stale). */
export function promptHasOption(prompt: TuiPrompt, digit: string, label: string): boolean {
  return prompt.options.some((o) => o.digit === digit && o.label === label)
}

/** A transcript record that marks the end of a turn. */
export const isTurnEnd = (rec: { type?: unknown; subtype?: unknown }): boolean =>
  rec.type === 'system' && rec.subtype === 'turn_duration'
