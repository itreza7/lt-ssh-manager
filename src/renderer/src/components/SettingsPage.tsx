import { useState, type ReactNode } from 'react'
import type { Connection } from '../../../shared/types'
import type {
  AgentAlerts,
  AppSettings,
  ComposerSendMode,
  CursorStyle,
  SettingsPatch,
  ShiftEnterMode,
  Theme
} from '../lib/terminalSettings'
import {
  clampFont,
  clampOverscroll,
  clampRetries,
  clampScrollback,
  FONT_MAX,
  FONT_MIN,
  OVERSCROLL_MAX,
  OVERSCROLL_MIN,
  resolveFontStack,
  RETRIES_MAX,
  RETRIES_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  TAB_SIZES,
  TERMINAL_FONTS
} from '../lib/terminalSettings'
import { Button } from './Modal'
import { Select } from './Select'
import { isMac } from '../lib/platform'
import { COMPOSE_ACCEL, PASTE_UPLOAD_ACCEL } from '../lib/xtermAttach'

interface Props {
  settings: AppSettings
  onChange: (patch: SettingsPatch) => void
  onReset: () => void
  connections: Connection[]
  activeConnectionId: string | null
  onSelectConnection: (id: string) => void
  onAddConnection: () => void
  onEditConnection: (c: Connection) => void
  onDeleteConnection: (c: Connection) => void
}

const authLabel: Record<Connection['authMethod'], string> = {
  key: 'KEY',
  password: 'PWD',
  agent: 'AGENT'
}

type SectionId = 'appearance' | 'terminal' | 'composer' | 'editor' | 'connections' | 'shortcuts'
const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'appearance', label: 'Appearance', icon: '◐' },
  { id: 'terminal', label: 'Terminal', icon: '▍' },
  { id: 'composer', label: 'Composer', icon: '✦' },
  { id: 'editor', label: 'Editor', icon: '✎' },
  { id: 'connections', label: 'Connections', icon: '⇄' },
  { id: 'shortcuts', label: 'Shortcuts', icon: '⌨' }
]

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

const CURSORS: { value: CursorStyle; label: string }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' }
]

const SHIFT_ENTERS: { value: ShiftEnterMode; label: string }[] = [
  { value: 'newline', label: 'Newline' },
  { value: 'escape-cr', label: 'Esc+Enter' },
  { value: 'submit', label: 'Submit' }
]

const AGENT_ALERTS: { value: AgentAlerts; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'dot', label: 'Dot' },
  { value: 'notify', label: 'Notify' }
]

const COMPOSER_SENDS: { value: ComposerSendMode; label: string }[] = [
  { value: 'mod-enter', label: isMac ? '⌘+Enter' : 'Ctrl+Enter' },
  { value: 'enter', label: 'Enter' }
]

/** What plain Enter actually does right now — the setting above decides. */
const COMPOSER_SEND_HELP: Record<ComposerSendMode, string> = {
  'mod-enter': 'Enter adds a line; ⌘/Ctrl+Enter sends',
  enter: 'Enter sends; Shift+Enter adds a line'
}

/** What Shift+Enter actually does right now — the setting above decides. */
const SHIFT_ENTER_HELP: Record<ShiftEnterMode, string> = {
  newline: 'Newline inside the prompt (LF) — Enter still submits',
  'escape-cr': 'Newline as Esc+Enter — for programs expecting that encoding',
  submit: 'Submits, same as Enter'
}

