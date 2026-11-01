/** Root-only activity projection. Official turn/attempt identities own all boundaries. */
export const TAILS = ['official', 'wag', 'sway', 'twist'] as const
export type Tail = (typeof TAILS)[number]
export interface Activity {
  readonly text: string
  readonly tail?: Tail
  readonly requestKey?: string
  readonly startedAt?: number
}
export class ActivityState {
  private active = false
  private pending = false
  private stopping = false
  private turn: number | undefined
  private endedTurn = -1
  private attempt: string | undefined
  private revision = -1
  private streaming = false
  private visibleBody = false
  private phase = '正在处理…'
  private tail: Tail | undefined
  private startedAt = 0
  private tools = new Map<string, string>()
  constructor(private readonly random: () => number = Math.random) {}
  accepted(): void {
    if (!this.active) this.pending = true
  }
  rejected(): void {
    this.pending = false
  }
  get isWorking(): boolean {
    return this.active || this.pending
  }
  running(): void {
    this.active = true
  }
  startTurn(turn: number): boolean {
    if (
      !Number.isFinite(turn) ||
      turn <= this.endedTurn ||
      (this.turn !== undefined && turn < this.turn)
    )
      return false
    if (turn !== this.turn) {
      this.clearWork()
      this.turn = turn
    }
    this.active = true
    this.pending = false
    return true
  }
  endTurn(turn?: number): boolean {
    if (turn !== undefined && this.turn !== undefined && turn !== this.turn) return false
    if (turn !== undefined) this.endedTurn = Math.max(this.endedTurn, turn)
    this.active = false
    this.pending = false
    this.clearWork()
    return true
  }
  private clearWork(): void {
    this.stopping = false
    this.attempt = undefined
    this.streaming = false
    this.visibleBody = false
    this.tail = undefined
    this.tools.clear()
    this.phase = '正在处理…'
  }
  stop(): void {
    if (this.active || this.pending) this.stopping = true
  }
  start(
    frame: { attemptId?: unknown; revision?: number; turn?: number },
    now = Date.now(),
  ): boolean {
    if (typeof frame.attemptId !== 'string' || !frame.attemptId) return false
    if (
      frame.attemptId === this.attempt ||
      (frame.revision !== undefined && frame.revision <= this.revision)
    )
      return false
    if (
      frame.turn !== undefined &&
      (frame.turn <= this.endedTurn || (this.turn !== undefined && frame.turn < this.turn))
    )
      return false
    if (!this.active && !this.pending && frame.turn === undefined) return false
    if (frame.turn !== undefined) this.turn = frame.turn
    this.active = true
    this.pending = false
    this.attempt = frame.attemptId
    this.revision = frame.revision ?? this.revision + 1
    this.streaming = true
    this.visibleBody = false
    this.phase = '正在处理…'
    this.tail = TAILS[Math.min(3, Math.max(0, Math.floor(this.random() * 4)))]
    this.startedAt = now
    return true
  }
  frame(frame: { attemptId?: unknown; revision?: number }): boolean {
    if (!this.active || !this.streaming || frame.attemptId !== this.attempt) return false
    if (frame.revision !== undefined && frame.revision <= this.revision) return false
    if (frame.revision !== undefined) this.revision = frame.revision
    return true
  }
  reasoning(text: string): void {
    if (text.trim()) this.phase = '思考中…'
  }
  parameters(): void {
    this.phase = '正在准备工具…'
  }
  body(text: string): void {
    if (text.trim()) this.visibleBody = true
  }
  endAttempt(): void {
    this.streaming = false
  }
  toolStart(callId: string, name: string, turn?: number): void {
    if (!this.acceptsTurn(turn) || !callId) return
    this.tools.set(callId, name)
    // A later explicit tool phase may resume feedback after a committed answer.
    if (!this.streaming) this.visibleBody = false
  }
  toolEnd(callId: string, turn?: number): void {
    if (this.acceptsTurn(turn)) this.tools.delete(callId)
  }
  acceptsTurn(turn?: number): boolean {
    return (
      this.active &&
      (turn === undefined ||
        (turn > this.endedTurn && (this.turn === undefined || turn === this.turn)))
    )
  }
  project(waiting?: 'approval' | 'question' | 'plan-review', owned = true): Activity {
    if (!owned) return { text: '' }
    if (waiting)
      return {
        text:
          waiting === 'approval'
            ? '等待你的授权'
            : waiting === 'plan-review'
              ? '等待你审阅计划'
              : '等待你的选择',
      }
    if (this.stopping) return { text: '正在停止…' }
    if ((!this.active && !this.pending) || this.visibleBody) return { text: '' }
    let text = this.phase
    if (this.tools.size > 1) text = `正在运行 ${this.tools.size} 个工具…`
    else if (this.tools.size === 1) {
      const name = [...this.tools.values()][0]
      text = name ? `正在运行 ${name}…` : '正在运行工具…'
    }
    return {
      text,
      ...(this.tail
        ? { tail: this.tail, requestKey: this.attempt, startedAt: this.startedAt }
        : {}),
    }
  }
}
