// One pass over a host's saved Claude Code sessions: what can be resumed, where
// it ran, and what it was about.
//
// Same two shell facts as shared/agents.ts and shared/claude.ts shape this file —
// the script goes through shWrap and must be one line joined with SEP, because the
// remote login shell may be fish or csh. See shared/shell.ts.
//
// Claude Code keeps a transcript per session at
// `$CLAUDE_CONFIG_DIR/projects/<mangled cwd>/<session id>.jsonl`, and four facts
// about that layout decide everything below.
//
// The directory name is a LOSSY encoding of the working directory — every
// character outside [A-Za-z0-9] becomes `-`, so `/srv/a.b`, `/srv/a-b` and
// `/srv/a/b` all land in `-srv-a-b`. It can therefore never be decoded back into
// a path, and the path is the one field resume cannot do without (see below). So
// the cwd is read out of the file's own records and the directory name is treated
// as an opaque bucket.
//
// `claude --resume <id>` is scoped to the working directory: the id is looked up
// under the project directory for the cwd the process starts in, and the same id
// from a different cwd is reported as "No conversation found". Verified against
// 2.1.220 with a real id from a neighbouring project. That is why a row without a
// cwd is not resumable, and why the launch script `cd`s first and lets its
// existing `die` hold the error when the directory is gone.
//
// A transcript's own `timestamp` records are NOT its last-active time. A live
// session's newest timestamped record was three and a half hours behind the
// file's mtime when this was measured, because the records that close a file
// (titles, mode, last-prompt) carry no timestamp of their own. mtime is the only
// honest answer, so it is what this asks for — and, where `stat` cannot provide
// it, what this reports as unknown rather than guessing.
//
// The records worth reading live at the END of the file. A 24 MB, 7,490-line
// transcript had its newest `ai-title` on line 7,484. So each file is read
// through a bounded `tail`, which makes the cost of a session independent of its
// size: 14 sessions including two ~24 MB transcripts took 0.20s.
import { SEP, shQuote } from './shell'
import type { ResumeSession } from './types'

/**
 * Field separator inside one scan row — the same string, for the same reason, as
 * shared/agents.ts. Imported rather than redeclared: two definitions of one wire
 * format are two things that can drift apart, and the parser on this side would
 * go on reading rows that the script on that side had stopped writing.
 */
import { FIELD_SEP } from './agents'

/** Marks a scan row, so a shell's own error text can never be parsed as one. */
const ROW = 'r'

/**
 * How many transcripts are described per host.
 *
 * The user this was measured against has 959 of them across 29 project
 * directories, 1.96 GB in total. Reading a bounded `tail` of every one would be
 * roughly a thousand round trips through one exec channel for a list nobody scrolls
 * to the end of, so the newest are described and the rest are counted. The count
 * is reported separately and shown in the header: a list that silently stops at 60
 * reads as "that is all there is", which is a different and wrong answer.
 *
 * This is a page size, not a ceiling — `resumeScanScript` takes an offset, and the
 * panel's Load more asks for the next one. A limit with no way past it would be the
 * same wrong answer written more politely: the 900th session is exactly the one a
 * user cannot find any other way.
 */
export const RESUME_LIMIT = 60

/** What one host's scan output parsed into, before it is labelled with the host. */
export interface ResumeScan {
  sessions: ResumeSession[]
  /** Transcripts found, which may exceed `sessions.length` — see RESUME_LIMIT. */
  total: number
  /** The script's end marker arrived. See ResumeHostScan.complete. */
  complete: boolean
  /** Set when the host has no transcript directory at all, which is normal. */
  empty?: boolean
  /** Set when `projects/` holds entries but nothing under it could be listed. */
  listFailed?: boolean
}

