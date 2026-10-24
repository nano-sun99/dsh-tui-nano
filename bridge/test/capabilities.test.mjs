// Capability snapshot tests. The bridge provides a scheduler-only
// `sessionController` stub; it must not be reported as a working model
// selection controller.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCapabilities } from '../runtime/capabilities.mjs'

function ctx(services = {}) {
  return {
    get(key) {
      return services[key]
    },
  }
}

test('a scheduler-only session controller does not claim model selection', () => {
  const capabilities = buildCapabilities(
    ctx({ sessionController: { async resolveAgent() {} } }),
    {},
  )
  assert.equal(capabilities.modelSelection.status, 'unsupported')
})

test('model selection is supported by the official CLI primitives', () => {
  const capabilities = buildCapabilities(
    ctx({ llm: {}, agentDefaultModel: {} }),
    {},
  )
  assert.equal(capabilities.modelSelection.status, 'supported')
})

test('a real session controller supports model selection on its own', () => {
  const capabilities = buildCapabilities(
    ctx({ sessionController: { async selectModel() {} } }),
    {},
  )
  assert.equal(capabilities.modelSelection.status, 'supported')
})
