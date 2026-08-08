// Builders and parsers for the git worktrees of a remote repository.
//
// Same two shell facts as shared/git.ts and shared/claude.ts: every script here
// goes through shWrap and must be a single line joined with SEP, because the
// remote login shell may be fish or csh. See shared/shell.ts.
//
// The third fact is this file's own, and it is why `-z` is not optional here.
// `git worktree list --porcelain` prints the worktree path *unquoted* — unlike
// `git status --porcelain`, there is no `core.quotePath` to lean on — so a path
// containing a newline is indistinguishable from a record boundary. `-z` (git
// 2.36+) makes every delimiter a NUL, which a path cannot contain at all, and
// the parser below detects which form it got rather than assuming.
import type { RemoteWorktree, WorktreeScan } from './types'
import { SEP, shQuote } from './shell'
import { unquote } from './git'

/** Every invocation goes through this: see shared/git.ts on `index.lock`. */
const GIT = 'git --no-optional-locks'

/**
 * Separates the script's small `key=value` header from the raw `worktree list`
 * payload, which is binary-ish in `-z` mode and must not be line-parsed.
 *
 * Every header key is ASCII and written by this file, so the FIRST occurrence of
 * this sequence is the real boundary.
 */
export const WT_DATA_MARK = '\n--LT-WT--\n'

/**
 * Written last, so its presence means the payload above it is complete.
 *
 * Safe as a plain word inside the script — unlike WT_DATA_MARK it carries no
 * newline of its own, so shQuote can emit it directly.
 */
export const WT_END_MARK = '--LT-WT-END--'

/**
 * Where this app puts a new worktree, relative to the repository root.
 *
 * Not invented: the user's server already keeps its Claude worktrees here, and
 * the path is already in the repo's ignore rules. Scattering a second set of
 * worktrees somewhere else would leave the same repo with two conventions.
 */
export const WORKTREE_DIR = '.claude/worktrees'

/**
 * How many branches the scan will name, most recently committed first.
 *
 * The list exists so the create form can offer existing branches and grey out the
 * ones already checked out somewhere. A repo with thousands of them would make
 * that a worse control, not a better one, and this reply crosses an SSH channel.
 */
export const MAX_BRANCHES = 500

/**
 * How many worktrees the panel will show.
 *
 * Far above any plausible repo — the cap is here so a malformed reply cannot turn
 * into an unbounded list, not because anyone has 200 worktrees.
 */
export const MAX_WORKTREES = 200

/**
 * List the worktrees of the repository containing `dir`, plus that repo's root.
 *
 * The root is not a nicety — it is what a new worktree's path is built from, and
 * `dir` may be any directory inside the repo (or inside one of its worktrees).
 *
 * Exits 0 on every path that isn't a repository. A directory that simply isn't
 * under git is a normal answer to this question, not a failure, and the panel
 * says so; letting the script exit non-zero would surface it as a scan error.
 */
export function worktreeListScript(dir: string): string {
  const cd = `cd ${shQuote(dir)} 2>/dev/null`
  return [
    `${cd} || { echo 'err=no such directory'; exit 0; }`,
    `root=$(${GIT} rev-parse --show-toplevel 2>/dev/null)`,
    `[ -n "$root" ] || { echo 'err=not a git repository'; exit 0; }`,
    `echo "root=$root"`,
    // The common dir tells a worktree apart from the repo it belongs to, so the
    // panel can offer "list the worktrees of THIS repo" from inside any of them.
    //
    // Canonicalised here rather than in the parser, because `--git-common-dir` is
    // only absolute when it is read from inside a LINKED worktree. Verified on git
    // 2.50.1: at the top of the main tree it prints a bare `.git`, and two levels
    // down it prints `../../.git`. A relative answer is useless to a parser that
    // has to compare it against the absolute paths `worktree list` prints, so the
    // resolving happens where the cwd still exists. The `cd` is inside a command
    // substitution, so it cannot move the shell the rest of the script runs in,
    // and "$C" is quoted against a repo path containing a space.
    `C=$(${GIT} rev-parse --git-common-dir 2>/dev/null)`,
    `C=$(cd "$C" 2>/dev/null && pwd -P)`,
    `echo "common=$C"`,
    // Branches go in the *header*, above the mark, and that is safe for the one
    // reason that matters: git's own refname rules forbid ASCII control
    // characters, so a branch name cannot contain a newline the way a path can.
    // --count keeps a huge repo from turning this reply into a download.
    `${GIT} for-each-ref --format='branch=%(refname:short)' --sort=-committerdate --count=${MAX_BRANCHES} refs/heads 2>/dev/null || true`,
    // The mark's own leading newline is the `echo` above's trailing one — writing
    // WT_DATA_MARK out literally would put a real newline inside the script, and a
    // single-quoted word cannot carry one to csh. printf, not echo: a leading `--`
    // is an option to some echo builtins. Same shape as shared/git.ts.
    `printf '%s\\n' '--LT-WT--'`,
    // -z first; the fallback is for a git older than 2.36, where the parser
    // detects the newline form instead. Both are the same records either way.
    `${GIT} worktree list --porcelain -z 2>/dev/null || ${GIT} worktree list --porcelain 2>/dev/null || true`,
    // Proof the payload arrived whole. The reply crosses SSH under a byte cap, and
    // a truncated worktree list is not a short answer — it is a wrong one that
    // renders as "this repo has two worktrees" with no sign anything is missing.
    `printf '%s' ${shQuote(WT_END_MARK)}`
  ].join(SEP)
}

