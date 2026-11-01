/** Extract only the pinned MIT tail poses; sharp is a generation-only prerequisite. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'
import { deflateSync } from 'node:zlib'
import sharp from 'sharp'

const [source, destination] = process.argv.slice(2)
if (!source || !destination)
  throw new Error('usage: node scripts/activity-dock/extract.mjs <client.js> <output-directory>')
const text = readFileSync(source, 'utf8')
const start = text.indexOf('const TAIL_POSES =')
const end = text.indexOf('const TAIL_WAG_DURATION =', start)
if (start < 0 || end < 0) throw new Error('pinned source declarations not found')
const poses = JSON.parse(
  vm.runInNewContext(
    `${text.slice(start, end)};JSON.stringify(TAIL_ANIMATION_POSES)`,
    {},
    { timeout: 1000 },
  ),
)
const hashes = {
  official: 'd5d98ff5ff2eada7d68247e932011a8e4679a3fb56c48cdf0db0c3c138491e46',
  wag: 'aed4a831e5dd5a8e984f716d7e3f833861e0d37d7f72e906514e09b8da97e4af',
  sway: '288a1184d9d48e4b9dc368fe4c306b0d8ab712daf58438be715e3210929d058a',
  twist: 'd9321bc4c061b52c61a6b308b1e80218d483297ec3c4f2718b4e5ac9e1765edd',
}
const result = {
  source: '01Virex/dsh-status-rotator@0d486a80c55dabee9e62ce8d87612dc15792c805',
  size: 128,
  animations: {},
}
for (const name of ['official', 'wag', 'sway', 'twist']) {
  const paths = poses[name]
  const hash = createHash('sha256').update(JSON.stringify(paths)).digest('hex')
  if (hash !== hashes[name]) throw new Error(`source hash mismatch: ${name}`)
  const frames = []
  for (const path of paths) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="20 40 300 240"><path fill="white" fill-rule="evenodd" d="${path}"/></svg>`
    const raw = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer()
    const alpha = Buffer.alloc(128 * 128)
    for (let i = 0; i < alpha.length; i++) alpha[i] = raw[i * 4 + 3]
    frames.push(deflateSync(alpha, { level: 9 }).toString('base64'))
  }
  result.animations[name] = {
    periodMs: name === 'official' ? 4000 : 2000,
    sha256: hash,
    paths,
    frames,
  }
}
mkdirSync(destination, { recursive: true })
writeFileSync(
  `${destination}/tail-masks.json`,
  `${JSON.stringify(result)}
`,
)
console.log(
  JSON.stringify({
    size: result.size,
    animations: Object.fromEntries(
      Object.entries(result.animations).map(([name, a]) => [
        name,
        { frames: a.frames.length, sha256: a.sha256 },
      ]),
    ),
  }),
)
