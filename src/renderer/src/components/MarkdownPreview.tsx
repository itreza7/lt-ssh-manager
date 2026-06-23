import { useMemo } from 'react'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'

// html:false escapes any raw HTML in the source, so rendering remote/untrusted
// markdown can't inject markup — only markdown-it's own safe tags are emitted.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
  // Highlight fenced code blocks; return a full <pre> so markdown-it uses it verbatim.
  highlight: (str: string, lang: string): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const code = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        return `<pre class="hljs"><code>${code}</code></pre>`
      } catch {
        /* fall through to plain escaping */
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(str)}</code></pre>`
  }
})

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function MarkdownPreview({ source, fontSize }: { source: string; fontSize?: number }) {
  const html = useMemo(() => md.render(source), [source])

  // Links open in the OS browser (http/https only); never navigate the app.
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href')
    if (href) window.api.openExternal(href)
  }

  return (
    <div className="h-full overflow-y-auto bg-ink px-10 py-8">
      <div
        className="md-body mx-auto max-w-3xl"
        style={fontSize ? { fontSize } : undefined}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