/**
 * One worktree as this parser produces it — `RemoteWorktree` minus
 * `connectionId`, because this file is host-agnostic and has no idea which
 * connection `text` came from. The IPC handler that calls parseWorktreeScan
 * stamps that field on afterward — see types.ts on RemoteWorktree.
 */
type ScannedWorktree = Omit<RemoteWorktree, 'connectionId'>

/**
 * Read the scan output into one entry per worktree.
 *
 * Written to degrade rather than to trust, like the agent scan: an attribute this
 * cannot read is left at its neutral value instead of guessing. The record
 * grammar is git's own — one `worktree <path>` line opens a record, and `HEAD`,
 * `branch`, `bare`, `detached`, `locked` and `prunable` may follow in any order,
 * the last two optionally carrying a free-text reason.
 */
export function parseWorktreeScan(
  text: string
): Omit<WorktreeScan, 'worktrees'> & { worktrees: ScannedWorktree[] } {
  const cut = text.indexOf(WT_DATA_MARK)
  const header = cut === -1 ? text : text.slice(0, cut)
  const raw = cut === -1 ? '' : text.slice(cut + WT_DATA_MARK.length)
  const whole = raw.endsWith(WT_END_MARK)
  const payload = whole ? raw.slice(0, -WT_END_MARK.length) : raw

  let root: string | null = null
  let common: string | null = null
  let error: string | undefined
  const branches: string[] = []
  for (const line of header.split('\n')) {
    const row = line.trim()
    if (row.startsWith('root=')) root = row.slice(5) || null
    else if (row.startsWith('common=')) common = row.slice(7) || null
    else if (row.startsWith('branch=')) {
      const b = row.slice(7)
      if (b) branches.push(b)
    } else if (row.startsWith('err=')) error = row.slice(4)
  }
  if (error) return { root: null, common: null, branches: [], worktrees: [], error }

  // Which form came back. `-z` output contains NULs and no newlines at all; the
  // fallback is the reverse. Detecting beats assuming: the same app talks to
  // whatever git each host happens to have.
  const zeroed = payload.includes('\0')
  const recordSep = zeroed ? '\0\0' : '\n\n'
  const fieldSep = zeroed ? '\0' : '\n'

  const worktrees: ScannedWorktree[] = []
  for (const record of payload.split(recordSep)) {
    const fields = record.split(fieldSep).filter((f) => f.length > 0)
    if (fields.length === 0) continue
    let path = ''
    let head = ''
    let branch: string | null = null
    let bare = false
    let detached = false
    let locked: string | null = null
    let prunable: string | null = null

    for (const field of fields) {
      // Split on the FIRST space only: every value here — a path, a ref, a lock
      // reason — may contain spaces of its own.
      const at = field.indexOf(' ')
      const key = at === -1 ? field : field.slice(0, at)
      const value = at === -1 ? '' : field.slice(at + 1)
      if (key === 'worktree') path = value
      else if (key === 'HEAD') head = value
      // refs/heads/x -> x. Left whole if it isn't under refs/heads, because then
      // it isn't a branch name and shortening it would be a lie.
      else if (key === 'branch') branch = value.startsWith('refs/heads/') ? value.slice(11) : value
      else if (key === 'bare') bare = true
      else if (key === 'detached') detached = true
      // `locked` and `prunable` appear bare when git has no reason to give, so
      // '' means "yes, no reason" and null means "no" — hence the string|null.
      //
      // Unquoted only in the newline form. git escapes a reason when the record
      // terminator is a newline and writes it raw under `-z`, so unquoting `-z`
      // output would eat the backslashes out of a reason that has its own.
      else if (key === 'locked') locked = zeroed ? value : unquote(value)
      else if (key === 'prunable') prunable = zeroed ? value : unquote(value)
    }
    if (!path) continue
    worktrees.push({ path, head, branch, bare, detached, locked, prunable })
  }

  // A repository always has at least its main tree, so an empty list here means
  // the reply was cut off or garbled, not that there is nothing to show.
  if (!whole || worktrees.length === 0)
    return {
      root,
      common,
      branches,
      worktrees: [],
      error: 'The worktree list came back incomplete. Try again.'
    }

  return { root, common, branches, worktrees, error }
}

