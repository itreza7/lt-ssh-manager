// The slash commands Claude Code 2.1.292 lists in /help (Commands tab), read on a throwaway
// session. `local`: a built-in that runs in the TUI and starts no turn (the binary types
// these `local` / `local-jsx`); the others are skills and prompts that start one.
//
// The chat types any of them into the pane. A command that opens a screen is shown live
// in the chat (LiveScreen), so one missing here, or new in a later version, still works.

export interface SlashCommand {
  name: string
  description: string
  local?: true
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'add-dir', description: 'Add a new working directory', local: true },
  {
    name: 'advisor',
    description: 'Let Claude consult a stronger model at key moments',
    local: true
  },
  {
    name: 'artifact-capabilities',
    description: 'Runtime capabilities a published Artifact page can be granted — behavior static HTML cannot provide on its own…'
  },
  {
    name: 'artifact-diagramming',
    description: 'Diagramming know-how for Artifacts - when a picture earns its place, how to draw one that shows the real…'
  },
  {
    name: 'artifacts',
    description: 'Browse your published and shared artifacts',
    local: true
  },
  {
    name: 'auto-mode-setup',
    description: 'Teach auto mode about your environment, plus optional rule tweaks',
    local: true
  },
  {
    name: 'autocompact',
    description: 'Set how full the context gets before auto-summarizing',
    local: true
  },
  {
    name: 'autofix-pr',
    description: 'Monitor and autofix any issues with the current PR',
    local: true
  },
  {
    name: 'background',
    description: 'Send this session to the background and free the terminal',
    local: true
  },
  {
    name: 'batch',
    description: 'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that…'
  },
  {
    name: 'branch',
    description: 'Create a branch of the current conversation at this point',
    local: true
  },
  {
    name: 'btw',
    description: 'Ask a quick side question without interrupting the main conversation',
    local: true
  },
  {
    name: 'bug',
    description: 'Report a bug or share your conversation',
    local: true
  },
  {
    name: 'cd',
    description: 'Move this session to a new working directory',
    local: true
  },
  { name: 'chrome', description: 'Open Claude in Chrome settings' },
  {
    name: 'claude-api',
    description: 'Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents…'
  },
  {
    name: 'claude-in-chrome',
    description: 'Automates your Chrome browser to interact with web pages - clicking elements, filling forms, capturing…'
  },
  {
    name: 'clear',
    description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)',
    local: true
  },
  {
    name: 'code-review',
    description: 'Review the current diff, or a PR number/branch/path target, for correctness bugs (plus…'
  },
  {
    name: 'color',
    description: 'Set the prompt bar color for this session',
    local: true
  },
  {
    name: 'compact',
    description: 'Free up context by summarizing the conversation so far',
    local: true
  },
  { name: 'config', description: 'Open settings', local: true },
  {
    name: 'context',
    description: 'Visualize current context usage as a colored grid',
    local: true
  },
  {
    name: 'copy',
    description: "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)",
    local: true
  },
  {
    name: 'dataviz',
    description: 'Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in…'
  },
  {
    name: 'debug',
    description: 'Enable debug logging for this session and help diagnose issues',
    local: true
  },
  {
    name: 'deep-research',
    description: 'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited…'
  },
  { name: 'design', description: 'Make a new Design artifact from a brief' },
  {
    name: 'design-login',
    description: 'Authorize design-system access for /design-sync with your claude.ai account',
    local: true
  },
  {
    name: 'design-sync',
    description: 'Push a React design system to claude.ai/design. This runs a converter that bundles the real component code…'
  },
  {
    name: 'doctor',
    description: "Health-check the user's Claude Code setup and fix issues: diagnose installation health — what the `claude…",
    local: true
  },
  {
    name: 'effort',
    description: 'Set effort level for model usage',
    local: true
  },
  {
    name: 'export',
    description: 'Export the current conversation to a file or clipboard',
    local: true
  },
  { name: 'fast', description: 'Toggle fast mode (Opus 5.5)', local: true },
  {
    name: 'feedback',
    description: 'Send feedback to Anthropic or report a bug',
    local: true
  },
  {
    name: 'fewer-permission-prompts',
    description: 'Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project…'
  },
  {
    name: 'focus',
    description: 'Toggle focus view: just your prompt, summary, and response',
    local: true
  },
  {
    name: 'fork',
    description: 'Copy this conversation into a new background session and keep working here',
    local: true
  },
  {
    name: 'goal',
    description: 'Set a goal Claude checks before stopping',
    local: true
  },
  {
    name: 'help',
    description: 'Show help and available commands',
    local: true
  },
  {
    name: 'hooks',
    description: 'View hook configurations for tool events',
    local: true
  },
  {
    name: 'import',
    description: 'Import config from another AI coding agent',
    local: true
  },
  {
    name: 'init',
    description: 'Initialize new CLAUDE.md file(s) and optional skills/hooks with codebase documentation'
  },
  {
    name: 'insights',
    description: 'Generate a report analyzing your Claude Code sessions'
  },
  {
    name: 'list-agents',
    description: 'List subagents, teammates, and other Claude sessions you can message',
    local: true
  },
  {
    name: 'loop',
    description: 'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model…'
  },
  { name: 'mcp', description: 'Manage MCP servers', local: true },
  {
    name: 'memory',
    description: 'Edit CLAUDE.md files and memory settings',
    local: true
  },
  {
    name: 'model',
    description: 'Set the AI model for Claude Code',
    local: true
  },
  {
    name: 'output-style',
    description: 'List output styles or switch to one',
    local: true
  },
  {
    name: 'passes',
    description: 'Share a free week of Claude Code with friends and earn usage credits',
    local: true
  },
  {
    name: 'permissions',
    description: 'Manage allow and deny tool permission rules',
    local: true
  },
  {
    name: 'plan',
    description: 'Enable plan mode or view the current session plan',
    local: true
  },
  { name: 'plugin', description: 'Manage Claude Code plugins', local: true },
  {
    name: 'plugin-authoring',
    description: 'Make a mod: a live pane, band, status line, toast or hook inside Claude Code (terminal or desktop Code tab)…'
  },
  {
    name: 'powerup',
    description: 'Discover Claude Code features through quick interactive lessons',
    local: true
  },
  {
    name: 'privacy-settings',
    description: 'View and update your privacy settings',
    local: true
  },
  {
    name: 'rate-limit-options',
    description: 'Manage usage limits and upgrade options',
    local: true
  },
  {
    name: 'recap',
    description: 'Generate a one-line session recap now',
    local: true
  },
  { name: 'release-notes', description: 'View release notes', local: true },
  {
    name: 'reload-plugins',
    description: 'Activate pending plugin changes in the current session',
    local: true
  },
  {
    name: 'reload-skills',
    description: 'Pick up skills added or changed on disk during this session',
    local: true
  },
  {
    name: 'rename',
    description: 'Rename the current conversation',
    local: true
  },
  {
    name: 'resume',
    description: 'Resume a previous conversation',
    local: true
  },
  {
    name: 'rewind',
    description: 'Restore the code and/or conversation to a previous point',
    local: true
  },
  {
    name: 'run',
    description: "Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the…"
  },
  {
    name: 'run-skill-generator',
    description: 'Author or improve the run-<unit> skill - a per-project skill that tells agents how to build, launch, and drive…'
  },
  {
    name: 'sandbox',
    description: '◯ sandbox disabled (⏎ to configure)',
    local: true
  },
  {
    name: 'schedule',
    description: 'Create, update, list, or run scheduled cloud agents (routines) that execute on a cron schedule.'
  },
  {
    name: 'scroll-speed',
    description: 'Adjust mouse wheel scroll speed',
    local: true
  },
  {
    name: 'security-review',
    description: 'Complete a security review of the pending changes on the current branch'
  },
  {
    name: 'simplify',
    description: 'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes.…'
  },
  {
    name: 'skill-doctor',
    description: 'Show which loaded skills are unused and costing context',
    local: true
  },
  { name: 'skills', description: 'List available skills', local: true },
  {
    name: 'slides',
    description: 'Make a new Slides deck artifact from a brief'
  },
  {
    name: 'status',
    description: 'Show Claude Code status including version, model, account, API connectivity, and tool statuses',
    local: true
  },
  {
    name: 'statusline',
    description: "Set up Claude Code's status line UI",
    local: true
  },
  {
    name: 'subtask',
    description: 'Send a subagent off with your full context; its result comes back here',
    local: true
  },
  {
    name: 'tasks',
    description: 'View and manage everything running in the background',
    local: true
  },
  {
    name: 'team-onboarding',
    description: 'Help teammates ramp on Claude Code with a guide from your usage'
  },
  { name: 'theme', description: 'Change the theme', local: true },
  {
    name: 'ultrareview',
    description: 'Start a cloud agent that finds and verifies bugs in your branch (~15-25 min, $5-$25 USD) · Runs in a cloud…',
    local: true
  },
  {
    name: 'update-config',
    description: 'Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when…'
  },
  {
    name: 'usage',
    description: 'Show session cost, plan usage, and activity stats',
    local: true
  },
  {
    name: 'usage-credits',
    description: 'Configure usage credits or request them from your admin when you hit a limit',
    local: true
  },
  {
    name: 'verify',
    description: "Verify that a code change actually does what it's supposed to by exercising it end-to-end and observing…"
  },
  {
    name: 'workflow-authoring',
    description: 'Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked…'
  },
  {
    name: 'workflows',
    description: 'Browse running and completed workflows',
    local: true
  }
]

/**
 * Read-only screens: their text is read off the pane, the screen closed, and shown as a card
 * (/usage as bars). /status stays open instead: its native view has the Config and Stats tabs.
 */
export const SCREEN_COMMANDS: ReadonlySet<string> = new Set(['usage'])

/** Never typed from the chat, with why. */
export const DENIED_COMMANDS: Readonly<Record<string, string>> = {
  exit: 'it ends Claude',
  logout: 'it signs this host out',
  login: 'it needs a browser sign-in',
  upgrade: 'it opens a browser',
  'install-github-app': 'it needs a browser',
  'install-slack-app': 'it needs a browser',
  'terminal-setup': 'it changes the terminal, not Claude',
  ide: 'it needs an IDE on the host',
  mobile: 'it shows a QR code',
  teleport: 'it moves the session to the cloud',
  'remote-control': 'it needs the terminal',
  'remote-env': 'it needs the terminal',
  'web-setup': 'it needs a browser',
  diff: 'it opens a panel only the terminal shows',
  tui: 'it changes how the terminal draws',
  keybindings: 'it opens an editor in the terminal',
  stickers: 'it opens a browser',
  radio: 'it plays audio on the host',
  voice: 'it needs a microphone',
  stop: 'it stops this session'
}
