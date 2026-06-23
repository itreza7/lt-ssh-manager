// tmux control-mode (`tmux -CC`) client.
//
// In control mode tmux does NOT draw a screen — it speaks a line-based protocol
// over stdout and accepts tmux commands on stdin. We parse that protocol here and
// expose per-pane output plus a structured window/pane model, so the renderer can
// draw each pane as its own xterm (native scrollback, native copy, no mouse mode).
//
// Protocol essentials (see tmux(1) "CONTROL MODE"):
//   %output %<pane> <data>     pane bytes, octal-escaped (\\ooo for \\ and non-print)
//   %begin/%end/%error ...     wrap the reply to a command we sent on stdin
//   %window-add/-close/-renamed, %layout-change, %window-pane-changed
//   %session-changed/-window-changed, %sessions-changed
//   %exit [reason]             control mode ending
//
// Commands we send (all single lines):
//   send-keys -t %<pane> -H <hex...>     forward keystrokes
//   refresh-client -C <w>x<h>            set this client's size (drives layout)
//   select-window -t @<win> / select-pane -t %<pane>
//   list-windows / list-panes            re-sync structure
import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import type { TmuxControlState, TmuxPaneRect, TmuxWindowInfo } from '../../shared/types'

const LF = 0x0a

/** Decode tmux's `%output` escaping (`\ooo` octal for `\` and non-printable bytes). */
function unescapeOutput(s: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 /* \ */ && i + 3 < s.length + 1) {
      const oct = s.slice(i + 1, i + 4)
      if (/^[0-7]{3}$/.test(oct)) {
        out.push(parseInt(oct, 8))
        i += 3
        continue
      }
    }
    out.push(s.charCodeAt(i) & 0xff)
  }
  return Buffer.from(out)
}

/**
 * Parse a tmux window-layout string into the window's cell size and its leaf
 * panes. Layout looks like `csum,WxH,X,Y,<pane>` (single pane) or nested
 * `csum,WxH,X,Y{...}` / `[...]` for splits — every leaf carries absolute cell
 * coords, so a flat regex sweep over `WxH,X,Y,<paneId>` collects them all.
 */
function parseLayout(layout: string): { cols: number; rows: number; panes: TmuxPaneRect[] } {
  const comma = layout.indexOf(',')
  const body = comma >= 0 ? layout.slice(comma + 1) : layout
  const root = /^(\d+)x(\d+)/.exec(body)
  const cols = root ? Number(root[1]) : 0
  const rows = root ? Number(root[2]) : 0
  const panes: TmuxPaneRect[] = []
  const re = /(\d+)x(\d+),(\d+),(\d+),(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    panes.push({ w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]), paneId: `%${m[5]}` })
  }
  return { cols, rows, panes }
}

interface PendingCommand {
  resolve: (lines: string[]) => void
  reject: (err: Error) => void
}

