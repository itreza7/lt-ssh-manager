// Drop-to-upload: take local files (from an OS drag, or from the clipboard as an
// image or a Finder/Explorer copy), stage them on the host over SFTP, and put the
// resulting remote paths on a terminal's input line.
//
// This is the one thing a raw SSH client can't do. Telling a terminal agent about
// a screenshot or a log file otherwise means leaving the app, opening a second
// tool, uploading, and coming back with a path — here it's one gesture, and the
// path arrives already typed.
//
// Everything that could go wrong happens in the main process (see
// `sftp:upload-to`); what's left here is sequencing, progress, and the rule that
// a path is only ever *typed*, never run.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { injectPath } from './xtermAttach'

/** How long a finished status stays up before clearing itself. */
const DONE_MS = 3500
/** Failures stay longer — being read is the entire point of them. */
const ERROR_MS = 10000

/** Distinguishes one batch's progress events from every other transfer's. */
let seq = 0

export interface DropStatus {
  kind: 'busy' | 'done' | 'note' | 'error'
  text: string
  /** 0–1 while a file is moving; absent when there's no meaningful figure. */
  pct?: number
}

export interface DropUpload {
  /** Files are hovering over a terminal — draw the affordance. */
  over: boolean
  setOver: (v: boolean) => void
  /** What to show about the last/current batch; null when idle. */
  status: DropStatus | null
  dismiss: () => void
  /** Stage these local files, then type their remote paths on `term`. */
  drop: (paths: string[], term: XTerm | null) => void
  /** The same, for whatever's sitting on the clipboard — an image or file refs. */
  pasteUpload: (term: XTerm | null) => void
}

/** Local basename — either separator, since the renderer has no `node:path`. */
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

const busyText = (name: string, i: number, n: number): string =>
  n > 1 ? `Uploading ${name} · ${i} of ${n}` : `Uploading ${name}`

/**
 * IPC rejections arrive wrapped — "Error invoking remote method 'x': Error: …".
 * The strip is one line wide and the wrapper says nothing anyone can act on.
 */
function ipcMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

export function useDropUpload(connectionId: string, password?: string): DropUpload {
  const [over, setOver] = useState(false)
  const [status, setStatus] = useState<DropStatus | null>(null)
  // Batches run one after another. A second drop while the first is still moving
  // is rare but real, and queueing it is the only option that doesn't either
  // lose the files or interleave two sets of progress into one status line.
  const chain = useRef<Promise<void>>(Promise.resolve())
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const show = useCallback((s: DropStatus | null, clearAfter?: number) => {
    if (!alive.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setStatus(s)
    if (clearAfter) {
      timer.current = setTimeout(() => {
        if (alive.current) setStatus(null)
      }, clearAfter)
    }
  }, [])

  const dismiss = useCallback(() => show(null), [show])

  const run = useCallback(
    async (paths: string[], term: XTerm | null): Promise<void> => {
      const transferId = `stage-${connectionId}-${++seq}`
      let finished = 0
      show({ kind: 'busy', text: busyText(baseName(paths[0]), 1, paths.length), pct: 0 })

      const off = window.api.onSftpProgress((p) => {
        if (!p.transferId.startsWith(`${transferId}:`)) return
        if (p.done) {
          finished = Math.min(finished + 1, paths.length)
          return
        }
        show({
          kind: 'busy',
          text: busyText(p.name, Math.min(finished + 1, paths.length), paths.length),
          pct: p.total > 0 ? p.transferred / p.total : undefined
        })
      })

      try {
        const res = await window.api.sftpUploadTo({ connectionId, password, paths, transferId })
        // Type the paths before reporting: the point of the whole exercise is
        // the text on the line, and a partly-failed batch still delivers the
        // files that made it.
        if (term) {
          for (const f of res.files) injectPath(term, f.path)
          // A drop fires no mousedown, so nothing else hands the pane focus back.
          if (res.files.length) term.focus()
        }
        const [bad] = res.errors
        if (bad) {
          show(
            {
              kind: 'error',
              text:
                res.errors.length > 1
                  ? `${res.errors.length} files failed — ${bad.name}: ${bad.error}`
                  : `${bad.name}: ${bad.error}`
            },
            ERROR_MS
          )
        } else if (res.files.length === 1) {
          show({ kind: 'done', text: res.files[0].path }, DONE_MS)
        } else {
          show({ kind: 'done', text: `Staged ${res.files.length} files` }, DONE_MS)
        }
      } catch (e) {
        show({ kind: 'error', text: ipcMessage(e) }, ERROR_MS)
      } finally {
        off()
      }
    },
    [connectionId, password, show]
  )

  const drop = useCallback(
    (paths: string[], term: XTerm | null): void => {
      if (!paths.length) return
      chain.current = chain.current.then(() => run(paths, term))
    },
    [run]
  )

  const pasteUpload = useCallback(
    (term: XTerm | null): void => {
      chain.current = chain.current.then(async () => {
        let files: string[]
        try {
          // Image first — a screenshot has no file-list form, only a bitmap. If
          // there isn't one, fall back to whatever file references (a Finder/
          // Explorer copy) are on the clipboard instead.
          const image = await window.api.clipboardImageToTemp()
          files = image ? [image] : await window.api.clipboardFilesToPaths()
        } catch (e) {
          show({ kind: 'error', text: ipcMessage(e) }, ERROR_MS)
          return
        }
        // Nothing to paste is the common outcome of a chord pressed by habit,
        // so it's a note rather than a failure.
        if (!files.length) {
          show({ kind: 'note', text: 'No image or file on the clipboard.' }, DONE_MS)
          return
        }
        await run(files, term)
      })
    },
    [run, show]
  )

  return { over, setOver, status, dismiss, drop, pasteUpload }
}
