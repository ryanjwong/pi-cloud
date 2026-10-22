import type { Frame, Link } from "@earendil-works/chord"

export class FrameLink implements Link {
  readonly #transmit: (frames: ReadonlyArray<Frame>) => void
  #handler: ((frame: Frame) => void) | undefined
  readonly #received: Array<Frame> = []
  readonly #closeHandlers = new Set<(reason: string) => void>()
  #outgoing: Array<Frame> = []
  #scheduled = false
  #closed = false

  constructor(transmit: (frames: ReadonlyArray<Frame>) => void) {
    this.#transmit = transmit
  }

  get closed() {
    return this.#closed
  }

  send(frame: Frame): undefined {
    if (this.#closed) return undefined
    this.#outgoing.push(frame)
    if (!this.#scheduled) {
      this.#scheduled = true
      queueMicrotask(() => this.#flush())
    }
    return undefined
  }

  receive(handler: (frame: Frame) => void): void {
    this.#handler = handler
    for (const frame of this.#received.splice(0)) handler(frame)
  }

  onClose(handler: (reason: string) => void): void {
    if (this.#closed) handler("closed")
    else this.#closeHandlers.add(handler)
  }

  close(reason = "closed"): void {
    if (this.#closed) return
    this.#outgoing.push({ t: "bye", reason } as Frame)
    this.#flush()
    this.end(reason)
  }

  deliver(frames: ReadonlyArray<unknown>): void {
    for (const frame of frames as ReadonlyArray<Frame>) {
      if (this.#closed) return
      if (frame.t === "bye") return this.end((frame as { reason?: string }).reason ?? "peer closed")
      if (this.#handler === undefined) this.#received.push(frame)
      else this.#handler(frame)
    }
  }

  end(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    for (const handler of this.#closeHandlers) handler(reason)
    this.#closeHandlers.clear()
  }

  #flush() {
    this.#scheduled = false
    if (this.#outgoing.length === 0) return
    const frames = this.#outgoing
    this.#outgoing = []
    try {
      this.#transmit(JSON.parse(JSON.stringify(frames)))
    } catch {
      this.end("transport failed")
    }
  }
}
