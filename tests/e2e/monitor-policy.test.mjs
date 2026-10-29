// 安全行里 Monitor 的两条（S03 §3.3）：默认 `quiet`、`notify` 必须显示计费提示。
// 只读编译产物，不开终端。
import assert from 'node:assert/strict'
import test from 'node:test'
import { Monitor, renderMonitorLines } from '../../dist/monitor/monitor.js'

test('Monitor 默认 quiet；notify 行显示「会唤醒模型并计费」', () => {
  const jobs = { get: () => ({ output: { total: 0 }, status: 'running' }) }
  const ctx = { get: (name) => (name === 'jobs' ? jobs : undefined) }
  const monitor = new Monitor({
    ctx,
    sessionId: 'monitor-test',
    onChange() {},
    writeDiagnostic() {},
    deliver() {},
  })
  try {
    monitor.watch('job-1')
    assert.equal(monitor.watching[0]?.mode, 'quiet', 'watch 的默认模式必须是 quiet')
    const quiet = JSON.stringify(renderMonitorLines(monitor.watching))
    assert.doesNotMatch(quiet, /会唤醒模型并计费/, 'quiet 行不应出现计费提示')

    monitor.watch('job-2', 'notify')
    const notify = JSON.stringify(renderMonitorLines(monitor.watching))
    assert.match(notify, /会唤醒模型并计费/, 'notify 行必须显示计费提示')
  } finally {
    monitor.dispose()
  }
})
