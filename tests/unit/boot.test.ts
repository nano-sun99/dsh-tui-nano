import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPermissionArgs,
  commandArgs,
  parseCli,
  resolvePermissionMode,
} from '../../src/boot/cli.ts'
import {
  LAST_SESSION_LIMIT,
  lastSessionPath,
  lookupLastSession,
  readLastSession,
  recordLastSession,
} from '../../src/boot/last-session.ts'
import { ensureProfile, ProfileError } from '../../src/boot/profile.ts'
import {
  acquireMountClaim,
  hasStaleMountClaim,
  RootInUseError,
  releaseMountClaim,
  resolveRootId,
} from '../../src/boot/root.ts'
import { takeHandoff, writeHandoff } from '../../src/runtime/handoff.ts'
import { featureBootPatches } from '../../src/sessions/boot-patches.ts'

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

describe('permission CLI', () => {
  it('does not treat the value of --permission-mode as a subcommand', () => {
    const args = parseCli(['--permission-mode', 'purge', '--yes'])
    expect(args.permissionMode).toBe('purge')
    expect(args.purge).toBe(false)
    expect(args.yes).toBe(true)
    expect(commandArgs(['--permission-mode', 'purge', '--yes'])).toEqual(['--yes'])
    expect(() => assertPermissionArgs(args)).toThrow(/未知权限模式 purge/)
  })

  it('supports --permission-mode=value and the skip flag', () => {
    expect(parseCli(['--permission-mode=read-only']).permissionMode).toBe('read-only')
    const skip = parseCli(['--dangerously-skip-permissions'])
    expect(skip.dangerouslySkipPermissions).toBe(true)
    expect(resolvePermissionMode(skip, 'workspace-write')).toBe('danger-full-access')
  })

  it('rejects missing values, conflicting flags and purge with permission flags', () => {
    expect(() => assertPermissionArgs(parseCli(['--permission-mode']))).toThrow(/需要一个值/)
    expect(() =>
      assertPermissionArgs(
        parseCli(['--permission-mode', 'read-only', '--dangerously-skip-permissions']),
      ),
    ).toThrow(/不能和/)
    expect(() =>
      assertPermissionArgs(parseCli(['purge', '--permission-mode', 'read-only'])),
    ).toThrow(/purge 不能和/)
  })

  it('resolves CLI > env > default and rejects unknown env values', () => {
    expect(resolvePermissionMode(parseCli([]), undefined)).toBe('danger-full-access')
    expect(resolvePermissionMode(parseCli([]), '')).toBe('danger-full-access')
    expect(resolvePermissionMode(parseCli([]), 'workspace-write')).toBe('workspace-write')
    expect(
      resolvePermissionMode(parseCli(['--permission-mode', 'read-only']), 'danger-full-access'),
    ).toBe('read-only')
    expect(() => resolvePermissionMode(parseCli([]), 'bogus')).toThrow(/可选值/)
  })
})

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

  it('removes retired list-agents rows and backs up cordis.yml', () => {
    const dataRoot = tempDir()
    const ensured = ensureProfile(dataRoot, fakeOfficial())
    writeFileSync(
      ensured.cordisPath,
      [
        '- id: keep',
        '  name: keep',
        '- id: tool-subagent-list-agents',
        "  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
        '- id: tail',
        '  name: tail',
        '',
      ].join('\n'),
    )
    ensureProfile(dataRoot, fakeOfficial())
    const after = readFileSync(ensured.cordisPath, 'utf8')
    expect(after).toContain('id: keep')
    expect(after).toContain('id: tail')
    expect(after).not.toContain('list-agents')
    const backups = readdirSync(join(dataRoot, 'profile')).filter((name) => name.includes('.bak-'))
    expect(backups.length).toBe(1)
  })
})

describe('root identity', () => {
  it('uses --root when given, otherwise generates a fresh id', () => {
    expect(resolveRootId('explicit')).toMatchObject({ id: 'explicit', source: 'arg' })
    const generated = resolveRootId()
    expect(generated.source).toBe('generated')
    expect(generated.id).toMatch(/^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/u)
  })

  it('ignores last-root left on disk', () => {
    const dataRoot = tempDir()
    writeFileSync(join(dataRoot, 'last-root'), 'saved-root\n')
    const generated = resolveRootId()
    expect(generated.source).toBe('generated')
    expect(generated.id).not.toBe('saved-root')
  })

  it('rejects an invalid session id', () => {
    expect(() => resolveRootId('../evil')).toThrow(/非法会话身份/)
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

describe('last-session', () => {
  it('records per-cwd hints atomically and reads them back', () => {
    const dataRoot = tempDir()
    recordLastSession(dataRoot, '/work/a', 's1', 100)
    recordLastSession(dataRoot, '/work/b', 's2', 200)
    recordLastSession(dataRoot, '/work/a', 's3', 300)

    expect(statSync(lastSessionPath(dataRoot)).mode & 0o777).toBe(0o600)
    const { file, error } = readLastSession(dataRoot)
    expect(error).toBeUndefined()
    expect(lookupLastSession(file, ['/work/a'])).toBe('s3')
    expect(lookupLastSession(file, ['/work/b'])).toBe('s2')
    expect(lookupLastSession(file, ['/missing'])).toBeUndefined()
  })

  it('treats a corrupt file as empty and keeps going', () => {
    const dataRoot = tempDir()
    writeFileSync(lastSessionPath(dataRoot), '{oops')
    const { file, error } = readLastSession(dataRoot)
    expect(error).toMatch(/损坏/)
    expect(file.byCwd).toEqual({})
  })

  it('keeps only the newest entries', () => {
    const dataRoot = tempDir()
    for (let index = 0; index < LAST_SESSION_LIMIT + 5; index++) {
      recordLastSession(dataRoot, `/work/${index}`, `s${index}`, index)
    }
    const { file } = readLastSession(dataRoot)
    expect(Object.keys(file.byCwd)).toHaveLength(LAST_SESSION_LIMIT)
    expect(file.byCwd['/work/0']).toBeUndefined()
    expect(file.byCwd[`/work/${LAST_SESSION_LIMIT + 4}`]).toEqual({
      sessionId: `s${LAST_SESSION_LIMIT + 4}`,
      lastUsedAt: LAST_SESSION_LIMIT + 4,
    })
  })
})

describe('boot patches', () => {
  // 回退守卫（ADR-20261110-prompt-only-research）：plan 段必须由官方持有。
  // 把 plan-mode 覆盖加回来，这里立刻红；e2e 只把补丁当 extraPatches 传，不拦这个。
  it('不覆盖 plan-mode，也不再带五阶段文本', () => {
    const layers = featureBootPatches('root')
    const ids = layers.map((layer) => layer.id).filter((id): id is string => Boolean(id))
    expect(ids).toEqual(['storage-domain'])
    expect(ids).not.toContain('plan-mode')
    expect(JSON.stringify(layers)).not.toContain('Phase 1 — Explore')
    expect(JSON.stringify(layers)).not.toContain('You are in plan mode')
  })
})
