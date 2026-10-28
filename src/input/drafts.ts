/**
 * In-memory drafts and reading anchors keyed by address (D01). Drafts never
 * cross processes (ADR-20261022-input-history); anchors are per session.
 */

export interface Draft {
  readonly text: string
  readonly cursor: number
  /** Scroll anchor: 0 = sticky bottom, otherwise lines from the bottom. */
  readonly scrollAnchor: number
}

export interface DraftAddress {
  /** Root session identity. */
  readonly root: string
  /** Subagent address, when the draft belongs to a child. */
  readonly subagent?: string
}

export class DraftStore {
  private readonly drafts = new Map<string, Draft>()

  save(address: DraftAddress, draft: Draft): void {
    this.drafts.set(key(address), draft)
  }

  get(address: DraftAddress): Draft | undefined {
    return this.drafts.get(key(address))
  }

  clear(address: DraftAddress): void {
    this.drafts.delete(key(address))
  }

  clearAll(): void {
    this.drafts.clear()
  }

  get size(): number {
    return this.drafts.size
  }
}

function key(address: DraftAddress): string {
  return `${address.root}\u0000${address.subagent ?? ''}`
}
