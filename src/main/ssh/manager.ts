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
  TunnelDef,
  TunnelState,
  TunnelStatus
} from '../../shared/types'
import { knownHosts } from './knownHosts'

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
}

interface ExecOpts {
  password?: string
  passphrase?: string
  command: string
  timeoutMs?: number
}

interface Session {
  client: Client
  stream?: ClientChannel
  closed: boolean
}

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
    timeoutMs: number | undefined
  ): ConnectConfig {
    const config: ConnectConfig = {
      host: c.host,
      port: c.port || 22,
      username: c.username,
      readyTimeout: timeoutMs ?? 30000,
      keepaliveInterval: 15000,
      hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
        const res = knownHosts.verify(c.host, c.port || 22, key)
        if (res.status === 'known') return verify(true)
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
    let lastErr: any
    for (let attempt = 1; attempt <= Math.max(1, retries); attempt++) {
      this.emitStatus(sessionId, { kind: 'connecting', attempt, retries })
      try {
        await this.connectOnce(opts)
        return // ready; shell streaming begins via events
      } catch (err) {
        lastErr = err
        if (isPermanent(err)) {
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
    this.emitStatus(sessionId, {
      kind: 'error',
      message: String(lastErr?.message ?? lastErr ?? 'Connection failed'),
      permanent: false
    })
  }

  private connectOnce(opts: ConnectOpts): Promise<void> {
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

      const onShell = (err: Error | undefined, stream: ClientChannel | undefined): void => {
        if (err || !stream) return done(() => reject(err ?? new Error('No channel')))
        const sess: Session = { client, stream, closed: false }
        session = sess
        this.sessions.set(sessionId, sess)
        this.emitStatus(sessionId, { kind: 'ready' })

        let exitCode: number | null = null
        stream.on('data', (d: Buffer) => this.emit('data', sessionId, d.toString('utf-8')))
        stream.stderr.on('data', (d: Buffer) => this.emit('data', sessionId, d.toString('utf-8')))
        stream.on('exit', (code: number | null) => {
          exitCode = code
        })
        stream.on('close', () => this.endSession(sessionId, sess, { kind: 'closed', code: exitCode }))
        done(() => resolve())
      }

      client.on('ready', () => {
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
      // mean the live session dropped — surface it as 'closed' so the UI shows the
      // reattach/reconnect overlay. We can't lean on the channel's own 'close'
      // alone: an abrupt drop (reset, keepalive timeout) can surface only at the
      // client level, and a clean detach leaves the client open unless we end it.
      client.on('error', (err) => {
        if (!settled) return done(() => reject(err))
        if (session) this.endSession(sessionId, session, { kind: 'closed', code: null })
      })
      client.on('close', () => {
        if (!settled) return done(() => reject(new Error('Connection closed')))
        if (session) this.endSession(sessionId, session, { kind: 'closed', code: null })
      })

      try {
        client.connect(this.baseConfig(c, opts.password, opts.passphrase, opts.timeoutMs))
      } catch (e) {
        done(() => reject(e))
      }
    })
  }

  /** One-shot command: connect, run, collect output, disconnect. */
  exec(connection: Connection, opts: ExecOpts): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const fail = (e: unknown) => {
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
        client.exec(opts.command, (err, stream) => {
          if (err) return fail(err)
          let stdout = ''
          let stderr = ''
          stream.on('data', (d: Buffer) => (stdout += d.toString('utf-8')))
          stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')))
          stream.on('close', (code: number | null) => {
            if (settled) return
            settled = true
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

  sftpUpload(id: string, local: string, remote: string, transferId: string, name: string): Promise<void> {
    const sftp = this.sftpOf(id)
    return new Promise((res, rej) => {
      let last = 0
      sftp.fastPut(
        local,
        remote,
        {
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
    this.sessions.get(sessionId)?.stream?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0)
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) this.endSession(sessionId, s)
  }

  /**
   * Tear a session down exactly once: emit a final status (if any), end its SSH
   * client so the connection isn't leaked (a clean tmux detach closes only the
   * channel, not the client), and drop it from the map. The map-identity guard
   * stops a late event from a replaced session disturbing a newer one that has
   * reconnected under the same id.
   */
  private endSession(sessionId: string, session: Session, status?: SessionStatus): void {
    if (session.closed) return
    session.closed = true
    if (status) this.emitStatus(sessionId, status)
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
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
  }

  closeAll(): void {
    for (const id of [...this.tunnels.keys()]) this.stopTunnel(id)
    for (const id of [...this.sessions.keys()]) this.close(id)
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
