/**
 * Input history (ADR-20261022-input-history): `<dataRoot>/history.jsonl`, one
 * JSON object per submitted input. Reads only the current project's tail, up
 * to 100 entries, current session first. Drafts stay in memory.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export interface HistoryEntry {
  readonly display: string
  readonly timestamp: number
  readonly project: string
  readonly sessionId: string
}

export class HistoryStore {
  private readonly path: string
  private readonly project: string
  private readonly sessionId: () => string

  constructor(path: string, project: string, sessionId: () => string) {
    this.path = path
    this.project = project
    this.sessionId = sessionId
  }

  /** Append one submitted display string; the file is created 0600. */
  record(display: string): void {
    const trimmed = display.trim()
    if (trimmed === '') return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const entry: HistoryEntry = {
      display: trimmed,
      timestamp: Date.now(),
      project: this.project,
      sessionId: this.sessionId(),
    }
    const fd = openSync(this.path, 'a', 0o600)
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`)
    } finally {
      closeSync(fd)
    }
  }

  /** History for the current project, newest first, at most `limit` entries. */
  entries(limit = 100): HistoryEntry[] {
    if (!existsSync(this.path)) return []
    const entries: HistoryEntry[] = []
    for (const line of readTailLines(this.path, 256 * 1024)) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as Partial<HistoryEntry>
        if (
          typeof parsed.display === 'string' &&
          typeof parsed.timestamp === 'number' &&
          parsed.project === this.project
        ) {
          entries.push({
            display: parsed.display,
            timestamp: parsed.timestamp,
            project: parsed.project,
            sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
          })
        }
      } catch {
        // A torn final line from a crash is ignored; history is best effort.
      }
    }
    const currentSession = this.sessionId()
    const indexed = entries.map((entry, index) => ({ entry, index }))
    indexed.sort((a, b) => {
      const aCurrent = a.entry.sessionId === currentSession ? 1 : 0
      const bCurrent = b.entry.sessionId === currentSession ? 1 : 0
      if (aCurrent !== bCurrent) return bCurrent - aCurrent
      if (b.entry.timestamp !== a.entry.timestamp) return b.entry.timestamp - a.entry.timestamp
      return b.index - a.index
    })
    return indexed.slice(0, limit).map((item) => item.entry)
  }
}

/** Read up to `maxBytes` from the end of a file, dropping a torn first line. */
function readTailLines(path: string, maxBytes: number): string[] {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    const lines = text.split('\n')
    if (start > 0) lines.shift()
    return lines
  } finally {
    closeSync(fd)
  }
}