/**
 * The main working tree of the set — the repository proper, not one of its
 * linked worktrees.
 *
 * `scan.root` is deliberately NOT the primary answer, and that is not a nicety.
 * `rev-parse --show-toplevel` reports the top of whichever tree the script ran
 * in, so scanning from inside `.claude/worktrees/dt2` makes `root` *be* dt2 —
 * verified against the live host. Trusting it there would label a linked
 * worktree as the repository, which is how a Remove button ends up aimed at the
 * repo itself and how a new worktree gets nested inside another one.
 *
 * `--git-common-dir` is the field that names the main tree from anywhere, and the
 * scan script resolves it to an absolute path before sending it, so the match
 * below works from the repo and from inside any of its worktrees alike.
 *
 * When that match misses — an unreadable common dir, a symlinked repo path git
 * spells differently — the fallback is the FIRST record, which git documents as
 * the main worktree and which was confirmed to hold even when the command runs
 * from inside a linked one. `scan.root` is deliberately not a rung at all: it
 * would silently return dt2 as "the repository" in exactly the case the two
 * rungs above exist to handle, which is how a Remove button ends up aimed at the
 * repo and how a new worktree gets nested inside another one.
 */
export function mainWorktree(scan: WorktreeScan): RemoteWorktree | null {
  const common = scan.common
  if (common && common.startsWith('/')) {
    const main = common.replace(/\/\.git\/?$/, '')
    const byCommon = scan.worktrees.find((w) => w.path === main)
    if (byCommon) return byCommon
  }
  return scan.worktrees[0] ?? null
}

/**
 * Where this scan's new worktrees belong: `<main tree>/.claude/worktrees`.
 *
 * Hung off the main tree rather than off `scan.root` for the reason above — a
 * scan taken from inside dt2 must still put dt3 beside dt2, not inside it.
 */
export function worktreeBase(scan: WorktreeScan): string | null {
  const main = mainWorktree(scan)
  return main ? `${main.path}/${WORKTREE_DIR}` : null
}

/**
 * Which branches are already checked out somewhere in this repo.
 *
 * git refuses to check the same branch out twice, so the create form needs this
 * to explain *why* an option is unavailable rather than letting git say no after
 * the fact.
 */
export function checkedOutBranches(scan: WorktreeScan): Set<string> {
  const taken = new Set<string>()
  for (const w of scan.worktrees) if (w.branch) taken.add(w.branch)
  return taken
}

/**
 * Reject anything that must never reach `git worktree add` — or null if it may.
 *
 * shQuote makes these strings inert *as shell syntax*, and the builder below puts
 * a `--` in front of the path so git stops reading options. Neither closes this:
 *
 *   - `..` and `/` are legal in a quoted shell word and survive `--` untouched.
 *     They would place the worktree outside the directory this app says it puts
 *     worktrees in, which no amount of argument hygiene prevents.
 *   - `--` is the second layer, not the only one. It is one flag in one builder;
 *     a leading-dash name reaching git through some later code path that forgets
 *     it is the failure this whitelist is still standing for.
 *
 * So the charset is a whitelist, not a blacklist of the characters that happen to
 * be dangerous today.
 */
export function worktreeNameError(name: string): string | null {
  if (!name) return 'Enter a name'
  if (name.length > 64) return 'Too long (max 64 characters)'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    return 'Use letters, numbers, dot, dash or underscore, starting with a letter or number'
  if (name.includes('..')) return 'Cannot contain ".."'
  return null
}

/**
 * Reject anything that must never reach git as a branch name or a start point.
 *
 * Deliberately narrower than git's own refname grammar. This is the app's
 * whitelist, and git re-checks with `check-ref-format` on the far side — being
 * stricter than git costs a user an exotic branch name, while being looser than
 * git costs a leading-dash argument read as an option.
 */
