// 最小 VT 屏幕模型：只覆盖 nano 渲染器实际发出的序列
// （光标定位、清屏/清行、SGR、回车换行、宽字符）。用于 PTY 测试断言最终屏幕，
// 不需要开窗口。
import stringWidth from 'string-width'

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC is the intended input.
const CSI = /\x1b\[([0-9;?<>]*)([A-Za-z])/y

export class Screen {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.rows = Array.from({ length: height }, () => Array(width).fill(' '))
    this.row = 0
    this.col = 0
  }

  feed(text) {
    let index = 0
    while (index < text.length) {
      const char = text[index]
      if (char === '\x1b') {
        CSI.lastIndex = index
        const match = CSI.exec(text)
        if (match) {
          this.#csi(match[1] ?? '', match[2] ?? '')
          index = CSI.lastIndex
          continue
        }
        // OSC：吃到 BEL 或 ST 为止。
        if (text[index + 1] === ']') {
          const bel = text.indexOf('\x07', index)
          const st = text.indexOf('\x1b\\', index)
          const end = [bel, st].filter((value) => value >= 0).sort((a, b) => a - b)[0]
          index = end === undefined ? text.length : end + (end === bel ? 1 : 2)
          continue
        }
        index += 2 // 未知两字节转义
        continue
      }
      if (char === '\r') {
        this.col = 0
        index += 1
        continue
      }
      if (char === '\n') {
        this.row = Math.min(this.height - 1, this.row + 1)
        index += 1
        continue
      }
      const width = stringWidth(char)
      if (width > 0) {
        this.#write(char, width)
      }
      index += 1
    }
  }

  #write(char, width) {
    if (this.col + width > this.width) {
      this.col = 0
      this.row = Math.min(this.height - 1, this.row + 1)
    }
    this.rows[this.row][this.col] = char
    for (let offset = 1; offset < width; offset++) this.rows[this.row][this.col + offset] = ''
    this.col = Math.min(this.width - 1, this.col + width)
  }

  #csi(params, command) {
    const values = params
      .replace(/^[?<>]/, '')
      .split(';')
      .filter((part) => part !== '')
      .map((part) => Number.parseInt(part, 10))
    if (command === 'H' || command === 'f') {
      this.row = Math.max(0, Math.min(this.height - 1, (values[0] ?? 1) - 1))
      this.col = Math.max(0, Math.min(this.width - 1, (values[1] ?? 1) - 1))
      return
    }
    if (command === 'J') {
      const mode = values[0] ?? 0
      if (mode === 2 || mode === 3) {
        this.rows = Array.from({ length: this.height }, () => Array(this.width).fill(' '))
      } else if (mode === 0) {
        for (let col = this.col; col < this.width; col++) this.rows[this.row][col] = ' '
        for (let row = this.row + 1; row < this.height; row++) {
          this.rows[row] = Array(this.width).fill(' ')
        }
      }
      return
    }
    if (command === 'K') {
      const mode = values[0] ?? 0
      if (mode === 0) {
        for (let col = this.col; col < this.width; col++) this.rows[this.row][col] = ' '
      } else if (mode === 2) {
        this.rows[this.row] = Array(this.width).fill(' ')
      }
      return
    }
    // SGR / 鼠标 / 键盘协议等：屏幕模型不关心。
  }

  lines() {
    return this.rows.map((row) => row.join(''))
  }
}