export class TmuxControlClient extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0)
  private inBlock = false
  private blockLines: string[] = []
  private blockError = false
  private pending: PendingCommand[] = []
  private windows = new Map<string, TmuxWindowInfo>()
  private activeWindow?: string
  private resyncTimer?: ReturnType<typeof setTimeout>
  private resyncing = false
  private resyncAgain = false
  private disposed = false

  constructor(
    private stream: ClientChannel,
    private cols: number,
    private rows: number
  ) {
    super()
  }

  /** Begin parsing stream data and pull the initial window/pane structure. */
  start(): void {
    this.stream.on('data', (d: Buffer) => this.onData(d))
    // Let tmux's own startup chatter flush before our first command, so the
    // %begin/%end FIFO correlation starts clean.
    setTimeout(() => {
      if (this.disposed) return
      this.resize(this.cols, this.rows)
      this.scheduleResync()
    }, 120)
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    let nl: number
    // Split on raw LF bytes — protocol lines are ASCII and %output never carries
    // an unescaped newline, so byte-level splitting is safe and UTF-8 names in
    // command replies survive the per-line utf8 decode.
    while ((nl = this.buf.indexOf(LF)) !== -1) {
      const line = this.buf.subarray(0, nl).toString('utf8').replace(/\r$/, '')
      this.buf = this.buf.subarray(nl + 1)
      this.onLine(line)
    }
  }

  private onLine(line: string): void {
    if (line.startsWith('%begin')) {
      this.inBlock = true
      this.blockLines = []
      this.blockError = false
      return
    }
    if (this.inBlock) {
      if (line.startsWith('%end') || line.startsWith('%error')) {
        this.blockError = line.startsWith('%error')
        this.inBlock = false
        const p = this.pending.shift()
        if (p) {
          if (this.blockError) p.reject(new Error(this.blockLines.join('\n')))
          else p.resolve(this.blockLines)
        }
        return
      }
      this.blockLines.push(line)
      return
    }
    if (line.startsWith('%')) this.onNotification(line)
  }

  private onNotification(line: string): void {
    if (line.startsWith('%output ')) {
      // %output %<pane> <escaped-data>
      const sp = line.indexOf(' ', 8)
      if (sp === -1) return
      const paneId = line.slice(8, sp)
      const data = line.slice(sp + 1)
      this.emit('paneOutput', paneId, unescapeOutput(data))
      return
    }
    if (line.startsWith('%layout-change ')) {
      // %layout-change @<win> <layout> <visible-layout> <flags>
      const parts = line.split(' ')
      const winId = parts[1]
      const layout = parts[2]
      const w = this.windows.get(winId)
      if (w && layout) {
        const parsed = parseLayout(layout)
        w.cols = parsed.cols
        w.rows = parsed.rows
        w.panes = parsed.panes
        this.emitState()
      } else {
        this.scheduleResync()
      }
      return
    }
    if (line.startsWith('%window-pane-changed ')) {
      // %window-pane-changed @<win> %<pane>
      const parts = line.split(' ')
      const w = this.windows.get(parts[1])
      if (w) {
        w.activePane = parts[2]
        this.emitState()
      }
      return
    }
    if (line.startsWith('%window-renamed ')) {
      const sp = line.indexOf(' ', 16)
      const winId = sp === -1 ? line.slice(16) : line.slice(16, sp)
      const name = sp === -1 ? '' : line.slice(sp + 1)
      const w = this.windows.get(winId)
      if (w) {
        w.name = name
        this.emitState()
      }
      return
    }
    if (line.startsWith('%session-window-changed ')) {
      // %session-window-changed $<sess> @<win>
      const parts = line.split(' ')
      if (parts[2]) {
        this.activeWindow = parts[2]
        for (const [id, w] of this.windows) w.active = id === this.activeWindow
        this.emitState()
      }
      return
    }
    if (
      line.startsWith('%window-add') ||
      line.startsWith('%window-close') ||
      line.startsWith('%unlinked-window-close') ||
      line.startsWith('%session-changed') ||
      line.startsWith('%sessions-changed') ||
      line.startsWith('%session-renamed') ||
      line.startsWith('%client-session-changed')
    ) {
      this.scheduleResync()
      return
    }
    if (line.startsWith('%exit')) {
      const reason = line.slice(5).trim()
      this.emit('exit', reason || undefined)
      return
    }
    // %pane-mode-changed, %continue, %pause, %subscription-changed, %extended-output,
    // %client-detached — nothing to do for our model.
  }

  /** Send a tmux command and resolve with the lines of its %begin/%end reply. */
  private command(cmd: string): Promise<string[]> {
    if (this.disposed) return Promise.reject(new Error('control client disposed'))
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
      try {
        this.stream.write(cmd + '\n')
      } catch (e) {
        this.pending.pop()
        reject(e as Error)
      }
    })
  }

  private scheduleResync(): void {
    if (this.resyncTimer) return
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = undefined
      void this.resync()
    }, 30)
  }

  /** Rebuild the full window/pane model from tmux and emit it. */
  private async resync(): Promise<void> {
    if (this.disposed) return
    if (this.resyncing) {
      this.resyncAgain = true
      return
    }
    this.resyncing = true
    try {
      const winLines = await this.command(
        "list-windows -F '#{window_id}|#{window_active}|#{window_name}|#{window_layout}'"
      )
      const paneLines = await this.command("list-panes -s -F '#{window_id}|#{pane_id}|#{pane_active}'")
      const next = new Map<string, TmuxWindowInfo>()
      let active: string | undefined
      for (const l of winLines) {
        const [winId, act, name, layout] = l.split('|')
        if (!winId) continue
        const parsed = layout ? parseLayout(layout) : { cols: 0, rows: 0, panes: [] }
        const info: TmuxWindowInfo = {
          windowId: winId,
          name: name ?? '',
          active: act === '1',
          cols: parsed.cols,
          rows: parsed.rows,
          panes: parsed.panes
        }
        if (info.active) active = winId
        next.set(winId, info)
      }
      for (const l of paneLines) {
        const [winId, paneId, act] = l.split('|')
        if (act === '1') {
          const w = next.get(winId)
          if (w) w.activePane = paneId
        }
      }
      this.windows = next
      this.activeWindow = active
      this.emitState()
    } catch {
      /* a failed list (e.g. mid-teardown) just leaves the prior model in place */
    } finally {
      this.resyncing = false
      if (this.resyncAgain) {
        this.resyncAgain = false
        this.scheduleResync()
      }
    }
  }

  private emitState(): void {
    const state: TmuxControlState = {
      windows: [...this.windows.values()],
      activeWindow: this.activeWindow
    }
    this.emit('state', state)
  }

  // ---- commands driven by the renderer ----

  /** Forward raw input bytes to a pane (hex-encoded so any byte survives). */
  sendKeys(paneId: string, data: string): void {
    const hex = Buffer.from(data, 'utf8').toString('hex').match(/../g)
    if (!hex || !hex.length) return
    void this.command(`send-keys -t ${paneId} -H ${hex.join(' ')}`).catch(() => {})
  }

  /** Set this control client's size; tmux re-lays-out windows to fit. */
  resize(cols: number, rows: number): void {
    if (!(cols > 0) || !(rows > 0)) return
    this.cols = cols
    this.rows = rows
    try {
      this.stream.setWindow(rows, cols, 0, 0)
    } catch {
      /* ignore */
    }
    void this.command(`refresh-client -C ${cols}x${rows}`).catch(() => {})
  }

  selectWindow(windowId: string): void {
    void this.command(`select-window -t ${windowId}`).catch(() => {})
  }
  selectPane(paneId: string): void {
    void this.command(`select-pane -t ${paneId}`).catch(() => {})
  }
  newWindow(): void {
    void this.command('new-window').catch(() => {})
  }
  splitPane(paneId: string, direction: 'columns' | 'rows'): void {
    void this.command(`split-window -t ${paneId} ${direction === 'rows' ? '-v' : '-h'}`).catch(() => {})
  }
  killPane(paneId: string): void {
    void this.command(`kill-pane -t ${paneId}`).catch(() => {})
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.resyncTimer) clearTimeout(this.resyncTimer)
    this.resyncTimer = undefined
    for (const p of this.pending) p.reject(new Error('control client disposed'))
    this.pending = []
    this.windows.clear()
  }
}