export function refNameError(ref: string, what = 'branch'): string | null {
  if (!ref) return `Enter a ${what}`
  if (ref.length > 200) return 'Too long'
  if (/^[-.]/.test(ref)) return `A ${what} cannot start with "-" or "."`
  if (/[\s~^:?*[\\]/.test(ref)) return `A ${what} cannot contain spaces or ~ ^ : ? * [ \\`
  if (ref.includes('..') || ref.includes('@{')) return `A ${what} cannot contain ".." or "@{"`
  if (ref.endsWith('/') || ref.endsWith('.lock')) return `A ${what} cannot end with "/" or ".lock"`
  if (ref.includes('//') || ref.includes('/.')) return `A ${what} has an empty or hidden path part`
  return null
}

/** What to check out in a newly created worktree. */
export type WorktreeStart =
  /** Make a new branch at `from` — git fails if the branch already exists. */
  | { kind: 'new'; branch: string; from: string }
  /** Check out a branch that already exists, which no other worktree may hold. */
  | { kind: 'existing'; branch: string }

/**
 * Create a worktree at `<repoRoot>/.claude/worktrees/<name>`.
 *
 * `-B` is never used, only `-b`. `-B` would move an existing branch onto a new
 * start point, which for a branch some other agent is committing to is data loss
 * wearing the same button. If the branch exists, the caller says `existing` and
 * git checks it out where it already points.
 *
 * Exits 0 whatever happens and reports through `err=`, so a failure arrives as a
 * sentence in the panel rather than as a rejected IPC call.
 */
export function worktreeAddScript(repoRoot: string, name: string, start: WorktreeStart): string {
  const path = `${repoRoot}/${WORKTREE_DIR}/${name}`
  // `--` really is honoured here — `git worktree add -b x -- <path> HEAD` was run
  // against git 2.50.1 to check, because parse_options strips it by default and
  // this command was never in the group that keeps it. It stops a path or a start
  // point that begins with a dash from being read as a flag.
  const add =
    start.kind === 'new'
      ? `${GIT} worktree add -b ${shQuote(start.branch)} -- ${shQuote(path)} ${shQuote(start.from)}`
      : `${GIT} worktree add -- ${shQuote(path)} ${shQuote(start.branch)}`
  return [
    `cd ${shQuote(repoRoot)} 2>/dev/null || { echo 'err=That directory no longer exists on the server.'; exit 0; }`,
    // Re-validated on the far side. The renderer checked too, but the renderer is
    // not the thing holding the SSH connection.
    `${GIT} check-ref-format --branch ${shQuote(start.branch)} >/dev/null 2>&1 || { echo 'err=git rejected that branch name.'; exit 0; }`,
    // Existing-branch mode only: prove the branch is still there. It was listed by
    // a scan that happened before the click, and if it was deleted in between then
    // `worktree add <path> <name>` stops being "check this branch out" and becomes
    // git's DWIM — it would go looking for a remote branch of that name and create
    // a tracking branch instead. Quietly doing a different thing than the form said
    // is worse than saying no.
    ...(start.kind === 'existing'
      ? [
          `${GIT} show-ref --verify --quiet ${shQuote(`refs/heads/${start.branch}`)} || { echo 'err=That branch no longer exists.'; exit 0; }`
        ]
      : []),
    // git creates the leaf itself but not always the two levels above it, and a
    // missing parent reads as a confusing git error rather than as a first run.
    `mkdir -p ${shQuote(`${repoRoot}/${WORKTREE_DIR}`)} 2>/dev/null || { echo 'err=Could not create the worktrees directory.'; exit 0; }`,
    `out=$(${add} 2>&1)`,
    `rc=$?`,
    // git's own words are the best error text there is; flattened to one line so
    // it survives a line-oriented header, and capped so it stays a message.
    `[ $rc -eq 0 ] || { echo "err=$(printf '%s' "$out" | tr '\\n\\r' '  ' | cut -c1-400)"; exit 0; }`,
    `echo ${shQuote(`path=${path}`)}`,
    `echo 'ok=1'`
  ].join(SEP)
}

/** How many status records the pre-flight will name before it stops counting. */
export const MAX_INSPECT = 200

/** What `worktreeInspectScript` found in a worktree about to be removed. */
export interface WorktreeInspect {
  /** Tracked-file changes and untracked files — anything git would refuse over. */
  dirty: number
  /** Ignored paths, which git deletes without refusing. `node_modules/` collapses. */
  ignored: string[]
  /** True when the status hit MAX_INSPECT and the counts are floors, not totals. */
  truncated: boolean
  error?: string
}

/**
 * Look at a worktree before offering to remove it.
 *
 * This exists because of one verified fact that the lock badge does not cover: a
 * worktree holding nothing but `.env` and `node_modules/` reports a completely
 * clean `git status --porcelain -uall`, and unforced `git worktree remove` then
 * deletes it and returns 0. git's refusals protect tracked and untracked work.
 * They say nothing about ignored files, and on these servers the ignored file is
 * the `.env` — the one file in the tree that exists nowhere else at all.
 *
 * One status run serves both halves. `--ignored=traditional` is the reason it is
 * affordable: it collapses a 40,000-file `node_modules` into the single record
 * `!! node_modules/` rather than streaming every path inside it. The default
 * untracked mode has to stay — asking for `-uno` alongside `--ignored` does not
 * give a cheaper answer, it gives no ignored records at all.
 */
export function worktreeInspectScript(path: string): string {
  return [
    `cd ${shQuote(path)} 2>/dev/null || { echo 'err=That worktree no longer exists on the server.'; exit 0; }`,
    // Line-oriented, and safe to be: `status --porcelain` C-quotes any path
    // containing a newline whatever core.quotePath says — verified — so a record
    // is always exactly one line. quotePath=true is git's default, set explicitly
    // so a host that turned it off still gets the escaping `unquote` expects.
    `${GIT} -c core.quotePath=true status --porcelain --ignored=traditional 2>/dev/null | head -n ${MAX_INSPECT + 1} | sed 's/^/s=/'`,
    `echo 'end=1'`
  ].join(SEP)
}

/** Read `worktreeInspectScript`'s reply. */
export function parseWorktreeInspect(text: string): WorktreeInspect {
  let dirty = 0
  const ignored: string[] = []
  let seen = 0
  let end = false
  let error: string | undefined
  for (const line of text.split('\n')) {
    if (line.trim() === 'end=1') {
      end = true
      continue
    }
    if (line.startsWith('err=')) {
      error = line.slice(4).trim()
      continue
    }
    if (!line.startsWith('s=')) continue
    seen++
    if (seen > MAX_INSPECT) continue
    const record = line.slice(2)
    // `!! path` is an ignored entry; every other status code is real work.
    if (record.startsWith('!! ')) ignored.push(unquote(record.slice(3).trim()))
    else dirty++
  }
  if (error) return { dirty: 0, ignored: [], truncated: false, error }
  // No terminator means the reply was cut off, and a removal confirm that
  // under-reports what it is about to delete is worse than one that cannot say.
  if (!end)
    return { dirty: 0, ignored: [], truncated: true, error: 'Could not read that worktree.' }
  return { dirty, ignored, truncated: seen > MAX_INSPECT }
}

/**
 * Remove a worktree.
 *
 * `--force` is never passed, and that is the whole safety model. git refuses to
 * remove a worktree that is locked or that has modified or untracked files, and
 * both of those refusals are exactly the case this app must not override: a
 * locked worktree is one an agent is live in, and a dirty one holds work that
 * exists nowhere else. The refusal is surfaced verbatim instead.
 *
 * What that model does NOT cover is ignored files, which git deletes silently —
 * see `worktreeInspectScript`, which the panel runs before it offers the button.
 *
 * The branch is deliberately left behind. Removing the worktree throws away a
 * checkout; removing the branch would throw away the commits.
 */
export function worktreeRemoveScript(repoRoot: string, path: string): string {
  return [
    `cd ${shQuote(repoRoot)} 2>/dev/null || { echo 'err=That directory no longer exists on the server.'; exit 0; }`,
    `out=$(${GIT} worktree remove ${shQuote(path)} 2>&1)`,
    `rc=$?`,
    `[ $rc -eq 0 ] || { echo "err=$(printf '%s' "$out" | tr '\\n\\r' '  ' | cut -c1-400)"; exit 0; }`,
    `echo 'ok=1'`
  ].join(SEP)
}

/** Read an `ok=`/`err=`/`path=` reply from the two scripts above. */
export function parseWorktreeWrite(text: string): { ok: boolean; path?: string; error?: string } {
  let ok = false
  let path: string | undefined
  let error: string | undefined
  for (const line of text.split('\n')) {
    const row = line.trim()
    if (row === 'ok=1') ok = true
    else if (row.startsWith('path=')) path = row.slice(5)
    else if (row.startsWith('err=')) error = row.slice(4)
  }
  if (error) return { ok: false, error }
  if (!ok) return { ok: false, error: 'git did not report a result.' }
  return { ok: true, path }
}

/**
 * Whether an agent is live in this worktree, as far as anything observable says.
 *
 * The lock is the only signal there is, and it is a good one: the tooling that
 * creates these worktrees locks them with the session that owns them, and git
 * itself refuses to remove a locked worktree without `--force`. Treated as
 * "hands off" rather than as advice — the thing on the other side of that lock is
 * an agent's uncommitted work.
 */
export function isBusy(w: RemoteWorktree): boolean {
  return w.locked !== null
}
