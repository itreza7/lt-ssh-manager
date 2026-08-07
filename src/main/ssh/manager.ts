// SSH session manager. Owns ssh2 Clients + interactive shell channels, applies
// connect retry with fail-fast on permanent errors, and verifies host keys.
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2'
import type {
  Connection,
  HostKeyPrompt,
  SessionStatus,
  SftpEntry,
  SftpList,
  SftpReadResult,
  TmuxIntent,
  TunnelDef,
  TunnelState,
  TunnelStatus
} from '../../shared/types'
import { tmuxReattachCommand } from '../../shared/tmux'
import { knownHosts } from './knownHosts'
import { TmuxControlClient } from './tmuxControl'
import { ByteBatcher } from './byteBatcher'
import { classifyDrop, ladderDelay, withJitter } from './dropClassifier'

/** Files up to this size open editable; larger ones open view-only. */
const MAX_EDIT_BYTES = 10 * 1024 * 1024
/** Hard ceiling on what we'll pull fully into memory — beyond this, download instead. */
const MAX_OPEN_BYTES = 50 * 1024 * 1024

const joinPath = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)

function permString(mode: number): string {
  const rwx = (n: number): string => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`
  return rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7)
}

function entryType(attrs: Stats): SftpEntry['type'] {
  if (attrs.isDirectory()) return 'directory'
  if (attrs.isSymbolicLink()) return 'symlink'
  if (attrs.isFile()) return 'file'
  return 'other'
}

export interface ConnectOpts {
  sessionId: string
  connection: Connection
  password?: string
  passphrase?: string
  cols: number
  rows: number
  retries: number
  timeoutMs?: number
  /** If set, run this command in a PTY instead of an interactive login shell. */
  command?: string
  /** Treat the stream as a tmux control-mode (`tmux -CC`) protocol channel. */
  control?: boolean
  /**
   * Present when `command` attaches to a tmux session. Enables the reattach
   * ladder: on a drop the session is re-attached (never re-created) on its own.
   */
  tmux?: TmuxIntent
  /**
   * Nobody is watching this dial. Suppresses the host-key prompt — an unknown or
   * *changed* key is refused outright rather than asked about, since a key that
   * changed while the app reconnected by itself is the one case that must not be
   * click-through. Set by the reattach ladder, never by a user action.
   */
  unattended?: boolean
}

interface ExecOpts {
  password?: string
  passphrase?: string
  command: string
  /** Connect deadline (ssh2 `readyTimeout`). Covers the handshake, nothing after it. */
  timeoutMs?: number
  /**
   * Deadline for the whole operation, connect *and* command. Without one, a
   * command that never closes its channel — a probe that blocks on a prompt, a
   * server wedged mid-write — leaves the caller's promise pending forever, and
   * every caller here is a UI panel waiting on it. Defaults to EXEC_DEADLINE_MS.
   */
  deadlineMs?: number
}

interface Session {
  client: Client
  stream?: ClientChannel
  closed: boolean
  /** Present for tmux control-mode sessions; multiplexes many panes over one stream. */
  control?: TmuxControlClient
  /** Flush + tear down this session's output coalescing (see ByteBatcher). */
  endOutput?: () => void
  /** True when the reattach ladder started this attempt, not the user. */
  auto: boolean
  /** Whether 'ready' has been emitted for this attempt yet (see announceReady). */
  announced: boolean
  /** Fallback timer that announces readiness when no output arrives to prove it. */
  readyTimer?: ReturnType<typeof setTimeout>
  /** When the session first proved it worked; gates the attempt-counter reset. */
  healthyAt?: number
  // ---- evidence gathered as the session dies, read once by classifyDrop() ----
  sawStreamExit: boolean
  exitCode: number | null
  exitSignal?: string
  sawTmuxExit: boolean
  tmuxExitReason: string
  /**
   * Rolling tail of what the command last printed. Kept as raw bytes and decoded
   * once, at death, because this is fed from the terminal stream — decoding every
   * chunk here would undo the whole point of ByteBatcher.
   *
   * It is *output*, not stderr: every interactive channel here allocates a pty,
   * and sshd's pty path passes -1 as the channel's extended-data fd (session.c,
   * `do_exec_pty`), so the server has no separate stderr to forward and
   * `stream.stderr` never fires. tmux's exit banner — the only thing that tells a
   * detach from a killed session — is printed to the pty by client.c.
   */
  outputTail: Buffer
  transportError?: string
}

/**
 * A tmux-backed session's standing order to reattach itself. Outlives the Session
 * it belongs to — it is what survives a drop — and is dropped only by close() or
 * a verdict that reattaching cannot help.
 */
interface Redial {
  /** The original connect options, including the credential needed to redial. */
  opts: ConnectOpts
  /** Attach-only command, or null when this session must never be reattached. */
  reattachCommand: string | null
  /** Latest geometry the renderer asked for, so a reattach comes up right-sized. */
  cols: number
  rows: number
  /** Rungs climbed since the last proven-healthy stretch. */
  attempt: number
  /**
   * Globally unique per connect(). A dial whose epoch is no longer the one in this
   * map has been superseded and must go quiet — no status, no session registered.
   */
  epoch: number
  timer?: ReturnType<typeof setTimeout>
}

/** A session must run this long before a later drop is treated as a fresh outage. */
const HEALTHY_RESET_MS = 10_000
/** Per-dial timeout while reattaching. Short: the ladder is the retry mechanism. */
const REATTACH_DIAL_TIMEOUT_MS = 8000
/** How long to wait for output proving a reattach worked before saying it did. */
const AUTO_READY_FALLBACK_MS = 3000
/** Size of the retained output tail. Only the last line or two ever matters. */
const TAIL_BYTES = 512
/**
 * Enough of the escape grammar to unwrap tmux's parting banner: OSC (terminated by
 * BEL or ST), CSI, and any other escape — optional 0x20-0x2F intermediates then a
 * 0x30-0x7E final, which is what covers the `ESC ( B` charset reset ncurses emits
 * immediately before it.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g

interface PendingHostKey {
  cb: (ok: boolean) => void
  host: string
  port: number
  key: Buffer
}

interface RunningTunnel {
  def: TunnelDef
  connectionId: string
  client: Client
  server?: Server // local + dynamic listen here; remote uses forwardIn
  sockets: Set<Socket>
  state: TunnelState
  error?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Errors that will never succeed on retry. */
function isPermanent(err: any): boolean {
  if (err?.level === 'client-authentication') return true
  if (err?.code === 'ENOTFOUND') return true // host doesn't resolve
  const msg = String(err?.message ?? '')
  if (/All configured authentication methods failed/i.test(msg)) return true
  if (/host.*verif/i.test(msg)) return true // user rejected host key
  return false
}

export class SshManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  // Standing orders to reattach, one per connected session id. Deliberately a
  // sibling of `sessions` rather than a field on Session: it has to outlive the
  // Session that dropped, and it is the authority on whether a dial still matters.
  private redials = new Map<string, Redial>()
  private epoch = 0
  // One SFTP channel shared per connection, reference-counted across the file
  // manager + every editor tab. Kept warm briefly after the last release so
  // reopening a file doesn't pay for a fresh SSH handshake.
  private sftpPool = new Map<
    string,
    { client: Client; sftp: SFTPWrapper; refs: number; closeTimer?: ReturnType<typeof setTimeout> }
  >()
  private sftpConnecting = new Map<string, Promise<void>>()
  private pendingHostKeys = new Map<string, PendingHostKey>()
  // Active tunnels, keyed by their definition id (a def runs at most once).
  private tunnels = new Map<string, RunningTunnel>()

  private emitStatus(sessionId: string, status: SessionStatus): void {
    this.emit('status', sessionId, status)
  }

  /** Auth + host-key verification config shared by interactive and one-shot connects. */
  private baseConfig(
    c: Connection,
    password: string | undefined,
    passphrase: string | undefined,
    timeoutMs: number | undefined,
    extra?: { unattended?: boolean; keepaliveMs?: number }
  ): ConnectConfig {
    const config: ConnectConfig = {
      host: c.host,
      port: c.port || 22,
      username: c.username,
      readyTimeout: timeoutMs ?? 30000,
      keepaliveInterval: extra?.keepaliveMs ?? 15000,
      hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
        const res = knownHosts.verify(c.host, c.port || 22, key)
        if (res.status === 'known') return verify(true)
        // Nobody is at the keyboard: refuse rather than prompt. A key that turns
        // up unknown or changed during an automatic reattach is exactly the case
        // that should stop the ladder, not raise a dialog behind the user's back.
        if (extra?.unattended) return verify(false)
        const requestId = randomUUID()
        this.pendingHostKeys.set(requestId, { cb: verify, host: c.host, port: c.port || 22, key })
        const prompt: HostKeyPrompt = {
          requestId,
          host: c.host,
          port: c.port || 22,
          keyType: res.keyType,
          fingerprint: res.fingerprint,
          changed: res.status === 'changed'
        }
        this.emit('hostkey', prompt)
      }) as any
    }

    if (c.authMethod === 'key' && c.keyPath) {
      config.privateKey = readFileSync(c.keyPath) // throws -> caller rejects
      if (passphrase) config.passphrase = passphrase
    } else if (c.authMethod === 'password') {
      config.password = password
    } else if (c.authMethod === 'agent') {
      config.agent =
        process.env.SSH_AUTH_SOCK ||
        (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    }
    return config
  }

  async connect(opts: ConnectOpts): Promise<void> {
    const { sessionId, retries } = opts
    // This connect supersedes anything already running or scheduled for the id —
    // including a reattach ladder from a previous life of the same tab.
    this.cancelRedial(sessionId)
    const record: Redial = {
      opts,
      // Only a tmux-backed tab reattaches by itself: a plain shell has no state to
      // return to, so reconnecting it is the user's call (the overlay's button).
      reattachCommand: opts.tmux ? tmuxReattachCommand(opts.tmux) : null,
      cols: opts.cols,
      rows: opts.rows,
      attempt: 0,
      epoch: (this.epoch += 1)
    }
    this.redials.set(sessionId, record)
    const { epoch } = record

    let lastErr: any
    for (let attempt = 1; attempt <= Math.max(1, retries); attempt++) {
      if (!this.isCurrent(sessionId, epoch)) return
      this.emitStatus(sessionId, { kind: 'connecting', attempt, retries })
      try {
        await this.connectOnce(opts, epoch, false)
        return // ready; shell streaming begins via events
      } catch (err) {
        lastErr = err
        if (!this.isCurrent(sessionId, epoch)) return
        if (isPermanent(err)) {
          this.cancelRedial(sessionId)
          this.emitStatus(sessionId, {
            kind: 'error',
            message: String((err as any)?.message ?? err),
            permanent: true
          })
          return
        }
        if (attempt < retries) {
          let delay = Math.min(2 ** (attempt - 1), 8) * 1000
          delay += Math.random() * delay * 0.25 // jitter
          this.emitStatus(sessionId, {
            kind: 'retrying',
            attempt,
            retries,
            delayMs: Math.round(delay),
            error: String((err as any)?.message ?? err)
          })
          await sleep(delay)
        }
      }
    }
    // Out of dials without ever reaching a shell: drop the standing order too, or a
    // record with no timer and no session sits in the map until the tab is closed.
    this.cancelRedial(sessionId)
    this.emitStatus(sessionId, {
      kind: 'error',
      message: String(lastErr?.message ?? lastErr ?? 'Connection failed'),
      permanent: false
    })
  }

  /**
   * One dial. `epoch` is the Redial generation this attempt belongs to: if it is no
   * longer current the tab has been closed or reconnected under us, so the attempt
   * hangs up without registering a session or emitting a single status.
   * `auto` marks a rung of the reattach ladder, which reports readiness only once
   * the remote end proves the attach worked (see announceReady).
   */
  private connectOnce(opts: ConnectOpts, epoch: number, auto: boolean): Promise<void> {
    const { connection: c, sessionId } = opts
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      let session: Session | undefined
      const done = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      // Superseded: drop the connection and report neither success nor failure, so
      // the caller's retry/ladder logic stays out of the live session's way.
      const abandon = (): void => {
        try {
          client.end()
        } catch {
          /* ignore */
        }
        done(() => resolve())
      }

      const onShell = (err: Error | undefined, stream: ClientChannel | undefined): void => {
        // Unlike every other failure here, this one fires *after* a successful
        // handshake and auth (the server refused the channel or the pty-req), so
        // the socket is alive and nothing else holds a reference to it. Left open
        // it keeps pinging every keepalive, and since the error isn't permanent the
        // ladder dials again — one leaked authenticated connection per rung.
        if (err || !stream) {
          try {
            client.end()
          } catch {
            /* ignore */
          }
          return done(() => reject(err ?? new Error('No channel')))
        }
        if (!this.isCurrent(sessionId, epoch)) return abandon()
        const sess: Session = {
          client,
          stream,
          closed: false,
          auto,
          announced: false,
          sawStreamExit: false,
          exitCode: null,
          sawTmuxExit: false,
          tmuxExitReason: '',
          outputTail: Buffer.alloc(0)
        }
        session = sess

        // A reattach replaces a screen the user is still looking at, so it stays
        // quiet until the remote end proves it worked: an attach that fails (the
        // session was killed while we were away) exits non-zero within the same
        // moment, and announcing readiness first would flash a live terminal.
        const announceReady = (): void => {
          if (sess.announced || sess.closed) return
          sess.announced = true
          if (sess.readyTimer) {
            clearTimeout(sess.readyTimer)
            sess.readyTimer = undefined
          }
          sess.healthyAt = Date.now()
          this.emitStatus(sessionId, { kind: 'ready' })
        }

        if (opts.control) {
          // tmux control mode: the stream is a protocol channel, not raw terminal
          // bytes. The control client consumes stream data itself and re-emits
          // structured per-pane output + a window/pane model.
          const ctrl = new TmuxControlClient(stream, opts.cols, opts.rows)
          sess.control = ctrl
          // Control mode emits one %output line at a time; coalesce per pane so a
          // pane spewing output costs one IPC message per window, not per line.
          const perPane = new Map<string, ByteBatcher>()
          ctrl.on('paneOutput', (paneId: string, data: Buffer) => {
            announceReady()
            let batcher = perPane.get(paneId)
            if (!batcher) {
              batcher = new ByteBatcher((buf) => this.emit('tmux-output', sessionId, paneId, buf))
              perPane.set(paneId, batcher)
            }
            batcher.push(data)
          })
          sess.endOutput = () => {
            for (const batcher of perPane.values()) batcher.dispose()
            perPane.clear()
          }
          ctrl.on('state', (state) => {
            announceReady() // a window/pane model means the attach took
            this.emit('tmux-windows', sessionId, state)
          })
          ctrl.on('exit', (reason?: string) => {
            sess.sawTmuxExit = true
            sess.tmuxExitReason = reason ?? ''
            this.endSession(sessionId, sess)
          })
          // No output tail is kept in control mode. The bytes on this channel are
          // the `%…` protocol, not prose, and the reason a control client died
          // arrives as `%exit <reason>` on that protocol (handled above) — which is
          // strictly better evidence than scraped text. An attach that fails never
          // reaches control mode at all: tmux exits non-zero first, and the
          // exit-code path classifies that correctly with no tail.
          ctrl.start()
        } else {
          // Raw bytes, coalesced — never decoded here, so multi-byte UTF-8 that
          // straddles a chunk boundary reaches xterm intact.
          const out = new ByteBatcher((buf) => this.emit('data', sessionId, buf))
          stream.on('data', (d: Buffer) => {
            announceReady()
            // Under a pty this is where tmux's exit banner lands — "[detached (from
            // session x)]" vs "[exited]" vs "[lost server]" — and that banner is the
            // only thing distinguishing endings that share an exit status.
            this.noteTail(sess, d)
            out.push(d)
          })
          stream.stderr.on('data', (d: Buffer) => {
            // Normally never fires: a pty merges the child's fd 2 into the pty
            // master, so sshd has no separate stderr to forward. Kept for servers
            // that do keep one, where the same banner would arrive here instead.
            this.noteTail(sess, d)
            out.push(d)
          })
          sess.endOutput = () => out.dispose()
        }

        this.sessions.set(sessionId, sess)
        if (auto) sess.readyTimer = setTimeout(announceReady, AUTO_READY_FALLBACK_MS)
        else announceReady()

        stream.on('exit', (code: number | null, signal?: string) => {
          sess.sawStreamExit = true
          sess.exitCode = typeof code === 'number' ? code : null
          if (typeof signal === 'string') sess.exitSignal = signal
        })
        stream.on('close', () => this.endSession(sessionId, sess))
        done(() => resolve())
      }

      client.on('ready', () => {
        if (!this.isCurrent(sessionId, epoch)) return abandon()
        if (opts.command) {
          client.exec(
            opts.command,
            { pty: { term: 'xterm-256color', cols: opts.cols, rows: opts.rows } },
            onShell
          )
        } else {
          client.shell({ term: 'xterm-256color', cols: opts.cols, rows: opts.rows }, onShell)
        }
      })

      // Before the shell is up, a client error/close fails this connect attempt
      // (driving retry / permanent-error handling). Once it's up, the same events
      // mean the live session dropped — end the session so it is classified and
      // either reattached or surfaced in the overlay. We can't lean on the channel's
      // own 'close' alone: an abrupt drop (reset, keepalive timeout) can surface
      // only at the client level, and a clean detach leaves the client open unless
      // we end it. The message is kept as the reason shown to the user.
      client.on('error', (err) => {
        if (!settled) return done(() => reject(err))
        if (!session) return
        session.transportError = String((err as any)?.message ?? err)
        this.endSession(sessionId, session)
      })
      client.on('close', () => {
        if (!settled) return done(() => reject(new Error('Connection closed')))
        if (session) this.endSession(sessionId, session)
      })

      try {
        client.connect(
          this.baseConfig(c, opts.password, opts.passphrase, opts.timeoutMs, {
            unattended: opts.unattended,
            // Interactive sessions poll harder than the 15s default so a dead link
            // is noticed in ~15s instead of ~45s — the reattach can only start once
            // ssh2 has given up (keepaliveCountMax defaults to 3).
            keepaliveMs: 5000
          })
        )
      } catch (e) {
        done(() => reject(e))
      }
    })
  }

  /**
   * Keep the last {@link TAIL_BYTES} of what a command printed; tmux's exit banner
   * lives there. Runs on every chunk of a live terminal, so it never grows or
   * decodes anything: a chunk that already fills the window replaces it outright
   * and the concat path is bounded by the window size.
   */
  private noteTail(session: Session, chunk: Buffer): void {
    if (chunk.length >= TAIL_BYTES) {
      session.outputTail = Buffer.from(chunk.subarray(chunk.length - TAIL_BYTES))
      return
    }
    const merged = Buffer.concat([session.outputTail, chunk])
    session.outputTail =
      merged.length > TAIL_BYTES ? merged.subarray(merged.length - TAIL_BYTES) : merged
  }

  /**
   * The tail as text, with escape sequences removed. tmux restores the terminal as
   * it exits, so the banner arrives wrapped in resets that would otherwise break a
   * match; decoding is deferred to here because this runs once, as a session dies.
   */
  private tailText(session: Session): string {
    return session.outputTail.toString('utf-8').replace(ANSI_RE, '')
  }

  /** Whole-operation ceiling for a one-shot command when the caller sets none. */
  private static readonly EXEC_DEADLINE_MS = 20000

  /**
   * Most output one command may produce before we give up on it.
   *
   * Every caller of exec() parses a short, known-shaped reply; none of them
   * stream. A remote that answers with gigabytes would otherwise be accumulated
   * whole in the main process. Exceeding it *fails* rather than truncating —
   * a half-read `key=value` probe parses cleanly into wrong values, which is
   * worse than an error the UI can show.
   */
  private static readonly EXEC_MAX_BYTES = 1_000_000

  /** One-shot command: connect, run, collect output, disconnect. */
  exec(connection: Connection, opts: ExecOpts): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const deadline = opts.deadlineMs ?? SshManager.EXEC_DEADLINE_MS
      // Cleared on every exit path: a pending timer would hold the event loop
      // open and then fire against an already-settled promise.
      let timer: NodeJS.Timeout | undefined
      const fail = (e: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          client.end()
          // The deadline case is a connection that is *not* answering, where a
          // polite disconnect can itself hang. destroy() drops the socket.
          client.destroy()
        } catch {
          /* ignore */
        }
        reject(e)
      }
      timer = setTimeout(
        () => fail(new Error(`Command timed out after ${Math.round(deadline / 1000)}s`)),
        deadline
      )
      client.on('ready', () => {
        client.exec(opts.command, (err, stream) => {
          if (err) return fail(err)
          let stdout = ''
          let stderr = ''
          const take = (d: Buffer, to: 'out' | 'err'): void => {
            if (settled) return
            if (to === 'out') stdout += d.toString('utf-8')
            else stderr += d.toString('utf-8')
            if (stdout.length + stderr.length > SshManager.EXEC_MAX_BYTES) {
              fail(new Error('Command produced far more output than expected'))
            }
          }
          stream.on('data', (d: Buffer) => take(d, 'out'))
          stream.stderr.on('data', (d: Buffer) => take(d, 'err'))
          stream.on('close', (code: number | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            client.end()
            resolve({ code, stdout, stderr })
          })
        })
      })
      client.on('error', (err) => fail(err))
      try {
        client.connect(this.baseConfig(connection, opts.password, opts.passphrase, opts.timeoutMs))
      } catch (e) {
        fail(e)
      }
    })
  }

  // ---- SFTP ----

  /** How long an idle SFTP channel stays open after its last release. */
  private static readonly SFTP_GRACE_MS = 30000

  /** Acquire the connection's shared SFTP channel (connecting once, reusing after). */
  async openSftp(
    key: string,
    connection: Connection,
    password: string | undefined,
    passphrase: string | undefined,
    timeoutMs?: number
  ): Promise<void> {
    const existing = this.sftpPool.get(key)
    if (existing) {
      existing.refs++
      if (existing.closeTimer) {
        clearTimeout(existing.closeTimer)
        existing.closeTimer = undefined
      }
      return
    }
    // Coalesce concurrent opens (e.g. file manager + an editor tab at once).
    const inflight = this.sftpConnecting.get(key)
    if (inflight) {
      await inflight
      const s = this.sftpPool.get(key)
      if (!s) throw new Error('SFTP channel failed to open')
      s.refs++
      return
    }
    const p = this.connectSftp(key, connection, password, passphrase, timeoutMs)
    this.sftpConnecting.set(key, p)
    try {
      await p
    } finally {
      this.sftpConnecting.delete(key)
    }
    const s = this.sftpPool.get(key)
    if (!s) throw new Error('SFTP channel failed to open')
    s.refs++
  }

  private connectSftp(
    key: string,
    connection: Connection,
    password: string | undefined,
    passphrase: string | undefined,
    timeoutMs?: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const fail = (e: unknown): void => {
        if (settled) return
        settled = true
        try {
          client.end()
        } catch {
          /* ignore */
        }
        reject(e)
      }
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err || !sftp) return fail(err ?? new Error('SFTP unavailable'))
          this.sftpPool.set(key, { client, sftp, refs: 0 })
          settled = true
          resolve()
        })
      })
      client.on('error', (err) => fail(err))
      client.on('close', () => {
        this.sftpPool.delete(key)
        if (!settled) fail(new Error('Connection closed'))
      })
      try {
        client.connect(this.baseConfig(connection, password, passphrase, timeoutMs))
      } catch (e) {
        fail(e)
      }
    })
  }

  private sftpOf(key: string): SFTPWrapper {
    const s = this.sftpPool.get(key)
    if (!s) throw new Error('SFTP session is not open')
    return s.sftp
  }

  private realpath(sftp: SFTPWrapper, p: string): Promise<string> {
    return new Promise((res, rej) => sftp.realpath(p || '.', (e, abs) => (e ? rej(e) : res(abs))))
  }
  private readdir(sftp: SFTPWrapper, p: string): Promise<{ filename: string; attrs: Stats }[]> {
    return new Promise((res, rej) => sftp.readdir(p, (e, list) => (e ? rej(e) : res(list as any))))
  }

  async sftpRealpath(id: string, p: string): Promise<string> {
    return this.realpath(this.sftpOf(id), p)
  }

  async sftpList(id: string, dir: string): Promise<SftpList> {
    const sftp = this.sftpOf(id)
    const path = await this.realpath(sftp, dir || '.')
    const list = await this.readdir(sftp, path)
    const entries: SftpEntry[] = list.map((it) => {
      const a = it.attrs
      return {
        name: it.filename,
        path: joinPath(path, it.filename),
        type: entryType(a),
        size: a.size ?? 0,
        mtime: (a.mtime ?? 0) * 1000,
        mode: a.mode ?? 0,
        permissions: permString(a.mode ?? 0),
        isSymlink: a.isSymbolicLink()
      }
    })
    // Resolve symlink targets so the UI can treat dir-links as navigable.
    await Promise.all(
      entries
        .filter((e) => e.isSymlink)
        .map(async (e) => {
          try {
            const st = await new Promise<Stats>((res, rej) =>
              sftp.stat(e.path, (er, s) => (er ? rej(er) : res(s)))
            )
            e.target = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other'
          } catch {
            /* dangling symlink — leave target undefined */
          }
        })
    )
    return { path, entries }
  }

  sftpMkdir(id: string, p: string): Promise<void> {
    const sftp = this.sftpOf(id)
    return new Promise((res, rej) => sftp.mkdir(p, (e) => (e ? rej(e) : res())))
  }

  /**
   * `mkdir -p` with a mode: create every missing parent, and treat "it's already
   * there" as success. SFTP has no recursive mkdir, so this walks the path.
   *
   * Already-exists is the *normal* case for a staging directory, not an error,
   * and it can't be detected from the status code alone — servers disagree on
   * whether EEXIST is FAILURE or PERMISSION_DENIED — so a failed mkdir is
   * re-checked with a stat and only rejected when there's really no directory
   * there. The mode is set at creation rather than chmod'd afterwards: a chmod
   * leaves a window where the directory exists group/world-readable.
   */
  async sftpEnsureDir(id: string, p: string, mode?: number): Promise<void> {
    const sftp = this.sftpOf(id)
    const attrs = mode === undefined ? {} : { mode }
    let cur = p.startsWith('/') ? '' : '.'
    for (const part of p.split('/').filter(Boolean)) {
      cur = `${cur}/${part}`
      const at = cur
      await new Promise<void>((res, rej) =>
        sftp.mkdir(at, attrs, (e) => {
          if (!e) return res()
          sftp.stat(at, (se, st) => (!se && st.isDirectory() ? res() : rej(e)))
        })
      )
    }
  }

  sftpRename(id: string, from: string, to: string): Promise<void> {
    const sftp = this.sftpOf(id)
    return new Promise((res, rej) => sftp.rename(from, to, (e) => (e ? rej(e) : res())))
  }

  sftpChmod(id: string, p: string, mode: number): Promise<void> {
    const sftp = this.sftpOf(id)
    return new Promise((res, rej) => sftp.chmod(p, mode, (e) => (e ? rej(e) : res())))
  }

  /** Delete a file, or recursively delete a directory. */
  async sftpDelete(id: string, p: string, isDir: boolean): Promise<void> {
    const sftp = this.sftpOf(id)
    if (!isDir) {
      await new Promise<void>((res, rej) => sftp.unlink(p, (e) => (e ? rej(e) : res())))
      return
    }
    const list = await this.readdir(sftp, p)
    for (const it of list) {
      const child = joinPath(p, it.filename)
      if (it.attrs.isDirectory()) await this.sftpDelete(id, child, true)
      else await new Promise<void>((res, rej) => sftp.unlink(child, (e) => (e ? rej(e) : res())))
    }
    await new Promise<void>((res, rej) => sftp.rmdir(p, (e) => (e ? rej(e) : res())))
  }

  async sftpReadFile(key: string, p: string): Promise<SftpReadResult> {
    const sftp = this.sftpOf(key)
    const st = await new Promise<Stats>((res, rej) => sftp.stat(p, (e, s) => (e ? rej(e) : res(s))))
    const size = st.size ?? 0
    if (size > MAX_OPEN_BYTES) {
      throw new Error(
        `File is too large to open in-app (> ${MAX_OPEN_BYTES / 1024 / 1024} MB). Download it instead.`
      )
    }
    const content = await new Promise<string>((res, rej) =>
      sftp.readFile(p, (e, buf) => (e ? rej(e) : res(buf.toString('utf-8'))))
    )
    return { content, readOnly: size > MAX_EDIT_BYTES }
  }

  sftpWriteFile(id: string, p: string, content: string): Promise<void> {
    const sftp = this.sftpOf(id)
    return new Promise((res, rej) =>
      sftp.writeFile(p, content, { encoding: 'utf-8' }, (e) => (e ? rej(e) : res()))
    )
  }

  /**
   * Replace a file's contents without ever leaving it truncated.
   *
   * `sftpWriteFile` opens the real path with `w`, so a connection that drops
   * mid-write leaves the file half-written — acceptable for a document the user
   * is editing and watching, not for a config file we rewrite on their behalf.
   * Write a sibling temp and move it into place instead, so the destination only
   * ever holds the old bytes or the new ones.
   */
  async sftpWriteFileAtomic(id: string, p: string, content: string, mode?: number): Promise<void> {
    const sftp = this.sftpOf(id)
    const tmp = `${p}.${randomUUID().slice(0, 8)}.tmp`
    await new Promise<void>((res, rej) =>
      sftp.writeFile(
        tmp,
        content,
        { encoding: 'utf-8', ...(mode === undefined ? {} : { mode }) },
        (e) => (e ? rej(e) : res())
      )
    )
    try {
      // OpenSSH's posix-rename overwrites atomically, which is the whole point.
      // It throws *synchronously* when the server never advertised the extension,
      // so it has to be called outside the executor — inside, the Promise
      // constructor would convert that throw into a rejection indistinguishable
      // from the rename itself failing, and we'd fall back for the wrong reason.
      let posix: Promise<void> | null = null
      try {
        let settle!: (e?: Error) => void
        const done = new Promise<void>((res, rej) => {
          settle = (e) => (e ? rej(e) : res())
        })
        sftp.ext_openssh_rename(tmp, p, (e) => settle(e ?? undefined))
        posix = done
      } catch {
        posix = null // no posix-rename@openssh.com on this server
      }
      if (posix) return await posix

      // Plain SFTP rename refuses an existing destination — SFTPv3 RENAME has no
      // overwrite flag — so the old file has to move first. It moves *aside*
      // rather than away: unlinking it means a link dropped between the two calls
      // destroys the user's settings outright, which is strictly worse than the
      // truncation this function exists to prevent. A rename leaves the bytes
      // readable under some name at every instant, and lets a failed second
      // rename put them back.
      const aside = `${p}.${randomUUID().slice(0, 8)}.bak`
      let moved = false
      await new Promise<void>((res) =>
        sftp.rename(p, aside, (e) => {
          moved = !e // failing here is usually "no file yet", which is fine
          res()
        })
      )
      try {
        await new Promise<void>((res, rej) => sftp.rename(tmp, p, (e) => (e ? rej(e) : res())))
      } catch (e) {
        if (moved) {
          const back = await new Promise<boolean>((res) => sftp.rename(aside, p, (e2) => res(!e2)))
          // Both renames failed and there is nothing left to try. Say where the
          // old contents went — otherwise, to the user, they are simply gone.
          if (!back) {
            const why = e instanceof Error ? e.message : String(e)
            throw new Error(`${why} — previous contents left at ${aside}`)
          }
        }
        throw e
      }
      if (moved) await new Promise<void>((res) => sftp.unlink(aside, () => res()))
    } catch (e) {
      await new Promise<void>((res) => sftp.unlink(tmp, () => res()))
      throw e
    }
  }

  private emitTransfer(
    transferId: string,
    kind: 'upload' | 'download',
    name: string,
    transferred: number,
    total: number,
    done: boolean,
    error?: string
  ): void {
    this.emit('sftp-progress', { transferId, kind, name, transferred, total, done, error })
  }

  sftpDownload(id: string, remote: string, local: string, transferId: string, name: string): Promise<void> {
    const sftp = this.sftpOf(id)
    return new Promise((res, rej) => {
      let last = 0
      sftp.fastGet(
        remote,
        local,
        {
          step: (transferred: number, _chunk: number, total: number) => {
            const now = Date.now()
            if (now - last > 100 || transferred >= total) {
              last = now
              this.emitTransfer(transferId, 'download', name, transferred, total, false)
            }
          }
        },
        (err) => {
          if (err) {
            this.emitTransfer(transferId, 'download', name, 0, 0, true, String(err.message ?? err))
            rej(err)
          } else {
            this.emitTransfer(transferId, 'download', name, 1, 1, true)
            res()
          }
        }
      )
    })
  }

  /**
   * `mode` sets the remote file's permissions as it is created. Left undefined
   * the server applies the account's umask, which is right for a file the user
   * dropped into a directory they chose; staged uploads pass it explicitly so
   * the file is never briefly readable by everyone on a shared host.
   */
  sftpUpload(
    id: string,
    local: string,
    remote: string,
    transferId: string,
    name: string,
    mode?: number
  ): Promise<void> {
    const sftp = this.sftpOf(id)
    return new Promise((res, rej) => {
      let last = 0
      sftp.fastPut(
        local,
        remote,
        {
          ...(mode === undefined ? {} : { mode }),
          step: (transferred: number, _chunk: number, total: number) => {
            const now = Date.now()
            if (now - last > 100 || transferred >= total) {
              last = now
              this.emitTransfer(transferId, 'upload', name, transferred, total, false)
            }
          }
        },
        (err) => {
          if (err) {
            this.emitTransfer(transferId, 'upload', name, 0, 0, true, String(err.message ?? err))
            rej(err)
          } else {
            this.emitTransfer(transferId, 'upload', name, 1, 1, true)
            res()
          }
        }
      )
    })
  }

  /** Release one reference; the channel closes after a grace period at zero. */
  closeSftp(key: string): void {
    const s = this.sftpPool.get(key)
    if (!s) return
    s.refs = Math.max(0, s.refs - 1)
    if (s.refs > 0) return
    if (s.closeTimer) clearTimeout(s.closeTimer)
    s.closeTimer = setTimeout(() => {
      const cur = this.sftpPool.get(key)
      if (!cur || cur.refs > 0) return
      try {
        cur.client.end()
      } catch {
        /* ignore */
      }
      this.sftpPool.delete(key)
    }, SshManager.SFTP_GRACE_MS)
  }

  // ---- Port forwarding / tunnels ----

  private emitTunnel(rt: RunningTunnel): void {
    const status: TunnelStatus = {
      defId: rt.def.id,
      connectionId: rt.connectionId,
      state: rt.state,
      error: rt.error,
      conns: rt.sockets.size
    }
    this.emit('tunnel-status', status)
  }

  /** Snapshot of every currently-tracked tunnel (for renderer reconciliation). */
  tunnelStatuses(): TunnelStatus[] {
    return [...this.tunnels.values()].map((rt) => ({
      defId: rt.def.id,
      connectionId: rt.connectionId,
      state: rt.state,
      error: rt.error,
      conns: rt.sockets.size
    }))
  }

  /** Open a tunnel on its own SSH client. Idempotent per def id. */
  startTunnel(
    connectionId: string,
    def: TunnelDef,
    connection: Connection,
    password: string | undefined,
    passphrase: string | undefined,
    timeoutMs?: number
  ): void {
    if (this.tunnels.has(def.id)) return // already running
    const client = new Client()
    const rt: RunningTunnel = { def, connectionId, client, sockets: new Set(), state: 'starting' }
    this.tunnels.set(def.id, rt)
    this.emitTunnel(rt)

    const fail = (msg: string): void => {
      if (rt.state === 'stopped') return
      rt.state = 'error'
      rt.error = msg
      this.emitTunnel(rt)
      this.teardownTunnel(rt)
      try {
        client.end()
      } catch {
        /* ignore */
      }
      this.tunnels.delete(def.id)
    }

    client.on('ready', () => {
      if (def.type === 'remote') {
        client.forwardIn(def.bindAddr || '127.0.0.1', def.bindPort, (err) => {
          if (err) return fail(`Remote bind failed: ${err.message}`)
          rt.state = 'active'
          this.emitTunnel(rt)
        })
      } else {
        const server = createServer((socket) => this.onTunnelSocket(rt, socket))
        rt.server = server
        server.on('error', (err) => fail(String((err as Error)?.message ?? err)))
        server.listen(def.bindPort, def.bindAddr || '127.0.0.1', () => {
          rt.state = 'active'
          this.emitTunnel(rt)
        })
      }
    })

    // Incoming connections for a remote (-R) forward.
    client.on('tcp connection', (_info, accept, reject) => {
      if (def.type !== 'remote') return reject()
      const stream = accept()
      const local = netConnect(def.dstPort ?? 0, def.dstHost || '127.0.0.1')
      local.on('connect', () => this.pipePair(rt, stream as unknown as Socket, local))
      local.on('error', () => {
        try {
          stream.close()
        } catch {
          /* ignore */
        }
      })
    })

    client.on('error', (err) => fail(String((err as Error)?.message ?? err)))
    client.on('close', () => {
      if (rt.state !== 'error' && rt.state !== 'stopped') {
        rt.state = 'stopped'
        this.emitTunnel(rt)
      }
      this.teardownTunnel(rt)
      this.tunnels.delete(def.id)
    })

    try {
      client.connect(this.baseConfig(connection, password, passphrase, timeoutMs))
    } catch (e) {
      fail(String((e as Error)?.message ?? e))
    }
  }

  /** Handle one inbound connection to a local (-L) or dynamic (-D) listener. */
  private onTunnelSocket(rt: RunningTunnel, socket: Socket): void {
    if (rt.def.type === 'dynamic') return this.handleSocks(rt, socket)
    const { dstHost, dstPort } = rt.def
    rt.client.forwardOut(
      socket.remoteAddress || '127.0.0.1',
      socket.remotePort || 0,
      dstHost || '127.0.0.1',
      dstPort ?? 0,
      (err, stream) => {
        if (err || !stream) {
          socket.destroy()
          return
        }
        this.pipePair(rt, stream as unknown as Socket, socket)
      }
    )
    socket.on('error', () => socket.destroy())
  }

  /** Minimal SOCKS5 (no-auth, CONNECT only) front-end for a dynamic (-D) tunnel. */
  private handleSocks(rt: RunningTunnel, socket: Socket): void {
    let stage: 'greeting' | 'request' = 'greeting'
    let buf = Buffer.alloc(0)

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])

      if (stage === 'greeting') {
        if (buf.length < 2) return
        const nmethods = buf[1]
        if (buf.length < 2 + nmethods) return
        buf = buf.subarray(2 + nmethods)
        socket.write(Buffer.from([0x05, 0x00])) // version 5, no authentication
        stage = 'request'
      }

      if (stage === 'request') {
        if (buf.length < 4) return
        if (buf[0] !== 0x05) {
          socket.destroy()
          return
        }
        const cmd = buf[1]
        const atyp = buf[3]
        let host: string
        let offset: number
        if (atyp === 0x01) {
          if (buf.length < 10) return
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          const len = buf[4]
          if (buf.length < 5 + len + 2) return
          host = buf.subarray(5, 5 + len).toString('utf-8')
          offset = 5 + len
        } else if (atyp === 0x04) {
          if (buf.length < 22) return
          const parts: string[] = []
          for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
          host = parts.join(':')
          offset = 20
        } else {
          socket.destroy()
          return
        }
        const port = buf.readUInt16BE(offset)
        const leftover = buf.subarray(offset + 2)
        socket.removeListener('data', onData)

        const reply = (code: number): Buffer =>
          Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])

        if (cmd !== 0x01) {
          // only CONNECT is supported
          socket.write(reply(0x07))
          socket.destroy()
          return
        }
        rt.client.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          host,
          port,
          (err, stream) => {
            if (err || !stream) {
              socket.write(reply(0x05)) // connection refused
              socket.destroy()
              return
            }
            socket.write(reply(0x00)) // success
            if (leftover.length) stream.write(leftover)
            this.pipePair(rt, stream as unknown as Socket, socket)
          }
        )
      }
    }

    socket.on('data', onData)
    socket.on('error', () => socket.destroy())
  }

  /** Wire a forwarded SSH channel to a local socket and track the live count. */
  private pipePair(rt: RunningTunnel, stream: Socket, socket: Socket): void {
    rt.sockets.add(socket)
    this.emitTunnel(rt)
    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      if (rt.sockets.delete(socket)) this.emitTunnel(rt)
      try {
        stream.destroy()
      } catch {
        /* ignore */
      }
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    socket.on('error', cleanup)
    socket.on('close', cleanup)
    stream.on('error', cleanup)
    stream.on('close', cleanup)
    socket.pipe(stream)
    stream.pipe(socket)
  }

  /** Close a tunnel's listener + live sockets without ending its SSH client. */
  private teardownTunnel(rt: RunningTunnel): void {
    try {
      rt.server?.close()
    } catch {
      /* ignore */
    }
    rt.server = undefined
    for (const s of rt.sockets) {
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
    }
    rt.sockets.clear()
  }

  stopTunnel(defId: string): void {
    const rt = this.tunnels.get(defId)
    if (!rt) return
    rt.state = 'stopped'
    this.teardownTunnel(rt)
    try {
      rt.client.end()
    } catch {
      /* ignore */
    }
    this.tunnels.delete(defId)
    this.emit('tunnel-status', {
      defId,
      connectionId: rt.connectionId,
      state: 'stopped',
      conns: 0
    } satisfies TunnelStatus)
  }

  /** Stop every tunnel belonging to a connection (e.g. on its deletion). */
  stopTunnelsForConnection(connectionId: string): void {
    for (const rt of [...this.tunnels.values()]) {
      if (rt.connectionId === connectionId) this.stopTunnel(rt.def.id)
    }
  }

  resolveHostKey(requestId: string, accept: boolean): void {
    const pending = this.pendingHostKeys.get(requestId)
    if (!pending) return
    this.pendingHostKeys.delete(requestId)
    if (accept) knownHosts.trust(pending.host, pending.port, pending.key)
    pending.cb(accept)
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.control) return // control sessions route input through tmuxSendKeys
    s.stream?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    // Record first, unconditionally: a resize that lands while the session is down
    // (the pane is still on screen, the window can still be dragged) is what makes
    // the reattach come up at the size the user is now looking at.
    const r = this.redials.get(sessionId)
    if (r) {
      r.cols = cols
      r.rows = rows
    }
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (s.control) s.control.resize(cols, rows)
    else s.stream?.setWindow(rows, cols, 0, 0)
  }

  // ---- tmux control-mode actions (no-ops on a non-control session) ----
  tmuxSendKeys(sessionId: string, paneId: string, data: string): void {
    this.sessions.get(sessionId)?.control?.sendKeys(paneId, data)
  }
  tmuxSelectWindow(sessionId: string, windowId: string): void {
    this.sessions.get(sessionId)?.control?.selectWindow(windowId)
  }
  tmuxSelectPane(sessionId: string, paneId: string): void {
    this.sessions.get(sessionId)?.control?.selectPane(paneId)
  }
  tmuxNewWindow(sessionId: string): void {
    this.sessions.get(sessionId)?.control?.newWindow()
  }
  tmuxSplitPane(sessionId: string, paneId: string, direction: 'columns' | 'rows'): void {
    this.sessions.get(sessionId)?.control?.splitPane(paneId, direction)
  }
  tmuxKillPane(sessionId: string, paneId: string): void {
    this.sessions.get(sessionId)?.control?.killPane(paneId)
  }

  /** True while `epoch` is still the live generation for this session id. */
  private isCurrent(sessionId: string, epoch: number): boolean {
    return this.redials.get(sessionId)?.epoch === epoch
  }

  /**
   * Forget the standing order to reattach. Any dial still in flight for the old
   * epoch goes quiet the moment it notices, so this is enough to cancel work that
   * has not reached a timer yet.
   */
  private cancelRedial(sessionId: string): void {
    const r = this.redials.get(sessionId)
    if (!r) return
    if (r.timer) clearTimeout(r.timer)
    this.redials.delete(sessionId)
  }

  /** The most specific thing we can tell the user about why the session dropped. */
  private detailOf(session: Session): string {
    const printed = this.tailText(session).trim().split('\n').filter(Boolean).pop()
    return session.transportError || printed || session.tmuxExitReason || 'Connection lost'
  }

  /** Put the session on the next rung: announce the wait, then dial when it elapses. */
  private scheduleReattach(sessionId: string, record: Redial, error: string): void {
    const delayMs = withJitter(ladderDelay(record.attempt))
    record.attempt += 1
    this.emitStatus(sessionId, {
      kind: 'reattaching',
      attempt: record.attempt,
      delayMs,
      error
    })
    record.timer = setTimeout(() => {
      record.timer = undefined
      if (this.redials.get(sessionId) !== record) return
      const opts: ConnectOpts = {
        ...record.opts,
        cols: record.cols,
        rows: record.rows,
        // Attach-only. Never record.opts.command — that one creates on miss.
        command: record.reattachCommand!,
        // The ladder *is* the retry loop; an inner one would stack delays and its
        // own terminal 'error' would drop the user onto the blocking overlay.
        retries: 1,
        timeoutMs: REATTACH_DIAL_TIMEOUT_MS,
        unattended: true
      }
      void this.connectOnce(opts, record.epoch, true).catch((err) => {
        if (this.redials.get(sessionId) !== record) return
        const message = String((err as any)?.message ?? err)
        // Auth or a changed host key won't fix itself — stop and say so.
        if (isPermanent(err)) {
          this.cancelRedial(sessionId)
          this.emitStatus(sessionId, { kind: 'error', message, permanent: true })
          return
        }
        // The host is still unreachable: straight back onto the ladder, silently.
        this.scheduleReattach(sessionId, record, message)
      })
    }, delayMs)
  }

  close(sessionId: string): void {
    // Cancel first, and unconditionally: a session in the middle of the reattach
    // ladder has no entry in `sessions` at all, so closing its tab has to reach the
    // standing order rather than the (absent) live session.
    this.cancelRedial(sessionId)
    const s = this.sessions.get(sessionId)
    if (s) this.endSession(sessionId, s, true)
  }

  /** The banner's Stop button: give up reattaching and show the manual overlay. */
  stopReattach(sessionId: string): void {
    if (!this.redials.has(sessionId)) return
    this.cancelRedial(sessionId)
    // A rung may have already connected: an auto dial registers its session but
    // holds 'ready' back until the remote proves the attach worked, so the banner
    // (and its Stop button) is still on screen over a link that is actually up.
    // Tearing it down here is what makes Stop mean stop — otherwise the ssh2
    // client stays authenticated and, because the ladder attaches with `-d`, keeps
    // the tmux session held open, and the deferred 'ready' fires *after* our
    // 'closed' and silently undoes the user's click.
    const live = this.sessions.get(sessionId)
    if (live) this.endSession(sessionId, live, true)
    this.emitStatus(sessionId, {
      kind: 'closed',
      code: null,
      reason: 'unreachable',
      detail: 'Stopped reconnecting.'
    })
  }

  /**
   * Tear a session down exactly once, and decide what happens next — this is the
   * only place a session's final status is emitted, so a drop cannot flash 'closed'
   * on its way to being reattached.
   *
   * Emits exactly one of: nothing (the user closed the tab, or this session was
   * already replaced), 'reattaching' (the ladder took it), or 'closed'.
   */
  private endSession(sessionId: string, session: Session, userInitiated = false): void {
    if (session.closed) return
    session.closed = true
    if (session.readyTimer) clearTimeout(session.readyTimer)
    // Flush buffered output before the status, so a shell's parting bytes are
    // written to the terminal ahead of the "session closed" notice.
    try {
      session.endOutput?.()
    } catch {
      /* ignore */
    }

    // A late event from a session that has already been replaced under this id must
    // not speak for the live one — not even to report its own death.
    const current = this.sessions.get(sessionId) === session
    if (current) this.sessions.delete(sessionId)

    const record = current && !userInitiated ? this.redials.get(sessionId) : undefined
    if (record) {
      // A long healthy run means this is a fresh outage, not a failing ladder, so
      // the next attempt starts back at one second.
      if (session.healthyAt && Date.now() - session.healthyAt >= HEALTHY_RESET_MS) {
        record.attempt = 0
      }
      const verdict = classifyDrop({
        tmuxBacked: !!record.opts.tmux,
        sawTmuxExit: session.sawTmuxExit,
        tmuxExitReason: session.tmuxExitReason,
        sawStreamExit: session.sawStreamExit,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        outputTail: this.tailText(session)
      })
      if (verdict.action === 'reattach' && record.reattachCommand) {
        this.scheduleReattach(sessionId, record, this.detailOf(session))
      } else {
        this.cancelRedial(sessionId)
        this.emitStatus(sessionId, {
          kind: 'closed',
          code: session.exitCode,
          // 'reattach' with nothing to reattach to (a plain shell, or a name tmux
          // can't target): the link died, so leave the door open for a manual retry.
          reason: verdict.action === 'stop' ? verdict.reason : 'unreachable',
          detail: this.detailOf(session)
        })
      }
    } else if (current && !userInitiated) {
      this.emitStatus(sessionId, { kind: 'closed', code: session.exitCode })
    }

    try {
      session.control?.dispose()
    } catch {
      /* ignore */
    }
    try {
      session.stream?.end()
    } catch {
      /* ignore */
    }
    try {
      session.client.end()
    } catch {
      /* ignore */
    }
  }

  closeAll(): void {
    for (const id of [...this.tunnels.keys()]) this.stopTunnel(id)
    // Sessions waiting on a reattach rung aren't in `sessions` at all, so close the
    // union of both maps or their timers keep the app alive after the last window.
    for (const id of new Set([...this.redials.keys(), ...this.sessions.keys()])) this.close(id)
    for (const [, s] of this.sftpPool) {
      if (s.closeTimer) clearTimeout(s.closeTimer)
      try {
        s.client.end()
      } catch {
        /* ignore */
      }
    }
    this.sftpPool.clear()
  }
}