/**
 * List the newest transcripts on the host, one row each.
 *
 * `ls -t` does the ordering, because it is POSIX and the alternatives are not:
 * `find -printf` and `stat` are both non-portable, and this needs the *ordering*
 * far more than it needs the timestamps. The timestamps come from `stat` when
 * `stat` exists, in either the GNU or the BSD spelling, and are simply omitted
 * when it does not — a row that says "unknown" costs the user nothing, and a row
 * that says "2 minutes" about a two-month-old session costs them a wrong decision.
 *
 * Two substitutions run over each `tail` before anything is read out of it, and
 * both replace one legal JSON escape with another, so the values stay exactly as
 * valid as they arrived and the parser's JSON.parse restores them unchanged:
 *
 * - `\"` becomes `"`, because the naive `[^"]*` that reads a JSON string body
 *   stops dead at the first escaped quote. A prompt containing a quoted shell
 *   command came back truncated to a trailing backslash before this was added.
 * - `|` becomes `|`, which makes it impossible for any extracted value to
 *   contain the field separator. shared/agents.ts mitigates the same hazard by
 *   putting its only path field last and rejoining the tail; this closes it
 *   outright, and still puts the path last.
 *
 * The clock comes from the host for the same reason it does in agentScanScript():
 * an age is the difference between two timestamps, and taking one of them from the
 * laptop would report every session on a clock-skewed host as either brand new or
 * ancient.
 */
