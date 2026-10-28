/** Editable single-buffer input with grapheme-aware cursor and history recall. */
import { graphemes } from '../render/text.ts'

export class InputModel {
  text = ''
  /** Cursor position in grapheme units. */
  cursor = 0
  private history: string[] = []
  private historyIndex = -1
  private draft = ''

  setHistory(entries: readonly string[]): void {
    this.history = entries.slice()
    this.historyIndex = -1
  }

  get graphemes(): string[] {
    return graphemes(this.text)
  }

  insert(text: string): void {
    const chars = this.graphemes
    const head = chars.slice(0, this.cursor).join('')
    const tail = chars.slice(this.cursor).join('')
    this.text = head + text + tail
    this.cursor += graphemes(text).length
  }

  backspace(): void {
    if (this.cursor === 0) return
    const chars = this.graphemes
    chars.splice(this.cursor - 1, 1)
    this.text = chars.join('')
    this.cursor -= 1
  }

  deleteForward(): void {
    const chars = this.graphemes
    if (this.cursor >= chars.length) return
    chars.splice(this.cursor, 1)
    this.text = chars.join('')
  }

  left(): void {
    if (this.cursor > 0) this.cursor--
  }

  right(): void {
    if (this.cursor < this.graphemes.length) this.cursor++
  }

  wordLeft(): void {
    const chars = this.graphemes
    let index = this.cursor
    while (index > 0 && isSpace(chars[index - 1])) index--
    while (index > 0 && !isSpace(chars[index - 1])) index--
    this.cursor = index
  }

  wordRight(): void {
    const chars = this.graphemes
    let index = this.cursor
    while (index < chars.length && !isSpace(chars[index])) index++
    while (index < chars.length && isSpace(chars[index])) index++
    this.cursor = index
  }

  home(): void {
    this.cursor = 0
  }

  end(): void {
    this.cursor = this.graphemes.length
  }

  deleteWord(): void {
    const chars = this.graphemes
    let index = this.cursor
    while (index > 0 && isSpace(chars[index - 1])) index--
    while (index > 0 && !isSpace(chars[index - 1])) index--
    chars.splice(index, this.cursor - index)
    this.text = chars.join('')
    this.cursor = index
  }

  clear(): void {
    this.text = ''
    this.cursor = 0
  }

  take(): string {
    const value = this.text
    this.clear()
    this.historyIndex = -1
    this.draft = ''
    return value
  }

  previousHistory(): void {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) {
      this.draft = this.text
      this.historyIndex = 0
    } else if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++
    }
    this.text = this.history[this.historyIndex] ?? ''
    this.cursor = this.graphemes.length
  }

  nextHistory(): void {
    if (this.historyIndex === -1) return
    if (this.historyIndex > 0) {
      this.historyIndex--
      this.text = this.history[this.historyIndex] ?? ''
    } else {
      this.historyIndex = -1
      this.text = this.draft
    }
    this.cursor = this.graphemes.length
  }

  get isHistoryBrowsing(): boolean {
    return this.historyIndex >= 0
  }
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char)
}
