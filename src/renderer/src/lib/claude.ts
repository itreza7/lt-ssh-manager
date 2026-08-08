// The Claude launch builders live in src/shared so the main process can build its
// runtime probe from the same resolver text the renderer builds a launch script
// from. This module stays as the renderer's import path.
export {
  claudeTabCommand,
  claudeSessionName,
  claudeResumeSessionName,
  isClaudeSession
} from '../../../shared/claude'
