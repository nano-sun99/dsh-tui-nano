/**
 * Scene and focus registration (D01). A scene is a named interactive surface
 * (main transcript, a terminal pane, an approval overlay). Only the top scene
 * receives keys; Escape closes the topmost closable scene.
 */

export type SceneKind = 'main' | 'pane' | 'overlay'

export interface Scene {
  readonly id: string
  readonly kind: SceneKind
  readonly title?: string
  /** Whether Escape may close this scene. Main is never closable. */
  readonly closable?: boolean
  /** Higher wins when two scenes share the same priority tier. */
  readonly priority?: number
}

export class SceneRegistry {
  private readonly scenes = new Map<string, Scene>()
  private stack: string[] = ['main']
  private readonly listeners = new Set<() => void>()

  constructor() {
    this.scenes.set('main', { id: 'main', kind: 'main', closable: false })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  register(scene: Scene): () => void {
    this.scenes.set(scene.id, scene)
    if (scene.kind !== 'main' && !this.stack.includes(scene.id)) this.stack.push(scene.id)
    this.notify()
    return () => this.unregister(scene.id)
  }

  unregister(id: string): void {
    if (id === 'main') return
    this.scenes.delete(id)
    this.stack = this.stack.filter((entry) => entry !== id)
    this.notify()
  }

  get active(): Scene {
    const id = this.stack[this.stack.length - 1] ?? 'main'
    return this.scenes.get(id) ?? (this.scenes.get('main') as Scene)
  }

  focus(id: string): boolean {
    if (!this.scenes.has(id)) return false
    this.stack = this.stack.filter((entry) => entry !== id)
    this.stack.push(id)
    this.notify()
    return true
  }

  /** Close the top closable scene (Escape layering). */
  escape(): string | undefined {
    for (let index = this.stack.length - 1; index >= 1; index--) {
      const id = this.stack[index] as string
      const scene = this.scenes.get(id)
      if (scene?.closable) {
        this.unregister(id)
        return id
      }
    }
    return undefined
  }

  list(): readonly Scene[] {
    return this.stack
      .map((id) => this.scenes.get(id))
      .filter((scene): scene is Scene => scene !== undefined)
  }
}