export function resumeScanScript(offset = 0, limit = RESUME_LIMIT): string {
  /**
   * Escape one read window before anything is extracted from it. Both rules replace
   * one legal JSON escape with another, so the values stay exactly as valid as they
   * arrived; see the two bullets above.
   */
  const ESC = `sed 's/\\\\"/\\\\u0022/g; s/|/\\\\u007c/g'`

  /**
   * Pull the last value of one key out of the window in `v`.
   *
   * `label` truncates, and has to. A prompt is whatever the user typed, so the
   * value read out of a 32 KB window can be nearly 32 KB long — and sixty of those
   * would be about 2 MB, over the exec ceiling, which *fails* the whole scan rather
   * than truncating it. A row is bounded here instead, where the cost of the cut is
   * a shortened title. Paths are deliberately NOT cut: PATH_MAX already bounds them,
   * and half a path is not a shorter path, it is a wrong one.
   */
  const g = (key: string, v: string, label?: boolean): string =>
    `printf '%s\\n' "${v}" | sed -n 's/.*"${key}":"\\([^"]*\\)".*/\\1/p' | tail -1` +
    (label ? ' | cut -c1-200' : '')

  /**
   * The working directory, from whichever record recorded it last.
   *
   * A relocated session — one whose directory was moved out from under it — gets a
   * record of its own, `{"type":"relocated","relocatedCwd":"<new>","cwd":"<old>"}`,
   * carrying both paths. Claude Code itself reads the newer key and overwrites the
   * cwd with it (verified in the 2.1.220 binary), so this does the same: `-e t`
   * branches out of the script once `relocatedCwd` has matched on a line, which is
   * what makes the new path win over the old one sitting on that same record.
   * Across records the plain `tail -1` decides, because the last one to say where
   * the session was is the one that was right most recently.
   *
   * One sed rather than the two this used to run, which is both the fix for the
   * head-fallback path below — it only ever asked for `cwd`, so a relocated session
   * whose tail held no directory at all resolved to the stale one and `--resume`
   * would answer "No conversation found" — and three fewer processes per file.
   */
  const cwd = (v: string): string =>
    `printf '%s\\n' "${v}" | sed -n` +
    ` -e 's/.*"relocatedCwd":"\\([^"]*\\)".*/\\1/p'` +
    ` -e t` +
    ` -e 's/.*"cwd":"\\([^"]*\\)".*/\\1/p' | tail -1`

  /** A marker row with no fields — a fact about the scan rather than a session. */
  const mark = (k: string): string => `printf '%s\\n' ${shQuote(`${ROW}${FIELD_SEP}${k}`)}`

  const row = [ROW, 's', '$id', '$m', '$z', '$ex', '$ct', '$at', '$lp', '$cw'].join(FIELD_SEP)

  // `tail -n +N` is omitted entirely at offset 0, which is every scan but the ones
  // the user asked to extend.
  const page =
    offset > 0 ? `head -n ${offset + limit} | tail -n +${offset + 1} | ` : `head -n ${limit} | `

  return [
    // Statement one, before anything reads a byte. `tail -c 32768` cuts a window at
    // a byte boundary, so a transcript containing any non-ASCII character will
    // routinely hand `sed` a partial multibyte sequence — and in a UTF-8 locale BSD
    // sed answers that with `RE error: illegal byte sequence` and stops, taking
    // every field of that file with it. Measured, not assumed: the same file and the
    // same expression return the title under `LC_ALL=C` and nothing at all without
    // it. Bytes are also what this wants for its own sake, since every rule below is
    // byte surgery on an escaped window.
    'LC_ALL=C',
    'export LC_ALL',
    // The same `$CLAUDE_CONFIG_DIR` fallback the hook installer uses; a host that
    // relocates its Claude config must not be reported as having no sessions.
    'CFG=${CLAUDE_CONFIG_DIR:-$HOME/.claude}',
    'P=$CFG/projects',
    // Not an error. A server the user has never run Claude Code on is the normal
    // starting state, and the pane says so in words rather than showing a failure.
    // It still ends properly: "nothing here" is a complete answer, and without the
    // marker every never-used host would be reported as a truncated one.
    `[ -d "$P" ] || { ${mark('empty')}; ${mark('end')}; exit 0; }`,
    `printf '%s\\n' "${ROW}${FIELD_SEP}now${FIELD_SEP}$(date +%s)"`,
    // Both numbers come out of ONE `stat` per file, in whichever dialect this host
    // speaks: mtime and size are the two facts the list is built on, and asking
    // twice would double the process count for nothing.
    'ST=; stat -c "%Y %s" "$P" >/dev/null 2>&1 && ST=c',
    '[ -n "$ST" ] || { stat -f "%m %z" "$P" >/dev/null 2>&1 && ST=f; }',
    // Listed once and reused: the count and the page must describe the same set,
    // and a second `ls` could disagree with the first if a session ended between
    // them.
    'L=$(ls -t "$P"/*/*.jsonl 2>/dev/null) || L=',
    // An empty listing is two very different facts wearing the same face. `projects/`
    // with nothing in it means this host has no saved sessions; a listing that failed
    // — no permission, or a glob too large for the shell's argument list — means we
    // do not know what it has. Only the first is reported as "nothing", and the test
    // is deliberately positive: the tree is called empty when `ls` succeeds AND says
    // so, never when it declines to answer.
    `[ -n "$L" ] || { A=$(ls -A "$P" 2>/dev/null) && [ -z "$A" ] || ${mark('lserr')}; }`,
    `printf '%s\\n' "${ROW}${FIELD_SEP}total${FIELD_SEP}$(printf '%s\\n' "$L" | grep -c .)"`,
    // `read -r`, not `for f in $L`: word splitting would break a config directory
    // whose path contains a space, which `$HOME` on macOS routinely does.
    `printf '%s\\n' "$L" | ${page}while read -r f; do ` +
      [
        '[ -f "$f" ] || continue',
        'b=${f##*/}',
        'id=${b%.jsonl}',
        // One call, split with parameter expansion rather than `cut`, which would be
        // two more processes per file. An unset `$ST` leaves both fields empty, which
        // is exactly what the parser reads as "this host could not say".
        'case $ST in c) sz=$(stat -c "%Y %s" "$f");; f) sz=$(stat -f "%m %z" "$f");; *) sz=;; esac',
        'm=${sz%% *}',
        'z=${sz##* }',
        `t=$(tail -c 32768 "$f" 2>/dev/null | ${ESC})`,
        `ct=$(${g('customTitle', '$t', true)})`,
        `at=$(${g('aiTitle', '$t', true)})`,
        `lp=$(${g('lastPrompt', '$t', true)})`,
        `cw=$(${cwd('$t')})`,
        // A transcript whose tail is one enormous record has its cwd nowhere near
        // the end. The head is just as cheap, and is where the first one always is.
        // Read into its own variable: clobbering `$t` would leave the next field of
        // this row being read out of a different window than the last one.
        `[ -n "$cw" ] || { h=$(head -c 32768 "$f" 2>/dev/null | ${ESC}); cw=$(${cwd('$h')}); }`,
        // Does that directory still exist? Free — two builtins, no process — and it
        // is the difference between a disabled button with a reason on it and a
        // terminal tab that opens only to print an error. Three answers, not two: a
        // path still carrying a JSON escape is not tested at all, because testing the
        // escaped text would report a directory that is really there as gone.
        'ex=; case "$cw" in *\\\\*) ;; /*) ex=0; [ -d "$cw" ] && ex=1;; esac',
        // `printf`, never `echo`: the values here are JSON string bodies, so a prompt
        // typed across two lines arrives as a literal backslash-n — and `echo` in
        // dash, in zsh and in macOS `/bin/sh` expands that into a real newline, which
        // splits the row in half and makes the session vanish from a list that still
        // counts it. Measured across all four shells; only bash-as-bash was safe.
        `printf '%s\\n' "${row}"`
      ].join(SEP) +
      '; done',
    // Last, and the only proof the list is whole: an exec that dies mid-stream — the
    // remote shell killed, the channel dropped — RESOLVES with whatever stdout had
    // arrived (ssh/manager.ts, the `close` handler), so a cut-short list is otherwise
    // indistinguishable from a short one. `exit 0` keeps the exit status meaningful
    // for exactly that case, rather than reporting the `while` loop's last status.
    mark('end'),
    'exit 0'
  ].join(SEP)
}

