// Builders and parsers for reviewing a remote git working tree.
//
// The same two shell facts that shape shared/claude.ts shape this file: every
// script here goes through shWrap and must therefore be a single line joined
// with SEP. See shared/shell.ts.
//
// A third fact shapes the rest of it. `git status --porcelain` is a *text* format
// with one record per line, and the only thing that keeps a path from breaking
// that promise is git's own C-style quoting — which is why every invocation below
// pins `core.quotePath=true` rather than trusting the repo's config. With it on,
// every byte outside printable ASCII is escaped, so a record can never contain a
// raw newline and the line-per-record parse is exact.
import type { GitChange } from './types'
import { SEP, shQuote } from './shell'

/**
 * Most status records one review carries back.
 *
 * A cap rather than a stream because the whole result crosses `exec` as one
 * string, and a repo where a build dropped 200k untracked objects would
 * otherwise blow the byte ceiling and fail outright. Truncation is reported, not
 * hidden: the panel says so.
 */
export const MAX_REVIEW_FILES = 400

/**
 * Largest either side of one diff may be.
 *
 * Monaco computes a diff synchronously on the UI thread for anything this size;
 * well past it the tab locks up for seconds. Both sides are measured on the
 * server and skipped there, so an oversized file costs one `wc -c`, not a
 * transfer.
 */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024

/**
 * Boundary between a file script's `key=value` header and its raw payload.
 *
 * Every header key here is ASCII and written by this file, so the FIRST
 * occurrence of this sequence is always the real boundary — a blob that happens
 * to contain the same bytes can only ever appear after it.
 */
export const DATA_MARK = '\n--LT-DATA--\n'

/**
 * List what changed in the repo containing `dir`, and pin the commit to compare
 * against.
 *
 * Pinning matters more than it looks. The whole point of this panel is to read
 * an agent's work while the agent is still running, and an agent that commits
 * mid-review would move HEAD out from under it — the diff would empty out and
 * read as "nothing changed" at the exact moment something did. The base SHA is
 * captured once here and every blob is fetched against that SHA, so the review
 * describes one fixed moment until it is explicitly refreshed.
 *
 * `--no-optional-locks` is not a nicety either: plain `git status` takes
 * `index.lock` to refresh the stat cache, and the agent we are watching runs git
 * too. Without it, reviewing during a commit fails with a lock error.
 */
export function reviewScript(dir: string): string {
  return [
    `cd ${shQuote(dir)} 2>/dev/null || { echo "err=nodir"; exit 0; }`,
    'command -v git >/dev/null 2>&1 || { echo "err=nogit"; exit 0; }',
    'R=$(git rev-parse --show-toplevel 2>/dev/null)',
    '[ -n "$R" ] || { echo "err=norepo"; exit 0; }',
    'echo "root=$R"',
    // `--verify` so an unborn branch yields nothing. Plain `git rev-parse HEAD`
    // prints the literal string "HEAD" on stdout there, which would sail through
    // as a revision and then fail to resolve on every file. Empty means "no
    // base", which makes every tracked file an addition — right for a fresh repo.
    'echo "base=$(git rev-parse --verify --quiet HEAD 2>/dev/null)"',
    // symbolic-ref rather than `rev-parse --abbrev-ref`, which answers "HEAD" for
    // both a detached head and an unborn branch. Empty here means detached, and
    // the panel shows the short SHA instead of a branch named HEAD.
    'echo "branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"',
    // One over the cap, so the caller can tell "exactly at the limit" from
    // "there were more". Every record is prefixed, which is what stops a file
    // named `end=1` from forging the sentinel below.
    `git --no-optional-locks -c core.quotePath=true status --porcelain=v1 --untracked-files=all 2>/dev/null | head -n ${MAX_REVIEW_FILES + 1} | sed 's/^/f=/'`,
    'echo "end=1"'
  ].join(SEP)
}

/**
 * Fetch both sides of one file in a single round trip: the blob at the pinned
 * base, then the working-tree file.
 *
 * The two are concatenated with no separator, which works because of the order.
 * `baseBytes` comes from `git cat-file -s` and is exact — a git object cannot
 * change under us — so the base side is sliced off by that count. The working
 * side is whatever remains, and deliberately does not trust its own `wc -c`:
 * the file may well be mid-write by the agent, and a count taken a moment before
 * `cat` would put the split in the wrong place. Last position, no count, no race.
 *
 * `baseSpec` is null when there is nothing to compare against — an untracked
 * file, or any file in a repo with no commits.
 */
