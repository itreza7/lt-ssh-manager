import { createRoot } from 'react-dom/client'
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/fira-code'
import App from './App'
import './index.css'

// A file or link dropped anywhere without its own handler — the sidebar, the tab
// strip, a settings page — is navigation as far as Chromium is concerned: it
// loads `file:///…` in place, which unmounts this entire tree and kills every
// live SSH session with it. preventDefault, not stopPropagation, so the drop
// targets that *do* want files (terminals, the file manager) still get their
// events; this only removes the default action underneath them. Main enforces the
// same rule on `will-navigate` in case anything ever gets past here.
//
// Text fields are the exception, and only for payloads that can't navigate:
// cancelling in the capture phase runs before the field's own handling, so an
// unconditional guard would silently break dragging text into the composer, a
// host field, or a rename box — including drag-to-move within one textarea.
const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)

for (const type of ['dragover', 'drop']) {
  window.addEventListener(
    type,
    (e) => {
      const files = !!(e as DragEvent).dataTransfer?.types.includes('Files')
      if (files || !editable(e.target)) e.preventDefault()
    },
    { capture: true }
  )
}

// No StrictMode: its double-invoked effects would open two SSH sessions per tab.
createRoot(document.getElementById('root')!).render(<App />)
