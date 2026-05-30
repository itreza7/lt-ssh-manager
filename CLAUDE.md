# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # electron-vite dev with hot reload (main + preload + renderer)
npm run typecheck  # tsc on both projects — the ONLY verification gate (see below)
npm run build      # production build into out/
npm run dist       # build + electron-builder --win → NSIS installer in release/
```

`npm run typecheck` runs two passes: `typecheck:node` (`tsconfig.node.json` — main, preload,
shared) and `typecheck:web` (`tsconfig.web.json` — renderer, preload `.d.ts`, shared). There is
**no test suite and no linter configured** (the stray `eslint-disable` comments are vestigial — no
eslint dependency exists). Typecheck is the check to run before building.

On Windows, `npm run dist` may need symlink privileges — run from an elevated shell once, or enable
Developer Mode.

## Architecture

An Electron app with a hard privilege boundary. The renderer runs with `contextIsolation: true`,
`nodeIntegration: false`, and never touches Node, the filesystem, or `ssh2`. All privileged work
lives in the main process and is reached only through the curated `window.api` bridge.

### The four-layer structure

- **Main** (`src/main/`) — owns everything privileged:
  - `index.ts` — creates the **frameless** BrowserWindow (custom in-app title bar; native menu is
    disabled via `Menu.setApplicationMenu(null)`), so menu accelerators (Ctrl+N, Ctrl+,, zoom,
    F11, devtools) are reimplemented in a `before-input-event` handler.
  - `ipc.ts` — the single point wiring every `window.api` call to a handler, and pushing
    `SshManager` events to the focused window's `webContents`. Also holds the remote-command
    builders (`PROBE`, `TMUX_LIST`, `shQuote`) and their parsers.
  - `ssh/manager.ts` — `SshManager` (an `EventEmitter`) owns all `ssh2` `Client`s: interactive
    shells, one-shot `exec` (probe / tmux), the per-connection SFTP channel pool, and tunnels.
  - `ssh/knownHosts.ts` — trust-on-first-use host-key pinning with SHA256 fingerprints.
  - `store/*.ts` — tiny JSON-file persisters under `app.getPath('userData')`
    (`%APPDATA%/ssh-manager` on Windows): `connections.json`, `secrets.json` (encrypted),
    `known_hosts.json`, `settings.json`, `workspace.json`, `tunnels.json`. Each tolerates missing/
    corrupt files by returning defaults.
- **Preload** (`src/preload/index.ts`) — the **only** bridge. Builds the `api` object and exposes it
  via `contextBridge` as `window.api`; `export type Api = typeof api` is the renderer's contract.
  `index.d.ts` declares the `window.api` global. Event subscriptions (`onData`, `onStatus`, …)
  return an unsubscribe function.
- **Renderer** (`src/renderer/src/`) — React 19 + Tailwind v4 + xterm.js. `App.tsx` is the central
  state container: the connections list, the tab model (a `Tab` discriminated union —
  dashboard / session / settings / sftp / editor / tunnels), workspace persistence, password
  resolution, and the host-key / password dialogs. Components for inactive tabs stay **mounted**
  (toggled with CSS `visibility`) so live terminals, SFTP transfers, and unsaved edits survive tab
  switches.
- **Shared** (`src/shared/types.ts`) — the single source of truth for all cross-process types and
  the `DEFAULT_*` constants. Both tsconfig projects include it.

### Adding a privileged feature touches four files in lockstep

Because the renderer can't reach Node directly, any new capability requires changes in:
`src/shared/types.ts` (types) → `src/main/ipc.ts` (handler, usually delegating to `SshManager`) →
`src/preload/index.ts` (the `window.api` method) → the renderer caller. Keep the channel name and
argument shape identical across all four.

### Cross-cutting invariants (the non-obvious bits)

- **Passwords are never written to disk** except through `secrets.ts`, which encrypts them with
  Electron `safeStorage` (and only for `password`-auth connections). `connections.json`,
  `workspace.json`, and `tunnels.json` never contain secrets. On restore they're re-resolved
  (stored secret or a one-time prompt). In `ipc.ts`, `passwordFor()` resolves "explicit arg, else
  stored secret".
- **SFTP channels are pooled and reference-counted per `connectionId`** (`sftpPool` in
  `manager.ts`), shared by the file manager and every editor tab, and kept warm for a 30s grace
  period after the last `closeSftp` so reopening a file skips a fresh handshake.
- **Session lifecycle**: `connect()` retries with jittered exponential backoff but fails fast on
  permanent errors (`isPermanent` — auth failure, `ENOTFOUND`, rejected host key). A client
  error/close *before* the shell is up fails the connect attempt (→ retry); *after* it's up means
  the live session dropped (→ emit `closed`, renderer shows a reattach overlay). `endSession` is
  idempotent and guards on map identity so a stale session's late event can't disturb a newer
  session reconnected under the same id.
- **tmux** is the persistence story: a tmux-enabled connection opens via `tmux new -A -s <name>`
  (create-or-attach), run as a `command` in a PTY (`client.exec`) instead of a login shell
  (`client.shell`). A detach shows the reattach overlay; reconnect re-dials with the same args.
  Session-name sanitizing and command building live in `renderer/src/lib/tmux.ts`.
- **Remote command safety**: any value interpolated into a remote shell command is single-quoted
  with `shQuote`. The host-vitals `PROBE` is a Linux-oriented `key=value` script that degrades
  gracefully when tools are missing.

### Build & styling specifics

- `electron.vite.config.ts` defines three build targets. Renderer root is `src/renderer` with alias
  `@ → src/renderer/src`; `externalizeDepsPlugin()` keeps node deps external in main/preload.
- Styling is Tailwind v4 with **custom semantic color tokens** declared in `@theme` in
  `src/renderer/src/index.css` (`ink`, `surface`, `panel`, `elevated`, `line`, `signal`, `amber`,
  `danger`, `fg`/`muted`/`faint`). Use these tokens (e.g. `bg-ink`, `text-signal`) rather than raw
  hex. The frameless window uses `-webkit-app-region` `drag`/`no-drag` classes for the title bar.
