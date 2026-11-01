// Test-only stdin driver: the real Nano boot and renderer still own the tty.
import { appendFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { NanoApp } from '../../../dist/app/nano-app.js'

const log = process.env.NANO_QUESTION_DRIVER_LOG
const emit = (text) => {
  process.stdin.emit('data', Buffer.from(text))
  if (log) appendFileSync(log, `${Date.now()} INPUT ${JSON.stringify(text)}\n`)
}
if (process.env.NANO_GUARDED === '1') {
  if (log) writeFileSync(log, `PID ${process.pid}\nTTY ${execFileSync('stty', ['size'], { stdio: [0, 'pipe', 'pipe'] }).toString().trim()}\n`)
  const originalRender = NanoApp.prototype.render
  NanoApp.prototype.render = function(...args) {
    const result = originalRender.apply(this, args)
    this.options.renderer.flushFrame()
    if (log) writeFileSync(log.replace('.keys.txt', '.screen.txt'), this.options.renderer.snapshotLines().join('\n') + '\n')
    return result
  }
  const originalInput = NanoApp.prototype.handleInput
  NanoApp.prototype.handleInput = function(events) {
    if (log) appendFileSync(log, `${Date.now()} EVENTS ${JSON.stringify(events)}\n`)
    const result = originalInput.call(this, events)
    const prompt = this.decisionsManager.prompt
    if (log && prompt?.kind === 'question') appendFileSync(log, `STATE current=${prompt.current} focus=${prompt.focusedOption} questions=${prompt.questions.length}\n`)
    return result
  }
  setTimeout(() => {
    emit('请展示问卷卡片。\r')
  }, 4000).unref()
  process.on('SIGUSR1', () => emit('1'))
  process.on('SIGUSR2', () => { emit(' '); setTimeout(() => emit('\r'), 200) })
}
