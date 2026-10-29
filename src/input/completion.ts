/**
 * Completion providers and the open-input mode (D01). While a completion
 * session is open, Enter accepts the selected item instead of submitting;
 * Tab inserts without executing.
 */

export type CompletionKind = 'file' | 'command' | 'skill'

export interface CompletionItem {
  readonly label: string
  /** Text inserted when accepted (defaults to `label`). */
  readonly insert?: string
  readonly kind: CompletionKind
  readonly description?: string
}

export interface CompletionProvider {
  readonly id: string
  readonly kind: CompletionKind
  complete(query: string, context?: unknown): CompletionItem[] | Promise<CompletionItem[]>
}

export const COMPLETION_LIMIT = 50

export class CompletionRegistry {
  private readonly providers = new Map<string, CompletionProvider>()

  register(provider: CompletionProvider): () => void {
    this.providers.set(provider.id, provider)
    return () => {
      this.providers.delete(provider.id)
    }
  }

  providersOf(kind: CompletionKind): CompletionProvider[] {
    return [...this.providers.values()].filter((provider) => provider.kind === kind)
  }

  /** Query every provider of one kind; failures are reported, not swallowed silently. */
  async query(
    kind: CompletionKind,
    query: string,
    context?: unknown,
  ): Promise<{ items: CompletionItem[]; failures: Array<{ id: string; error: unknown }> }> {
    const items: CompletionItem[] = []
    const failures: Array<{ id: string; error: unknown }> = []
    for (const provider of this.providersOf(kind)) {
      try {
        const result = await provider.complete(query, context)
        items.push(...result)
      } catch (error) {
        failures.push({ id: provider.id, error })
      }
    }
    return { items: items.slice(0, COMPLETION_LIMIT), failures }
  }
}

export class CompletionSession {
  private state:
    | { kind: CompletionKind; query: string; items: CompletionItem[]; selected: number }
    | undefined

  get isOpen(): boolean {
    return this.state !== undefined
  }

  get kind(): CompletionKind | undefined {
    return this.state?.kind
  }

  get items(): readonly CompletionItem[] {
    return this.state?.items ?? []
  }

  get selectedIndex(): number {
    return this.state?.selected ?? 0
  }

  get selected(): CompletionItem | undefined {
    return this.state?.items[this.state.selected]
  }

  /** Empty results still open the mode so Enter does not submit a half-typed trigger. */
  open(kind: CompletionKind, query: string, items: CompletionItem[]): void {
    this.state = { kind, query, items: items.slice(0, COMPLETION_LIMIT), selected: 0 }
  }

  update(items: CompletionItem[]): void {
    if (!this.state) return
    this.state = { ...this.state, items: items.slice(0, COMPLETION_LIMIT), selected: 0 }
  }

  move(delta: number): void {
    if (!this.state || this.state.items.length === 0) return
    const selected =
      (this.state.selected + delta + this.state.items.length) % this.state.items.length
    this.state = { ...this.state, selected }
  }

  /** Accept the selection; closes the session and returns the inserted text. */
  accept(): string | undefined {
    const item = this.selected
    if (!item) return undefined
    this.state = undefined
    return item.insert ?? item.label
  }

  close(): void {
    this.state = undefined
  }
}
