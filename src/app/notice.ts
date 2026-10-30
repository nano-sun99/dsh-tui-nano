/**
 * Single-slot notice state with a TTL. Info notices expire; danger notices stay
 * until the next edit or replacement (spec §3.3).
 */

export const NOTICE_TTL_MS = 8000

export type NoticeTone = 'info' | 'danger'

export interface Notice {
  readonly text: string
  readonly tone: NoticeTone
  readonly expiresAt?: number
}

export class NoticeState {
  private currentNotice: Notice | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly onChange: () => void
  private readonly now: () => number

  constructor(onChange: () => void, now: () => number = () => Date.now()) {
    this.onChange = onChange
    this.now = now
  }

  get current(): Notice | undefined {
    return this.currentNotice
  }

  set(text: string | undefined, tone: NoticeTone = 'info'): void {
    this.clearTimer()
    if (text === undefined) {
      if (this.currentNotice === undefined) return
      this.currentNotice = undefined
      this.onChange()
      return
    }
    if (tone === 'info') {
      const expiresAt = this.now() + NOTICE_TTL_MS
      this.currentNotice = { text, tone, expiresAt }
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.currentNotice = undefined
        this.onChange()
      }, NOTICE_TTL_MS)
    } else {
      this.currentNotice = { text, tone }
    }
    this.onChange()
  }

  clear(): void {
    this.set(undefined)
  }

  dispose(): void {
    this.clearTimer()
    this.currentNotice = undefined
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
