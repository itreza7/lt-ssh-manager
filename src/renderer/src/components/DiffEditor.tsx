import { DiffEditor as MonacoDiff } from '@monaco-editor/react'
import '../lib/monaco' // registers workers + the 'ssh-manager' theme

interface Props {
  /** File name — Monaco infers the language from its extension. */
  name: string
  /** The pinned base revision's content. */
  original: string
  /** The working tree's content. */
  modified: string
  inline: boolean
  fontFamily?: string
  fontSize?: number
  wordWrap?: boolean
}

/**
 * Read-only diff of one file, base on the left and working tree on the right.
 *
 * Read-only in both panes, not just the left. The tree being shown may be under
 * active edit by an agent, so an editable right pane would offer a save that
 * either clobbers the agent's next write or is clobbered by it — and this pane
 * has no save path at all. A cursor that types nothing is a promise not to.
 */
export function DiffEditor({
  name,
  original,
  modified,
  inline,
  fontFamily,
  fontSize = 13,
  wordWrap = false
}: Props) {
  return (
    <MonacoDiff
      // Per-file paths so Monaco keeps one model pair per file rather than
      // re-tokenizing a shared model on every selection — and so the language is
      // inferred from this file's extension, not the last one viewed.
      originalModelPath={`diff-base/${name}`}
      modifiedModelPath={`diff-work/${name}`}
      original={original}
      modified={modified}
      theme="ssh-manager"
      loading={<span className="text-sm text-muted">Loading diff…</span>}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: !inline,
        // Whitespace-only changes are exactly what a formatter run looks like,
        // and hiding them would make a reformatted file read as unchanged.
        ignoreTrimWhitespace: false,
        renderOverviewRuler: true,
        fontSize,
        fontFamily: fontFamily ?? '"JetBrains Mono Variable", ui-monospace, Consolas, monospace',
        fontLigatures: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        // Same reasoning as CodeEditor: continuous repaints for animation the
        // user did not ask for, on a panel that may sit open beside a live agent.
        smoothScrolling: false,
        cursorSmoothCaretAnimation: 'off',
        cursorBlinking: 'solid',
        wordWrap: wordWrap ? 'on' : 'off',
        wrappingIndent: 'same',
        renderWhitespace: 'selection',
        scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        padding: { top: 12, bottom: 12 }
      }}
    />
  )
}