/**
 * Undo the escaping of one extracted value, or report it as absent.
 *
 * The value arrived as the body of a JSON string, so JSON is what decodes it —
 * including the `"` and `|` the script substituted in, and the `\n` and
 * `\uXXXX` that were already there. A body this cannot parse is discarded rather
 * than shown raw: the alternative is a title reading `say "hi"`, which
 * looks like a bug in the app rather than an oddity in one transcript.
 */
function decode(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  const parse = (body: string): string | null => {
    try {
      const s = JSON.parse(`"${body}"`)
      return typeof s === 'string' && s.trim() ? s : null
    } catch {
      return null
    }
  }
  // A label was cut to 200 characters on the far side, and the cut lands wherever
  // it lands — including halfway through the `é` that a non-ASCII character
  // arrives as. That is not a broken value, it is a value one escape too long, so
  // the dangling escape is dropped and it is parsed again. Only then is it given up.
  return parse(v) ?? parse(v.replace(/\\(u[0-9a-fA-F]{0,3})?$/, ''))
}

/**
 * Read the scan output into one entry per session.
 *
 * Written to degrade rather than to trust, like parseAgentScan(): the far side is
 * whatever shell, `sed` and `stat` that host happens to have, and a field this
 * cannot read becomes `null` — which every caller already has to render, because
 * half of these sessions genuinely have no title.
 */
