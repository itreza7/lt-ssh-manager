// The tmux command builders live in src/shared so the main process can build the
// reattach command from the same session name the renderer opened the tab with.
// This module stays as the renderer's import path.
export {
  shQuote,
  tmuxSessionName,
  tmuxCreateCommand,
  tmuxReattachCommand,
  parseTmuxIntent
} from '../../../shared/tmux'
