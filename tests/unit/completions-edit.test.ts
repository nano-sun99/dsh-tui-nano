import { describe, expect, it } from 'vitest'
import { InputModel } from '../../src/app/input-model.ts'
import { Completions } from '../../src/controls/completions.ts'

describe('completion edits', () => {
  it('notifies the composer after accepting a completion', () => {
    let edits = 0
    const input = new InputModel()
    input.insert('/mo')
    const completions = new Completions({
      ctx: {},
      input,
      getAgent: () => undefined,
      onChange: () => {},
      onEdit: () => {
        edits += 1
      },
      writeDiagnostic: () => {},
    })
    const internal = completions as unknown as {
      lastTrigger: unknown
      session: { open: (...args: unknown[]) => void }
    }
    internal.lastTrigger = { kind: 'command', query: '/mo', remove: 3 }
    internal.session.open('command', '/mo', [
      { label: '/model', insert: '/model', kind: 'command' },
    ])

    completions.accept()

    expect(input.text).toBe('/model')
    expect(edits).toBe(1)
  })
})