export function parseResumeScan(text: string): ResumeScan {
  let now: number | null = null
  let total = 0
  let empty = false
  let complete = false
  let listFailed = false
  const rows: { s: ResumeSession; mtime: number | null }[] = []

  for (const line of text.split('\n')) {
    const parts = line.trim().split(FIELD_SEP)
    if (parts[0] !== ROW) continue
    if (parts[1] === 'empty') {
      empty = true
      continue
    }
    if (parts[1] === 'end') {
      complete = true
      continue
    }
    if (parts[1] === 'lserr') {
      listFailed = true
      continue
    }
    if (parts[1] === 'now') {
      // First wins, like the inbox's clock: the script prints this before it runs
      // anything that could put a chosen string on stdout.
      if (now === null) {
        const n = parseInt(parts[2], 10)
        if (Number.isFinite(n) && n > 0) now = n
      }
      continue
    }
    if (parts[1] === 'total') {
      const n = parseInt(parts[2], 10)
      if (Number.isFinite(n) && n >= 0) total = n
      continue
    }
    // marker + kind + 8 fields. `cw` is last and cannot contain the separator
    // (see resumeScanScript), but the tail is rejoined anyway so that a future
    // field added before it cannot silently truncate a path.
    if (parts[1] !== 's' || parts.length < 10) continue
    const id = parts[2]
    // The id is the string handed to `--resume`, and a transcript filename is a
    // UUID. Anything else in this position means the row is not what it claims.
    if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) continue
    const at = parseInt(parts[3], 10)
    const sz = parseInt(parts[4], 10)
    const ex = parts[5]
    const dir = decode(parts.slice(9).join(FIELD_SEP))
    rows.push({
      mtime: Number.isFinite(at) && at > 0 ? at : null,
      s: {
        id,
        // 0 is a real answer here — a transcript that exists and holds nothing —
        // so this admits it and only rejects what `stat` could not measure.
        sizeBytes: Number.isFinite(sz) && sz >= 0 ? sz : null,
        // Anything the far side did not say — an empty field, or a shell that fell
        // through the `case` — is "not checked", never "not there".
        dirExists: ex === '1' ? true : ex === '0' ? false : null,
        // The stream is decoded as UTF-8, so a path holding bytes that are not valid
        // UTF-8 arrives with U+FFFD substituted into it. That string is no longer the
        // path on disk, and `cd` against it can only fail, so the row keeps the fact
        // and the panel refuses the click instead of opening a tab that cannot work.
        dirLossy: dir !== null && dir.includes('\uFFFD'),
        customTitle: decode(parts[6]),
        aiTitle: decode(parts[7]),
        lastPrompt: decode(parts[8]),
        dir,
        ageSeconds: null
      }
    })
  }

  const sessions = rows.map(({ s, mtime }) => ({
    ...s,
    ageSeconds: mtime !== null && now !== null ? Math.max(0, now - mtime) : null
  }))
  // `ls -t` already ordered these; the count can only be short if the listing was
  // truncated, never long, so trust whichever is larger. With paging `sessions` is
  // one page rather than the set, so `total` is now almost always the larger — and
  // that comparison is the thing keeping a truncated count from shrinking the header
  // below the number of rows sitting under it.
  return {
    sessions,
    total: Math.max(total, sessions.length),
    complete,
    ...(empty ? { empty } : {}),
    ...(listFailed ? { listFailed } : {})
  }
}

/**
 * The one label to show for a session.
 *
 * A ladder, strongest first, and it stops rather than reaching for something
 * meaningless. `/title` is the user's own word for the work. `aiTitle` is Claude's,
 * and about half of all sessions have one. `lastPrompt` is a poor third — plenty of
 * sessions end on "continue" — but it is a real sentence the user typed, and it
 * beats the fourth rung, which is nothing at all: a session with no label is shown
 * by its directory, and the caller renders that instead. Boilerplate is skipped
 * outright, because a session started by a slash command records the local-command
 * caveat as its prompt, and sixty rows all named "Caveat: The messages below were
 * generated by the user…" is a list with no information in it.
 */
export function resumeTitle(s: ResumeSession): string | null {
  const usable = (v: string | null): string | null => {
    if (!v) return null
    // A label is cut to 200 bytes on the far side, and under `LC_ALL=C` the cut
    // lands wherever it lands — including the middle of a multibyte character,
    // which arrives here as a trailing U+FFFD. Dropping it is cosmetic and only
    // ever touches the end of a title that was already being shortened.
    const t = v.replace(/\uFFFD+$/, '').replace(/\s+/g, ' ').trim()
    if (t.length < 3) return null
    if (t.startsWith('<local-command-caveat>') || t.startsWith('Caveat:')) return null
    if (/^<[a-z-]+>/.test(t)) return null
    return t
  }
  return usable(s.customTitle) ?? usable(s.aiTitle) ?? usable(s.lastPrompt)
}
