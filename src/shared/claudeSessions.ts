// Reading the live Claudes on a host: the status files Claude Code keeps in
// ~/.claude/sessions, joined with the tmux panes that exist. Pure — the main
// process runs CHAT_LIST_SCRIPT and hands the output to parseChatSessions().
import type { ChatSession } from './chatProtocol'
import { MARK } from './tuiKeys'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A session id goes into a remote shell glob, so it is checked before it is used. */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** A tmux pane id, e.g. %31. */
export const PANE_RE = /^%\d+$/

/**
 * One exec: every status file whose pid is alive (`S <pid> <mtime s> <base64>`),
 * (`D <pid>` after one whose pane shows a dialog), then every tmux pane
 * (`P <pane>|<window>|<session>`). The session name is
 * last because it is the one field that could hold a `|`. tmux may be missing or
 * have no server; that is an empty pane list, not a failure.
 */
export const CHAT_LIST_SCRIPT =
  'for f in "$HOME"/.claude/sessions/*.json; do [ -f "$f" ] || continue; b=$(basename "$f" .json); ' +
  'case "$b" in ""|*[!0-9]*) continue;; esac; kill -0 "$b" 2>/dev/null || continue; ' +
  'm=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null); ' +
  'echo "S $b ${m:-0} $(base64 < "$f" | tr -d \'\\n\')"; ' +
  // A Claude that says busy may be showing a dialog (older versions never say waiting for
  // one): `D <pid>` when its pane's last lines hold a numbered option and a dialog marker.
  'if grep -q \'"status":"busy"\' "$f"; then p=$(grep -o \'"tmux":"[^"]*"\' "$f" | grep -o \'%[0-9]*\'); ' +
  'if [ -n "$p" ]; then t=$(tmux capture-pane -p -t "$p" 2>/dev/null | tail -n 20); case "$t" in *"❯ 1."*) case "$t" in ' +
  `*"${MARK.permission}"*|*"${MARK.plan}"*|*"${MARK.question}"*|*"${MARK.review}"*) echo "D $b";; esac;; esac; fi; fi; done; ` +
  "tmux list-panes -a -F '#{pane_id}|#{window_id}|#{session_name}' 2>/dev/null | sed 's/^/P /'; exit 0"

/** The status file's `tmux` field, "session:@window.%pane". */
export function parseTmuxField(s: unknown): { session: string; window: string; pane: string } | null {
  if (typeof s !== 'string') return null
  const m = /^(.+):(@\d+)\.(%\d+)$/.exec(s.trim())
  return m ? { session: m[1], window: m[2], pane: m[3] } : null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Live Claudes, newest first. Entries that are not a session (no UUID) are dropped. */
export function parseChatSessions(stdout: string): ChatSession[] {
  const panes = new Map<string, { window: string; session: string }>()
  const files: Array<{ pid: number; mtime: number; b64: string }> = []
  const dialog = new Set<number>()
  for (const line of stdout.split('\n')) {
    const d = /^D (\d+)$/.exec(line.trim())
    if (d) dialog.add(Number(d[1]))
    if (line.startsWith('P ')) {
      const m = /^P (%\d+)\|(@\d+)\|(.*)$/.exec(line)
      if (m) panes.set(m[1], { window: m[2], session: m[3] })
    } else if (line.startsWith('S ')) {
      const m = /^S (\d+) (\d+) (\S*)$/.exec(line.trim())
      if (m) files.push({ pid: Number(m[1]), mtime: Number(m[2]) * 1000, b64: m[3] })
    }
  }
  const out: ChatSession[] = []
  for (const f of files) {
    let j: Record<string, unknown>
    try {
      const v: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))))
      if (!v || typeof v !== 'object') continue
      j = v as Record<string, unknown>
    } catch {
      continue
    }
    if (!isUuid(j.sessionId)) continue
    const field = parseTmuxField(j.tmux)
    const pane = field ? panes.get(field.pane) : undefined
    const entrypoint = str(j.entrypoint)
    const kind = str(j.kind)
    out.push({
      sessionId: j.sessionId,
      pid: typeof j.pid === 'number' ? j.pid : f.pid,
      cwd: str(j.cwd) ?? '',
      name: str(j.name),
      status: dialog.has(f.pid) ? 'waiting' : (str(j.status) ?? 'idle'),
      waitingFor: str(j.waitingFor) ?? (dialog.has(f.pid) ? 'dialog' : undefined),
      entrypoint,
      version: str(j.version),
      tmux: field && pane ? { session: pane.session, window: pane.window, pane: field.pane } : undefined,
      drivable: (entrypoint === undefined || entrypoint === 'cli') && (kind === undefined || kind === 'interactive') && !!pane,
      updatedAt: f.mtime
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}
