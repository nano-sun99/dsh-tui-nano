import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureProfile, ProfileError } from '../../src/boot/profile.ts'
import {
  acquireMountClaim,
  hasStaleMountClaim,
  RootInUseError,
  releaseMountClaim,
  resolveRootId,
  writeLastRoot,
} from '../../src/boot/root.ts'
import { takeHandoff, writeHandoff } from '../../src/runtime/handoff.ts'

function fakeOfficial() {
  return {
    appBoot: {
      initProfile(dir: string) {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({
            name: 'nano',
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
          }),
        )
        writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
      },
    },
  } as any
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nano-test-'))
}

describe('profile', () => {
  it('initializes the profile and fills cordis.yml', () => {
    const dataRoot = tempDir()
    const ensured = ensureProfile(dataRoot, fakeOfficial())
    expect(ensured.created).toBe(true)
    expect(readFileSync(ensured.cordisPath, 'utf8').trim()).toBe('[]')
    expect(existsSync(ensured.patchPath)).toBe(true)
  })

  it('backs up a corrupt package.json instead of overwriting it', () => {
    const dataRoot = tempDir()
    ensureProfile(dataRoot, fakeOfficial())
    writeFileSync(join(dataRoot, 'profile', 'package.json'), '{broken')
    expect(() => ensureProfile(dataRoot, fakeOfficial())).toThrow(ProfileError)
    const backups = readdirSync(join(dataRoot, 'profile')).filter((name) =>
      name.includes('.corrupt-'),
    )
    expect(backups.length).toBe(1)
  })

  it('rejects an empty cordis.yml (loader would fail)', () => {
    const dataRoot = tempDir()
    ensureProfile(dataRoot, fakeOfficial())
    writeFileSync(join(dataRoot, 'profile', 'cordis.yml'), '')
    expect(() => ensureProfile(dataRoot, fakeOfficial())).toThrow(/0 字节/)
  })
})

describe('root identity', () => {
  it('prefers --root, then last-root, then generates', () => {
    const dataRoot = tempDir()
    expect(resolveRootId(dataRoot, ['--root', 'explicit'])).toMatchObject({
      id: 'explicit',
      source: 'arg',
    })
    writeLastRoot(dataRoot, 'saved-root')
    expect(resolveRootId(dataRoot, [])).toMatchObject({ id: 'saved-root', source: 'last-root' })
    const generated = resolveRootId(tempDir(), [])
    expect(generated.source).toBe('generated')
    expect(generated.id).toMatch(/^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/u)
  })

  it('rejects an invalid root id', () => {
    expect(() => resolveRootId(tempDir(), ['--root', '../evil'])).toThrow(/非法根身份/)
  })

  it('rejects a second window on the same root', () => {
    const dataRoot = tempDir()
    const claim = acquireMountClaim(dataRoot, 'same-root')
    expect(() => acquireMountClaim(dataRoot, 'same-root')).toThrow(RootInUseError)
    releaseMountClaim(claim)
  })

  it('reclaims a lock left by a dead process and reports dirty state', () => {
    const dataRoot = tempDir()
    ensureProfile(dataRoot, fakeOfficial())
    const mountDir = join(dataRoot, 'mount')
    // Create a lock owned by a pid that cannot exist.
    const claim = acquireMountClaim(dataRoot, 'dead-root')
    releaseMountClaim(claim)
    writeFileSync(
      join(mountDir, 'dead-root.lock'),
      JSON.stringify({ pid: 999999, rootId: 'dead-root' }),
    )
    expect(hasStaleMountClaim(dataRoot, 'dead-root')).toBe(true)
    const recovered = acquireMountClaim(dataRoot, 'dead-root')
    expect(recovered.recovered).toBe(true)
    releaseMountClaim(recovered)
    expect(existsSync(join(mountDir, 'dead-root.lock'))).toBe(false)
  })
})

describe('handoff', () => {
  it('writes atomically, reads once and deletes', () => {
    const dataRoot = tempDir()
    writeHandoff(dataRoot, { rootId: 'r1', sessionId: 's1', reason: 'root-switch' })
    const record = takeHandoff(dataRoot)
    expect(record).toMatchObject({ rootId: 'r1', sessionId: 's1', version: 1 })
    expect(takeHandoff(dataRoot)).toBeUndefined()
  })

  it('drops a corrupt handoff with a visible error', () => {
    const dataRoot = tempDir()
    writeFileSync(join(dataRoot, 'handoff.json'), '{oops')
    expect(() => takeHandoff(dataRoot)).toThrow(/损坏/)
    expect(existsSync(join(dataRoot, 'handoff.json'))).toBe(false)
  })
})