export function fileScript(root: string, baseSpec: string | null, path: string): string {
  // `./` prefix, not a bare quoted path: quoting stops the shell splitting the
  // word, it does not stop `cat` reading a file named `-n` as a flag. A leading
  // `./` is the portable fix — `--` is not honoured by every cat on every host.
  const p = `./${shQuote(path)}`
  const spec = baseSpec === null ? null : shQuote(baseSpec)
  return [
    // The marker goes out on the failure path too. Without it the caller cannot
    // find the header at all, and reports a parse error over a perfectly clear
    // one — "that directory is gone" told as "the file read did not complete".
    `cd ${shQuote(root)} 2>/dev/null || { echo "err=nodir"; echo "end=1"; printf '%s\\n' '--LT-DATA--'; exit 0; }`,
    'BS=',
    // Type-checked before size: `<rev>:<dir>` resolves to a tree and `cat-file -s`
    // would happily report the tree's size, which the caller would then read as a
    // file whose bytes never arrive.
    ...(spec
      ? [
          `if [ "$(git cat-file -t ${spec} 2>/dev/null)" = blob ]; then BS=$(git cat-file -s ${spec} 2>/dev/null); fi`
        ]
      : []),
    // `-f` and not `-e`: a directory or a socket at that path has no diff to show,
    // and `cat` on either is a mistake in a different direction each time.
    `WS=; if [ -f ${p} ]; then WS=$(wc -c < ${p} 2>/dev/null | tr -d ' '); fi`,
    // Empty means "no such side", which is how a deletion and an addition are
    // told apart from an empty file.
    'echo "baseBytes=$BS"',
    'echo "workBytes=$WS"',
    'echo "end=1"',
    // printf, not echo: a leading `--` is an option to some echo builtins.
    `printf '%s\\n' '--LT-DATA--'`,
    `if [ -n "$BS" ] && [ "$BS" -le ${MAX_DIFF_BYTES} ] 2>/dev/null; then git cat-file blob ${spec ?? "''"}; fi`,
    `if [ -n "$WS" ] && [ "$WS" -le ${MAX_DIFF_BYTES} ] 2>/dev/null; then cat ${p}; fi`
  ].join(SEP)
}

/**
 * Undo git's C-style quoting for one path token.
 *
 * git escapes with the C rules (`\n`, `\t`, `\"`, `\\`) and writes any other byte
 * as a three-digit *octal* escape — `\303\251` for `é`. Those are bytes, not code
 * points, so they are collected and decoded as UTF-8 together; decoding each one
 * on its own would turn every non-ASCII path into mojibake.
 *
 * Applies to NEWLINE-framed porcelain only. git quotes when the record terminator
 * is a newline and writes the value raw when it is NUL, so running this over `-z`
 * output would corrupt any value that legitimately contains a backslash. Verified
 * both ways: newline framing prints `locked "a\"b\\c\ttab"`, `-z` prints the same
 * reason unescaped. shared/worktrees.ts gates on that.
 */
export function unquote(token: string): string {
  if (!token.startsWith('"')) return token
  const body = token.slice(1, -1)
  const out: number[] = []
  const push = (s: string): void => {
    for (const b of new TextEncoder().encode(s)) out.push(b)
  }
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      push(body[i])
      continue
    }
    const c = body[++i]
    if (c === undefined) break
    const octal = /^[0-7]{3}$/.exec(body.slice(i, i + 3))
    if (octal) {
      out.push(parseInt(octal[0], 8))
      i += 2
      continue
    }
    const simple: Record<string, number> = {
      n: 10,
      t: 9,
      r: 13,
      f: 12,
      b: 8,
      v: 11,
      a: 7,
      '\\': 92,
      '"': 34
    }
    if (c in simple) out.push(simple[c])
    else push(c)
  }
  return new TextDecoder().decode(new Uint8Array(out))
}

/**
 * Split a status record's path field into `[from, to]`.
 *
 * Renames and copies are written `ORIG -> PATH`. Either side may be quoted, and
 * a quoted side can legitimately contain ` -> ` — so the quoted form is scanned
 * to its real closing quote rather than searched for the arrow. When *neither*
 * side is quoted the arrow is ambiguous and git's own output cannot be recovered
 * exactly; the first occurrence is used, which is right unless the original path
 * itself contained ` -> `.
 */
function splitPaths(rest: string): [string] | [string, string] {
  if (rest.startsWith('"')) {
    let i = 1
    while (i < rest.length && rest[i] !== '"') i += rest[i] === '\\' ? 2 : 1
    const first = rest.slice(0, i + 1)
    const tail = rest.slice(i + 1)
    if (tail.startsWith(' -> ')) return [unquote(first), unquote(tail.slice(4))]
    return [unquote(first)]
  }
  const arrow = rest.indexOf(' -> ')
  if (arrow < 0) return [unquote(rest)]
  return [unquote(rest.slice(0, arrow)), unquote(rest.slice(arrow + 4))]
}

/**
 * Parse `f=`-prefixed `git status --porcelain=v1` records.
 *
 * Columns are fixed: X is the index's opinion, Y the working tree's, then a
 * space, then the path field. `??` is untracked — the one state with no base
 * side at all, and worth its own flag because `?` is not a status letter
 * anywhere else.
 */
export function parsePorcelain(lines: string[]): GitChange[] {
  const out: GitChange[] = []
  for (const line of lines) {
    if (line.length < 4) continue
    const x = line[0]
    const y = line[1]
    const paths = splitPaths(line.slice(3))
    const path = paths.length === 2 ? paths[1] : paths[0]
    if (!path) continue
    out.push({
      x,
      y,
      path,
      ...(paths.length === 2 ? { from: paths[0] } : {}),
      untracked: x === '?' && y === '?'
    })
  }
  return out
}

/**
 * Reject anything that is not a plain repo-relative path.
 *
 * This is a real boundary, not a formality. The path arrives back from the
 * renderer and is interpolated into `cat` and into a `<rev>:<path>` object spec
 * inside the repo root — `..` would walk straight out of the tree that the user
 * asked to review.
 *
 * Deliberately permissive otherwise. A tab, a space, a leading dash and a
 * newline are all legal in a POSIX filename, git reports every one of them, and
 * shQuote carries all but the last safely. The newline is the exception, and not
 * for a quoting reason: the whole script is one single-quoted line because csh
 * cannot carry a quoted word across a line break (see SEP), so a path containing
 * one would split the script itself.
 */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.length > 4096) return false
  if (p.startsWith('/')) return false
  if (/[\x00\n\r]/.test(p)) return false
  return !p.split('/').some((seg) => seg === '..')
}
