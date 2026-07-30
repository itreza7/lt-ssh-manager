/**
 * Coalesces a byte stream into at most one emit per time window.
 *
 * A busy PTY hands us many small chunks — roughly one per TCP read — and each
 * one forwarded on its own costs a structured clone plus a renderer wake-up,
 * which dwarfs the cost of the bytes themselves. `ls` on a large directory can
 * be dozens of chunks and dozens of wake-ups for a single frame of output.
 *
 * This is a leading-edge throttle: the first chunk after an idle gap goes out
 * immediately, so keystroke echo keeps zero added latency, and anything arriving
 * while the window is open is merged and sent when it closes.
 *
 * Bytes are passed through as Buffers, never decoded here. A UTF-8 sequence can
 * straddle a chunk boundary, so decoding per chunk would corrupt multi-byte
 * characters into U+FFFD; the consumer (xterm) decodes the stream itself and
 * carries partial sequences across writes correctly.
 */
export class ByteBatcher {
  private chunks: Buffer[] = []
  private size = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly emit: (data: Buffer) => void,
    /** Coalescing window. Well under a frame, so batching is never visible. */
    private readonly windowMs = 8,
    /** Flush early rather than buffer more than this, to bound memory. */
    private readonly maxBytes = 512 * 1024
  ) {}

  push(chunk: Buffer): void {
    if (this.disposed || chunk.length === 0) return
    if (!this.timer) {
      // Idle: nothing pending and no window open, so send straight through.
      this.emit(chunk)
      this.arm()
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.size >= this.maxBytes) this.flush()
  }

  /** Emit whatever is buffered and reopen the window if data is still flowing. */
  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const data = this.take()
    if (!data || this.disposed) return
    this.emit(data)
    this.arm()
  }

  private take(): Buffer | null {
    if (this.chunks.length === 0) return null
    const data = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.size)
    this.chunks = []
    this.size = 0
    return data
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.chunks.length > 0) this.flush()
    }, this.windowMs)
  }

  /**
   * Emit any buffered tail synchronously, then stop accepting data. Callers tear
   * down before announcing that a session ended, so the last bytes a shell wrote
   * still land ahead of the "session closed" notice.
   */
  dispose(): void {
    if (this.disposed) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const data = this.take()
    this.disposed = true
    if (data) this.emit(data)
  }
}
