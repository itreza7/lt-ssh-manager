// The agent scan builder and parser live in src/shared so the main process can
// run the same command the renderer reasons about. This module stays as the
// renderer's import path — it only needs the display side.
export { agentStatus, WORKING_WITHIN_SECONDS } from '../../../shared/agents'
export type { AgentStatus } from '../../../shared/agents'
