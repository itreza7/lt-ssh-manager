// The resume scan builder and parser live in src/shared so the main process can
// run the same command the renderer reasons about. This module stays as the
// renderer's import path — it only needs the display side.
export { resumeTitle, RESUME_LIMIT, savedSessionStatus } from '../../../shared/resume'
export type { SavedSessionStatus } from '../../../shared/resume'
