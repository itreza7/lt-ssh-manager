// Monaco setup for an OFFLINE desktop app: bundle the editor + its language
// workers locally (no CDN) and register a theme that matches the app.
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { loader } from '@monaco-editor/react'

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

// Use the bundled monaco instead of @monaco-editor/react's default CDN loader.
loader.config({ monaco })

monaco.editor.defineTheme('ssh-manager', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7a8597', fontStyle: 'italic' },
    { token: 'keyword', foreground: '46d98a' },
    { token: 'string', foreground: 'f3b75a' },
    { token: 'number', foreground: '7aa2f7' },
    { token: 'type', foreground: '7aa2f7' },
    { token: 'function', foreground: 'e8edf3' }
  ],
  colors: {
    'editor.background': '#0c0f15',
    'editor.foreground': '#e8edf3',
    'editorLineNumber.foreground': '#3a4654',
    'editorLineNumber.activeForeground': '#a3aec0',
    'editor.selectionBackground': '#7ca0d633',
    'editor.lineHighlightBackground': '#171c2566',
    'editorCursor.foreground': '#46d98a',
    'editorWidget.background': '#171c25',
    'editorWidget.border': '#2b3543',
    'editorIndentGuide.background1': '#20262f',
    'editorGutter.background': '#0c0f15',
    'scrollbarSlider.background': '#2b354366',
    'scrollbarSlider.hoverBackground': '#2b3543aa',
    'editorSuggestWidget.background': '#171c25',
    'editorSuggestWidget.border': '#2b3543',
    'editorSuggestWidget.selectedBackground': '#202934',
    'minimap.background': '#0a0d12'
  }
})

export { monaco }
