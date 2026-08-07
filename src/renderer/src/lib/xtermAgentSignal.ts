// The inbound half of "the agent wants you": the escape sequences a program
// running on the far side writes when it needs a human, turned into one event.
//
// This is a sibling of xtermAttach rather than part of it because it is purely
// inbound — nothing here sends bytes, and every terminal in the app wants it
// whether or not it wants clipboard or composer behavior.
import type { Terminal as XTerm } from '@xterm/xterm'

/** Longest remote-set text we'll carry into app chrome or an OS notification. */
const TEXT_MAX = 120

export interface AgentSignal {
  /**
   * `message` came from an explicit desktop-notification sequence and carries
   * text a human wrote; `bell` is a bare `\a`, which means *something* wanted
   * attention but says nothing about what. The distinction is policy-bearing:
   * a bell is common enough in ordinary shell use (readline, vim, mail) that
   * it should never raise an OS notification, only tint the tab.
   */
  kind: 'message' | 'bell'
  /** Notification title. Empty for a bell, and often empty for OSC 9. */
  title: string
  /** Notification body. Empty for a bell. */
  body: string
}

/**
 * Remote-controlled text landing in our chrome and in an OS notification.
 * Same treatment as a window title, for the same reason: React escapes it, so
 * this is about legibility — strip control characters, which would otherwise
 * smuggle line breaks into a tab label, and cap the length. OSC payloads are
 * allowed to be megabytes long by the parser.
 */
function clean(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TEXT_MAX)
}

/**
 * Listen for attention signals on a terminal. Returns a disposer.
 *
 * Three sequences are recognized, all of them de-facto standards that terminal
 * programs already emit:
 *
 * - `OSC 777 ; notify ; <title> ; <body>` — rxvt's notification sequence, the
 *   one tmux, kitty and most Linux terminals honor.
 * - `OSC 9 ; <body>` — iTerm2's shorter form.
 * - `BEL` — the oldest signal there is, kept because a program that can't emit
 *   either of the above can always ring.
 *
 * Every handler returns `false`. Returning `true` from an OSC handler tells
 * xterm the sequence was consumed and stops it reaching xterm's own handler for
 * that id; these three have no built-in behavior to preserve today, but a
 * *future* xterm that grows one shouldn't have it silently swallowed by us —
 * watching is not consuming. (Contrast OSC 52 in xtermAttach, which really does
 * consume.)
 *
 * The tmux passthrough wrapper (`DCS tmux; … ST`) is deliberately *not* handled
 * here, and that is the interesting part. A tmux control-mode pane forwards the
 * wrapper to us raw — it ships pane bytes verbatim over `%output` and never
 * applies the passthrough gate — so the bytes arrive with `ESC P tmux;` still on
 * the front. It works anyway: xterm's parser ends a DCS at the first ESC of the
 * wrapped body and re-enters escape parsing on it, so the inner OSC handler
 * above fires on its own. Verified against the bundled parser in both the
 * singly- and doubly-escaped forms and with the sequence split across write()
 * boundaries, which ByteBatcher can do.
 *
 * A tmux client on a real tty is the opposite case: tmux parses the wrapper
 * itself and drops it unless the server has `allow-passthrough` on, which has
 * been off by default since tmux 3.3. That is why the hook we install pairs the
 * wrapped OSC with a plain BEL (see main/claudeHooks.ts) — the bell is what
 * survives a stock tmux, and it lands here as a `bell` signal.
 *
 * A `{ final: 't' }` DCS handler would be worse than useless: `ESC P t` hooks on
 * `t`, so it receives the literal `mux;` and nothing else — the payload is
 * already gone — and firing a signal from it would double every notification
 * that the inner OSC already reported.
 */
export function attachAgentSignal(term: XTerm, onSignal: (s: AgentSignal) => void): () => void {
  // OSC 777 ; notify ; title ; body — everything after the third `;` is body,
  // so a semicolon in the message text is not a parse error.
  const off777 = term.parser.registerOscHandler(777, (data) => {
    if (!data.startsWith('notify;')) return false // 777 also carries unrelated sub-commands
    const rest = data.slice('notify;'.length)
    const sep = rest.indexOf(';')
    const title = clean(sep === -1 ? rest : rest.slice(0, sep))
    const body = sep === -1 ? '' : clean(rest.slice(sep + 1))
    if (title || body) onSignal({ kind: 'message', title, body })
    return false
  })

  const off9 = term.parser.registerOscHandler(9, (data) => {
    const body = clean(data)
    if (body) onSignal({ kind: 'message', title: '', body })
    return false
  })

  // A BEL that terminates an OSC string is consumed by the OSC parser and never
  // reaches here, so this fires for genuine `\a` writes only.
  const offBell = term.onBell(() => onSignal({ kind: 'bell', title: '', body: '' }))

  return () => {
    off777.dispose()
    off9.dispose()
    offBell.dispose()
  }
}
