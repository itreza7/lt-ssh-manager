import { useEffect, useState } from 'react'
import { CodeEditor } from './CodeEditor'
import { MarkdownPreview } from './MarkdownPreview'
import { Button } from './Modal'
import { resolveFontStack } from '../lib/terminalSettings'
import type { EditorSettings } from '../lib/terminalSettings'

const isMarkdown = (name: string): boolean => /\.(md|markdown|mdown|mkd)$/i.test(name)

interface Props {
  connectionId: string
  password?: string
  path: string
  name: string
  active: boolean
  settings: EditorSettings
}

type Status = 'loading' | 'ready' | 'error'

export function EditorView({ connectionId, password, path, name, active, settings }: Props) {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [pos, setPos] = useState({ line: 1, col: 1 })
  const [lang, setLang] = useState('plaintext')
  // Markdown opens in read (preview) mode by default (per settings); everything else edits.
  const markdown = isMarkdown(name)
  const [mode, setMode] = useState<'edit' | 'preview'>(
    markdown && settings.markdownPreview ? 'preview' : 'edit'
  )
  const dirty = content !== saved

  // Reuse the connection's shared SFTP channel (kept warm by the pool), read once.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await window.api.sftpOpen({ connectionId, password })
        const res = await window.api.sftpReadFile({ connectionId, path })
        if (cancelled) return
        setContent(res.content)
        setSaved(res.content)
        setReadOnly(res.readOnly)
        setStatus('ready')
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      window.api.sftpClose(connectionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, path])

  const save = async (): Promise<void> => {
    if (readOnly) return
    setSaving(true)
    setError(null)
    try {
      await window.api.sftpWriteFile({ connectionId, path, content })
      setSaved(content)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Ctrl/Cmd+S saves, only while this tab is active.
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty && !saving) void save()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, dirty, saving, content])

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        <span className="animate-glow mr-2 text-signal">⟳</span> Opening {name}…
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <div className="text-sm text-danger">Could not open this file.</div>
        <div className="max-w-md font-mono text-xs text-faint">{error}</div>
      </div>
    )
  }

  const lineCount = content.length === 0 ? 1 : content.split('\n').length

  return (
    <div className="flex h-full flex-col bg-ink">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-surface/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm text-fg">{name}</span>
          {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" title="Unsaved changes" />}
          {readOnly && (
            <span className="shrink-0 rounded-full border border-line bg-elevated/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
              read-only · large file
            </span>
          )}
          <span className="truncate font-mono text-[11px] text-faint">{path}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error && <span className="font-mono text-xs text-danger">{error}</span>}
          {markdown && (
            <div className="flex rounded-lg border border-line p-0.5 text-xs">
              {(['preview', 'edit'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-md px-2.5 py-1 capitalize transition-colors ${
                    mode === m ? 'bg-signal/20 text-signal' : 'text-muted hover:text-fg'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          {!readOnly && (
            <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {mode === 'preview' ? (
          <MarkdownPreview source={content} fontSize={settings.fontSize + 1} />
        ) : (
          <CodeEditor
            name={name}
            value={content}
            onChange={setContent}
            fontFamily={resolveFontStack(settings.fontFamily)}
            fontSize={settings.fontSize}
            tabSize={settings.tabSize}
            wordWrap={settings.wordWrap}
            minimap={settings.minimap}
            lineNumbers={settings.lineNumbers}
            readOnly={readOnly}
            onCursor={(line, col) => setPos({ line, col })}
            onLanguage={setLang}
          />
        )}
      </div>

      {/* status bar */}
      <div className="flex shrink-0 items-center gap-4 border-t border-line bg-surface/60 px-4 py-1 font-mono text-[11px] text-faint">
        <span className="uppercase tracking-wide text-muted">{markdown ? 'markdown' : lang}</span>
        {readOnly && <span className="text-amber">read-only</span>}
        <div className="flex-1" />
        {mode === 'edit' && (
          <>
            <span>{lineCount} lines</span>
            <span>
              Ln {pos.line}, Col {pos.col}
            </span>
          </>
        )}
        <span>UTF-8</span>
      </div>
    </div>
  )
}
