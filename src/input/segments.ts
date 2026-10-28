/**
 * Ordered input content (D01): text and attachment segments keep their exact
 * order through preview and submission. S02 builds these; the composer renders
 * and submits them in order.
 */

export interface TextSegment {
  readonly kind: 'text'
  readonly id: string
  readonly text: string
}

export interface AttachmentSegment {
  readonly kind: 'attachment'
  readonly id: string
  readonly label: string
  readonly reference?: unknown
}

export type InputSegment = TextSegment | AttachmentSegment

/** 32 KiB submission cap (attachments count by reference, not image base64). */
export const INPUT_BYTE_LIMIT = 32 * 1024

export class InputSegments {
  private readonly list: InputSegment[] = []
  private counter = 0

  get segments(): readonly InputSegment[] {
    return this.list
  }

  pushText(text: string, index?: number): TextSegment {
    const segment: TextSegment = { kind: 'text', id: `t${++this.counter}`, text }
    this.insert(segment, index)
    return segment
  }

  pushAttachment(label: string, reference?: unknown, index?: number): AttachmentSegment {
    const segment: AttachmentSegment = {
      kind: 'attachment',
      id: `a${++this.counter}`,
      label,
      ...(reference !== undefined ? { reference } : {}),
    }
    this.insert(segment, index)
    return segment
  }

  remove(id: string): boolean {
    const index = this.list.findIndex((segment) => segment.id === id)
    if (index < 0) return false
    this.list.splice(index, 1)
    return true
  }

  move(id: string, index: number): void {
    const from = this.list.findIndex((segment) => segment.id === id)
    if (from < 0) return
    const [segment] = this.list.splice(from, 1)
    if (!segment) return
    const target = Math.max(0, Math.min(this.list.length, index))
    this.list.splice(target, 0, segment)
  }

  clear(): void {
    this.list.length = 0
  }

  /** Concatenated text in order (attachments contribute nothing). */
  orderedText(): string {
    return this.list.map((segment) => (segment.kind === 'text' ? segment.text : '')).join('')
  }

  attachments(): AttachmentSegment[] {
    return this.list.filter(
      (segment): segment is AttachmentSegment => segment.kind === 'attachment',
    )
  }

  /** Approximate submission size, including attachment label/reference bytes. */
  byteSize(): number {
    let bytes = 0
    for (const segment of this.list) {
      if (segment.kind === 'text') bytes += Buffer.byteLength(segment.text, 'utf8')
      else bytes += Buffer.byteLength(segment.label, 'utf8') + 32
    }
    return bytes
  }

  exceedsLimit(limit = INPUT_BYTE_LIMIT): boolean {
    return this.byteSize() > limit
  }

  private insert(segment: InputSegment, index?: number): void {
    if (index === undefined || index < 0 || index > this.list.length) this.list.push(segment)
    else this.list.splice(index, 0, segment)
  }
}