const KEYS: { keys: string; what: string }[] = isMac
  ? [
      { keys: 'Select text', what: 'Copies automatically' },
      { keys: '⌘C', what: 'Copy selection' },
      { keys: 'Ctrl+C', what: 'Interrupt (SIGINT)' },
      { keys: '⌘V / Right-click', what: 'Paste' },
      { keys: '⌥+drag', what: 'Select inside tmux/htop/vim (mouse-mode apps)' },
      { keys: '⌘-click / Ctrl+click', what: 'Open a link' }
    ]
  : [
      { keys: 'Select text', what: 'Copies automatically' },
      { keys: 'Ctrl+Shift+C', what: 'Copy selection' },
      { keys: 'Ctrl+C', what: 'Copy if text selected, else interrupt (SIGINT)' },
      { keys: 'Ctrl+Shift+V / Right-click', what: 'Paste' },
      { keys: 'Shift+drag', what: 'Select inside tmux/htop/vim (mouse-mode apps)' },
      { keys: 'Ctrl+click', what: 'Open a link' }
    ]

const field =
  'rounded-lg border border-line bg-ink/60 px-2.5 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent/60'

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line-soft py-4 last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-faint">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  )
}

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  const btn =
    'grid h-7 w-7 place-items-center rounded-md border border-line text-muted transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-30'
  return (
    <div className="flex items-center gap-1.5">
      <button className={btn} disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span className="w-10 text-center font-mono text-sm text-fg">{value}</span>
      <button className={btn} disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-lg border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-xs transition-colors ${
            value === o.value ? 'bg-accent/20 text-accent' : 'text-muted hover:text-fg'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function NumSeg({
  value,
  options,
  onChange
}: {
  value: number
  options: readonly number[]
  onChange: (v: number) => void
}) {
  return (
    <div className="flex rounded-lg border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`rounded-md px-3 py-1 font-mono text-xs transition-colors ${
            value === o ? 'bg-accent/20 text-accent' : 'text-muted hover:text-fg'
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (b: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
        on ? 'border-accent bg-accent' : 'border-line bg-elevated'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full shadow-sm transition-transform duration-150 ${
          on ? 'translate-x-6 bg-ink' : 'translate-x-1 bg-faint'
        }`}
      />
    </button>
  )
}

export function SettingsPage({
  settings,
  onChange,
  onReset,
  connections,
  activeConnectionId,
  onSelectConnection,
  onAddConnection,
  onEditConnection,
  onDeleteConnection
}: Props) {
  const [section, setSection] = useState<SectionId>('terminal')
  const t = settings.terminal
  const setT = (patch: Partial<AppSettings['terminal']>): void => onChange({ terminal: patch })
  const ed = settings.editor
  const setE = (patch: Partial<AppSettings['editor']>): void => onChange({ editor: patch })

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex shrink-0 items-end justify-between border-b border-line px-10 py-5">
        <div>
          <div className="eyebrow mb-1.5">Preferences</div>
          <h1 className="text-2xl font-bold tracking-tight text-fg">Settings</h1>
        </div>
        <Button onClick={onReset}>Restore defaults</Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* sub-nav */}
        <nav className="w-48 shrink-0 space-y-1 border-r border-line p-3">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                section === s.id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-elevated/50 hover:text-fg'
              }`}
            >
              <span className="w-4 text-center">{s.icon}</span>
              {s.label}
            </button>
          ))}
          <div className="px-3 pt-3 text-[10px] leading-relaxed text-faint">
            Saved to your SSH&nbsp;Manager folder.
          </div>
        </nav>

        {/* content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-2xl">
            {section === 'appearance' && (
              <div className="panel px-5 py-2">
                <Row label="Theme" hint="Follow the system, or pin it">
                  <Segmented value={settings.theme} options={THEMES} onChange={(v) => onChange({ theme: v })} />
                </Row>
              </div>
            )}

            {section === 'terminal' && (
              <>
                {/* preview */}
                <div className="animate-rise mb-5 overflow-hidden rounded-xl border border-line bg-ink p-4">
                  <div className="eyebrow mb-2">Preview</div>
                  <div className="leading-relaxed" style={{ fontFamily: resolveFontStack(t.fontFamily), fontSize: t.fontSize }}>
                    <span className="text-accent">reza@server</span>
                    <span className="text-muted">:</span>
                    <span className="text-[#7aa2f7]">~/app</span>
                    <span className="text-muted">$ </span>
                    <span className="text-fg">npm run dev</span>
                    <span
                      className={`ml-0.5 inline-block align-middle bg-accent ${t.cursorBlink ? 'animate-glow' : ''} ${
                        t.cursorStyle === 'block'
                          ? 'h-[1.05em] w-[0.55em]'
                          : t.cursorStyle === 'underline'
                            ? 'h-0.5 w-[0.55em]'
                            : 'h-[1.05em] w-0.5'
                      }`}
                    />
                  </div>
                </div>

                <div className="panel px-5 py-2">
                  <Row label="Font" hint="Bundled fonts work offline; others use your installed fonts.">
                    <Select
                      value={t.fontFamily}
                      onChange={(v) => setT({ fontFamily: v })}
                      options={TERMINAL_FONTS.map((f) => ({
                        value: f.id,
                        label: f.bundled ? f.label : `${f.label} (system)`,
                        style: { fontFamily: f.stack }
                      }))}
                    />
                  </Row>
                  <Row label="Font size" hint="Independent of the app's overall zoom.">
                    <Stepper value={t.fontSize} min={FONT_MIN} max={FONT_MAX} onChange={(n) => setT({ fontSize: clampFont(n) })} />
                  </Row>
                  <Row label="Cursor style">
                    <Segmented value={t.cursorStyle} options={CURSORS} onChange={(v) => setT({ cursorStyle: v })} />
                  </Row>
                  <Row label="Cursor blink">
                    <Toggle on={t.cursorBlink} onChange={(b) => setT({ cursorBlink: b })} />
                  </Row>
                  <Row label="Scrollback" hint="Lines kept in terminal history.">
                    <input
                      type="number"
                      min={SCROLLBACK_MIN}
                      max={SCROLLBACK_MAX}
                      step={500}
                      value={t.scrollback}
                      onChange={(e) => setT({ scrollback: clampScrollback(Number(e.target.value)) })}
                      className={`${field} w-24 text-right font-mono`}
                    />
                  </Row>
                  <Row
                    label="Shift+Enter sends"
                    hint="Newline lets a terminal agent take a multi-line prompt; a plain shell reads it as Enter either way. Esc+Enter is what iTerm2/VS Code send. Submit is the pre-0.3 behavior."
                  >
                    <Segmented value={t.shiftEnter} options={SHIFT_ENTERS} onChange={(v) => setT({ shiftEnter: v })} />
                  </Row>
                  <Row
                    label="Live tab titles"
                    hint="Label a session tab with the title the remote sets — the working directory, or what's running — instead of the connection name."
                  >
                    <Toggle on={t.liveTitles} onChange={(b) => setT({ liveTitles: b })} />
                  </Row>
                  <Row
                    label="Agent attention"
                    hint="When a program in a tab you aren't looking at asks for you — Claude Code's Notification hook, or any bell. Dot marks the tab; Notify adds a system notification and a dock badge while the window is in the background."
                  >
                    <Segmented
                      value={t.agentAlerts}
                      options={AGENT_ALERTS}
                      onChange={(v) => setT({ agentAlerts: v })}
                    />
                  </Row>
                  <Row
                    label="Overscroll height"
                    hint="Render the terminal this many × taller than the window so you can scroll long output — including tmux — with the scrollbar/wheel. 1 = off."
                  >
                    <Stepper
                      value={clampOverscroll(t.overscroll)}
                      min={OVERSCROLL_MIN}
                      max={OVERSCROLL_MAX}
                      onChange={(n) => setT({ overscroll: clampOverscroll(n) })}
                    />
                  </Row>
                </div>
              </>
            )}

            {section === 'composer' && (
              <div className="panel px-5 py-2">
                <Row
                  label="Open by default"
                  hint="Every new tab starts with the prompt composer already open, ready to draft — instead of waiting for the chord below."
                >
                  <Toggle on={t.composerDefaultOpen} onChange={(b) => setT({ composerDefaultOpen: b })} />
                </Row>
                <Row label="Send key" hint={COMPOSER_SEND_HELP[t.composerSendMode]}>
                  <Segmented
                    value={t.composerSendMode}
                    options={COMPOSER_SENDS}
                    onChange={(v) => setT({ composerSendMode: v })}
                  />
                </Row>
                <Row
                  label="Stay open after sending"
                  hint="Keep drafting the next message instead of closing and handing focus back to the terminal."
                >
                  <Toggle on={t.composerStayOpen} onChange={(b) => setT({ composerStayOpen: b })} />
                </Row>
                <Row
                  label="Toggle from the keyboard"
                  hint="The same chord opens the composer and closes it again — no separate off switch to remember."
                >
                  <span className="font-mono text-xs text-accent">{COMPOSE_ACCEL}</span>
                </Row>
              </div>
            )}

            {section === 'editor' && (
              <>
                {/* preview */}
                <div className="animate-rise mb-5 overflow-hidden rounded-xl border border-line bg-ink p-4">
                  <div className="eyebrow mb-2">Preview</div>
                  <div
                    className="leading-relaxed"
                    style={{ fontFamily: resolveFontStack(ed.fontFamily), fontSize: ed.fontSize }}
                  >
                    <div>
                      {ed.lineNumbers && <span className="mr-3 text-faint">1</span>}
                      <span className="text-[#7aa2f7]">const</span>{' '}
                      <span className="text-fg">greet</span>
                      <span className="text-muted"> = (</span>
                      <span className="text-amber">name</span>
                      <span className="text-muted">) =&gt; </span>
                      <span className="text-accent">`hi ${'{'}name{'}'}`</span>
                    </div>
                    <div>
                      {ed.lineNumbers && <span className="mr-3 text-faint">2</span>}
                      <span className="text-muted">// edit files over SFTP, in-app</span>
                    </div>
                  </div>
                </div>

                <div className="panel px-5 py-2">
                  <Row label="Font" hint="Used by the code editor; bundled fonts work offline.">
                    <Select
                      value={ed.fontFamily}
                      onChange={(v) => setE({ fontFamily: v })}
                      options={TERMINAL_FONTS.map((f) => ({
                        value: f.id,
                        label: f.bundled ? f.label : `${f.label} (system)`,
                        style: { fontFamily: f.stack }
                      }))}
                    />
                  </Row>
                  <Row label="Font size">
                    <Stepper value={ed.fontSize} min={FONT_MIN} max={FONT_MAX} onChange={(n) => setE({ fontSize: clampFont(n) })} />
                  </Row>
                  <Row label="Tab size" hint="Spaces per indentation level.">
                    <NumSeg value={ed.tabSize} options={TAB_SIZES} onChange={(v) => setE({ tabSize: v })} />
                  </Row>
                  <Row label="Word wrap" hint="Wrap long lines instead of scrolling sideways.">
                    <Toggle on={ed.wordWrap} onChange={(b) => setE({ wordWrap: b })} />
                  </Row>
                  <Row label="Minimap" hint="Code overview on the right edge.">
                    <Toggle on={ed.minimap} onChange={(b) => setE({ minimap: b })} />
                  </Row>
                  <Row label="Line numbers">
                    <Toggle on={ed.lineNumbers} onChange={(b) => setE({ lineNumbers: b })} />
                  </Row>
                  <Row label="Open markdown as preview" hint="Show .md files rendered; toggle to edit source.">
                    <Toggle on={ed.markdownPreview} onChange={(b) => setE({ markdownPreview: b })} />
                  </Row>
                </div>
              </>
            )}

            {section === 'connections' && (
              <>
                <div className="panel mb-5 px-5 py-4">
                  <div className="mb-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-fg">Servers</div>
                      <div className="mt-0.5 text-xs text-faint">
                        One active at a time — selecting a server closes any tabs open for the current one.
                      </div>
                    </div>
                    <Button onClick={onAddConnection}>+ Add</Button>
                  </div>

                  {connections.length === 0 && (
                    <p className="rounded-lg border border-dashed border-line px-3 py-8 text-center text-xs leading-relaxed text-faint">
                      No connections yet.
                      <br />
                      Hit <span className="font-mono text-muted">+ Add</span> above to add your first host.
                    </p>
                  )}

                  <div className="space-y-1">
                    {connections.map((c) => {
                      const active = c.id === activeConnectionId
                      return (
                        <div
                          key={c.id}
                          onClick={() => onSelectConnection(c.id)}
                          className={`group relative cursor-pointer rounded-lg px-3 py-2.5 transition-colors ${
                            active ? 'bg-accent-soft/40 ring-1 ring-accent/30' : 'hover:bg-elevated/50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium text-fg">{c.name}</span>
                              {active && (
                                <span className="shrink-0 rounded border border-accent/30 bg-accent/15 px-1.5 py-px font-mono text-[9px] tracking-wider text-accent">
                                  ACTIVE
                                </span>
                              )}
                            </span>
                            <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onEditConnection(c)
                                }}
                                className="rounded px-1.5 text-xs text-faint hover:text-fg"
                                title="Edit"
                              >
                                ✎
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onDeleteConnection(c)
                                }}
                                className="rounded px-1.5 text-xs text-faint hover:text-danger"
                                title="Delete"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className="truncate font-mono text-[11px] text-muted">
                              {c.username ? `${c.username}@` : ''}
                              {c.host}
                              <span className="text-faint">:{c.port}</span>
                            </span>
                            <span className="ml-auto shrink-0 rounded border border-line px-1 py-px font-mono text-[9px] tracking-wider text-faint">
                              {authLabel[c.authMethod]}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="panel px-5 py-2">
                  <Row label="Connect retries" hint="Attempts on transient failures before giving up.">
                    <Stepper
                      value={settings.connectRetries}
                      min={RETRIES_MIN}
                      max={RETRIES_MAX}
                      onChange={(n) => onChange({ connectRetries: clampRetries(n) })}
                    />
                  </Row>
                </div>
              </>
            )}

            {section === 'shortcuts' && (
              <div className="panel px-5 py-3">
                <div className="eyebrow py-2">Terminal copy &amp; paste</div>
                {KEYS.map((k) => (
                  <div key={k.keys} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                    <span className="font-mono text-xs text-accent">{k.keys}</span>
                    <span className="text-right text-muted">{k.what}</span>
                  </div>
                ))}
                <div className="eyebrow py-2 pt-4">Typing</div>
                <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <span className="font-mono text-xs text-accent">Shift+Enter</span>
                  <span className="text-right text-muted">{SHIFT_ENTER_HELP[t.shiftEnter]}</span>
                </div>
                <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <span className="font-mono text-xs text-accent">Ctrl+J</span>
                  <span className="text-right text-muted">Newline — always, whatever Shift+Enter is set to</span>
                </div>
                <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <span className="font-mono text-xs text-accent">{COMPOSE_ACCEL}</span>
                  <span className="text-right text-muted">
                    Prompt composer — toggle it open to draft a multi-line prompt, then send it as one
                    paste. More options in the Composer section.
                  </span>
                </div>
                <div className="eyebrow py-2 pt-4">Files</div>
                <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <span className="font-mono text-xs text-accent">Drag &amp; drop</span>
                  <span className="text-right text-muted">
                    Upload onto a terminal — the remote path is typed at your cursor, never run
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <span className="font-mono text-xs text-accent">{PASTE_UPLOAD_ACCEL}</span>
                  <span className="text-right text-muted">
                    Upload the clipboard&apos;s image or a copied file the same way — a screenshot
                    or a Finder/Explorer copy in one gesture
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
