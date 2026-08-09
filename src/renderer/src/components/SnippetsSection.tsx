import { useEffect, useState } from 'react'
import type { Snippet } from '../../../shared/types'
import { Button, Modal } from './Modal'

const blankSnippet = (): Snippet => ({ id: crypto.randomUUID(), name: '', body: '' })

/** Settings' snippets list editor. Self-contained — loads and persists its own
 * data, same shape as TunnelManager but global rather than per-connection. */
export function SnippetsSection() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [editing, setEditing] = useState<Snippet | null>(null) // null = closed
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void window.api.snippetsList().then((s) => {
      setSnippets(s)
      setLoaded(true)
    })
  }, [])

  const saveSnippet = (s: Snippet): void => {
    setSnippets((prev) => {
      const i = prev.findIndex((p) => p.id === s.id)
      return i >= 0 ? prev.map((p) => (p.id === s.id ? s : p)) : [...prev, s]
    })
    void window.api.snippetsSave(s)
    setEditing(null)
  }

  const removeSnippet = (s: Snippet): void => {
    setSnippets((prev) => prev.filter((p) => p.id !== s.id))
    void window.api.snippetsDelete(s.id)
  }

  return (
    <div>
      <div className="animate-rise mb-5 flex items-end justify-between gap-6">
        <p className="max-w-md text-sm text-muted">
          Reusable text blocks for the prompt composer. Type <code className="text-accent">/</code> or use its
          footer button to insert one.
        </p>
        <Button variant="primary" onClick={() => setEditing(blankSnippet())}>
          + New snippet
        </Button>
      </div>

      {loaded && snippets.length === 0 && (
        <div className="panel animate-rise flex flex-col items-center gap-3 px-6 py-12 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-accent/10 font-mono text-accent ring-1 ring-accent/25">
            /
          </div>
          <p className="text-sm text-muted">No snippets yet.</p>
          <p className="eyebrow">save one to get started</p>
        </div>
      )}

      <div className="space-y-2.5">
        {snippets.map((s, i) => (
          <div
            key={s.id}
            style={{ animationDelay: `${i * 30}ms` }}
            className="panel animate-rise flex items-center gap-4 px-4 py-3.5"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg">{s.name}</div>
              <div className="mt-0.5 truncate font-mono text-[12px] text-muted">{s.body}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => setEditing(s)}
                className="rounded-md px-2 py-1.5 text-faint transition-colors hover:text-fg"
                title="Edit"
              >
                ✎
              </button>
              <button
                onClick={() => removeSnippet(s)}
                className="rounded-md px-2 py-1.5 text-faint transition-colors hover:text-danger"
                title="Delete"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <SnippetForm
          initial={editing}
          existing={snippets.some((s) => s.id === editing.id)}
          onCancel={() => setEditing(null)}
          onSave={saveSnippet}
        />
      )}
    </div>
  )
}

function SnippetForm({
  initial,
  existing,
  onCancel,
  onSave
}: {
  initial: Snippet
  existing: boolean
  onCancel: () => void
  onSave: (s: Snippet) => void
}) {
  const [name, setName] = useState(initial.name)
  const [body, setBody] = useState(initial.body)
  const valid = name.trim() !== '' && body.trim() !== ''

  const submit = (): void => {
    if (!valid) return
    onSave({ id: initial.id, name: name.trim(), body })
  }

  return (
    <Modal
      title={existing ? 'Edit snippet' : 'New snippet'}
      width={480}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!valid}>
            {existing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={setName} placeholder="e.g. deploy checklist" />
        </Field>
        <Field label="Body">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What gets inserted at the cursor"
            rows={6}
            className="w-full resize-none rounded-lg border border-line bg-ink/60 px-2.5 py-1.5 font-mono text-[13px] leading-relaxed text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/60"
          />
        </Field>
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-1.5 block">{label}</span>
      {children}
    </label>
  )
}

function Input({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg border border-line bg-ink/60 px-2.5 py-1.5 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/60"
    />
  )
}
