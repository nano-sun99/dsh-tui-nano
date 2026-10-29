/**
 * Boot evidence: core assembly time, stdout writes during boot, capability
 * snapshot and storage-root placement. Run from the repo root:
 *   node docs/evidence/2026-10-28-nano-ts/alpha/tools/boot-probe.mjs
 */
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOfficial } from '../../../../../dist/boot/official.js'
import { bootCore } from '../../../../../dist/boot/assemble.js'

const official = await loadOfficial()
const dataRoot = mkdtempSync(join(tmpdir(), 'nano-boot-'))
const started = performance.now()
const core = await bootCore({
  official,
  dataRoot,
  home: process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'),
  cwd: process.cwd(),
  rootId: 'probe-root',
})
const elapsed = performance.now() - started

function listFiles(dir, prefix = '') {
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    try {
      if (statSync(path).isDirectory()) out.push(...listFiles(path, `${prefix}${entry}/`))
      else out.push(`${prefix}${entry}`)
    } catch {
      // ignore
    }
  }
  return out
}

console.log(
  JSON.stringify(
    {
      bootMs: Math.round(elapsed),
      stdoutWritesDuringBoot: core.stdoutWritesDuringBoot,
      services: core.capability.services.length,
      missingServices: core.capability.missingServices,
      tools: core.capability.tools,
      storageRootFiles: listFiles(join(dataRoot, 'runtime-data')).slice(0, 10),
      sessionRootFiles: listFiles(join(dataRoot, 'sessions')).slice(0, 5),
      profileFiles: listFiles(join(dataRoot, 'profile')),
      node: process.version,
    },
    null,
    2,
  ),
)
await core.dispose()
process.exit(0)
