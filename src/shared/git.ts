// git's path quoting, which every porcelain parser in the app has to undo.
//
// This file used to hold the builders and parsers for the Review Changes pane. The
// pane is gone; what stays is the one rule that is about git rather than about
// reviewing — `core.quotePath` applies to worktree listings, status output and
// anything else newline-framed, so it outlives any single reader of it.

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
