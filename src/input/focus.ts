/** Single-focus layer stack: overlays sit on top and take focus first. */
export class FocusStack {
  private stack: string[] = []

  push(id: string): void {
    this.stack = this.stack.filter((entry) => entry !== id)
    this.stack.push(id)
  }

  pop(id?: string): void {
    if (id === undefined) {
      this.stack.pop()
      return
    }
    this.stack = this.stack.filter((entry) => entry !== id)
  }

  top(): string | undefined {
    return this.stack[this.stack.length - 1]
  }

  has(id: string): boolean {
    return this.stack.includes(id)
  }

  clear(): void {
    this.stack = []
  }

  get layers(): readonly string[] {
    return this.stack
  }
}
