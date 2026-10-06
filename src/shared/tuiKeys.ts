// How the chat tab drives a real Claude Code TUI running in a tmux pane.
//
// The chat never talks to Claude directly: it types into the pane, exactly as a
// person at the terminal would. Every key sequence here was confirmed against
// Claude Code 2.1.291 in a throwaway tmux session. Each action has a screen
// marker that must be visible (tmux capture-pane) before its keys are sent —
// the status file's `waiting` is also set by hooks (e.g. an approval gate), so
// it is never enough on its own to press a key.

/** tmux key names, as `tmux send-keys` takes them. */
export const KEY = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  shiftTab: 'BTab'
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
  /** `/model x` asks this when the conversation is cached; digit 1 confirms. */
  modelConfirm: 'Switch model?'
} as const

/** Interrupt a running turn (only while the status file says busy). */
export const INTERRUPT = KEY.escape

/**
 * Permission mode: Shift+Tab cycles it, and the footer's last line names it. To
 * set a mode, press Shift+Tab until that line contains the mode's text (give up
 * after MODE_MAX_PRESSES). Which modes are in the cycle depends on how Claude
 * was started — "bypass" only when it was launched with that allowed.
 */
export const MODE_FOOTER = {
  bypassPermissions: 'bypass permissions on',
  acceptEdits: 'accept edits on',
  plan: 'plan mode on',
  default: 'manual mode on'
} as const
export type TuiMode = keyof typeof MODE_FOOTER
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
}

const OPTION_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(?:\[( |✔|x)\]\s*)?(.*)$/
const SOLID_RULE_RE = /^[\s─━═]{5,}$/
const DASH_RULE_RE = /^[\s╌╍┄┅]{3,}$/
const FOOTER_RE = /(Esc to cancel|Enter to select|Tab to amend|ctrl\+g|ctrl-g)/i
const FREE_TEXT_RE = /^(Type something|Tell Claude what to change)/i
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
  return { kind, body, options, multi, canTab: multi || tabHeader }
}

/** True if the option with `digit` is on the screen with exactly `label` (a card may be stale). */
export function promptHasOption(prompt: TuiPrompt, digit: string, label: string): boolean {
  return prompt.options.some((o) => o.digit === digit && o.label === label)
}

/** A transcript record that marks the end of a turn. */
export const isTurnEnd = (rec: { type?: unknown; subtype?: unknown }): boolean =>
  rec.type === 'system' && rec.subtype === 'turn_duration'
