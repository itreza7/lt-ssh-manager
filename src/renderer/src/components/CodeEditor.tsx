import Editor, { type OnMount } from '@monaco-editor/react'
import '../lib/monaco' // registers workers + the 'ssh-manager' theme

interface Props {
  /** File name — Monaco infers the language from its extension. */
  name: string
  value: string
  onChange: (value: string) => void
  fontFamily?: string
  fontSize?: number
  tabSize?: number
  wordWrap?: boolean
  minimap?: boolean
  lineNumbers?: boolean
  readOnly?: boolean
  onCursor?: (line: number, col: number) => void
  onLanguage?: (language: string) => void
}

export function CodeEditor({
  name,
  value,
  onChange,
  fontFamily,
  fontSize = 13,
  tabSize = 2,
  wordWrap = true,
  minimap = true,
  lineNumbers = true,
  readOnly,
  onCursor,
  onLanguage
}: Props) {
  const handleMount: OnMount = (editor) => {
    const report = (): void => {
      const model = editor.getModel()
      if (model) onLanguage?.(model.getLanguageId())
      const p = editor.getPosition()
      if (p) onCursor?.(p.lineNumber, p.column)
    }
    report()
    editor.onDidChangeCursorPosition((e) => onCursor?.(e.position.lineNumber, e.position.column))
    editor.onDidChangeModel(report)
    editor.focus()
  }

  return (
    <Editor
      path={name}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={handleMount}
      theme="ssh-manager"
      loading={<span className="text-sm text-muted">Loading editor…</span>}
      options={{
        readOnly,
        fontSize,
        fontFamily: fontFamily ?? '"JetBrains Mono Variable", ui-monospace, Consolas, monospace',
        fontLigatures: true,
        lineNumbers: lineNumbers ? 'on' : 'off',
        minimap: { enabled: minimap, renderCharacters: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        cursorBlinking: 'smooth',
        tabSize,
        wordWrap: wordWrap ? 'on' : 'off',
        wrappingIndent: 'same',
        renderWhitespace: 'selection',
        renderLineHighlight: 'all',
        stickyScroll: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        bracketPairColorization: { enabled: true },
        formatOnPaste: true,
        linkedEditing: true,
        autoClosingBrackets: 'languageDefined',
        suggestSelection: 'first',
        scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        padding: { top: 12, bottom: 12 }
      }}
    />
  )
}
