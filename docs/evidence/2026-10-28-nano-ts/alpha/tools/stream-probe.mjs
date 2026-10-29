/**
 * Streaming evidence: a real model reply through ConversationController; the
 * probe records successive preview states and the committed message.
 * Run from the repo root:
 *   node docs/evidence/2026-10-28-nano-ts/alpha/tools/stream-probe.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadOfficial } from '../../../../../dist/boot/official.js'
import { bootCore } from '../../../../../dist/boot/assemble.js'
import { ConversationController } from '../../../../../dist/conversation/controller.js'
import { HistoryStore } from '../../../../../dist/input/history.js'

const official = await loadOfficial()
const dataRoot = mkdtempSync(join(tmpdir(), 'nano-stream-'))
const rootId = `stream-${randomUUID().slice(0, 8)}`
const core = await bootCore({
  official,
  dataRoot,
  home: process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'),
  cwd: process.cwd(),
  rootId,
})
const history = new HistoryStore(join(dataRoot, 'history.jsonl'), process.cwd(), () => rootId)
const conversation = new ConversationController({
  ctx: core.ctx,
  official,
  rootId,
  cwd: process.cwd(),
  history,
})
await conversation.start()

const previews = []
conversation.model.onChange(() => {
  const preview = conversation.model.preview
  if (preview && (preview.text !== '' || preview.reasoning !== '')) {
    previews.push({ text: preview.text, reasoning: preview.reasoning })
  }
})

conversation.submit('Count from 1 to 5, comma separated, nothing else.')
const started = Date.now()
while (conversation.status === 'running' || previews.length === 0) {
  if (Date.now() - started > 60000) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
await conversation.agent.whenIdle()

const committed = conversation.model.all
  .filter((entry) => entry.kind === 'assistant')
  .map((entry) => entry.blocks.filter((block) => block.type === 'text').map((block) => block.text).join(''))
const sample = previews.slice(0, 6).map((preview) => preview.text)
console.log(
  JSON.stringify(
    {
      previewUpdates: previews.length,
      firstPreviews: sample,
      lastPreview: previews[previews.length - 1]?.text ?? '',
      committedText: committed[committed.length - 1] ?? '',
      reasoningPreviewed: previews.some((preview) => preview.reasoning !== ''),
    },
    null,
    2,
  ),
)
await conversation.dispose()
await core.dispose()
process.exit(0)
