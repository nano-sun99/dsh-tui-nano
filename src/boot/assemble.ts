/**
 * Compose the official Cordis root (spec §2.4): application profile + runtime
 * patches + `boot()`, then assert the α capability set. Nothing here draws to
 * the terminal; the caller owns the screen.
 */
import { join } from 'node:path'
import type { OfficialModules } from './official.ts'
import { type EnsuredProfile, ensureProfile, loadProfile } from './profile.ts'

export const REQUIRED_SERVICES = [
  'agents',
  'sessions',
  'sessionQuery',
  'userQuestions',
  'approval',
  'fileReferences',
] as const

export const REQUIRED_TOOLS = ['ask_user_question'] as const

export interface CapabilitySnapshot {
  readonly services: readonly string[]
  readonly missingServices: readonly string[]
  readonly tools: Readonly<Record<string, boolean>>
  readonly ok: boolean
}

export interface CoreBootOptions {
  readonly official: OfficialModules
  readonly dataRoot: string
  readonly home: string
  readonly cwd: string
  readonly rootId: string
}

export interface PreparedCore {
  readonly official: OfficialModules
  readonly dataRoot: string
  readonly home: string
  readonly cwd: string
  readonly rootId: string
  readonly profile: any
  readonly profileContext: any
  readonly ensuredProfile: EnsuredProfile
  readonly patches: any[]
  readonly resolution: any
}

export interface CoreBoot {
  readonly ctx: any
  readonly profile: any
  readonly profileContext: any
  readonly ensuredProfile: EnsuredProfile
  readonly bootMs: number
  readonly stdoutWritesDuringBoot: number
  readonly capability: CapabilitySnapshot
  dispose(): Promise<void>
}

/** Phase 1 (before the alternate screen): profile, patches and module resolution. */
export async function prepareCore(options: CoreBootOptions): Promise<PreparedCore> {
  const { official, dataRoot, home, cwd, rootId } = options
  const appBoot = official.appBoot
  const ensuredProfile = ensureProfile(dataRoot, official)
  const profile = loadProfile(official, ensuredProfile, official.installAnchor)

  const profileContext = {
    name: 'nano',
    dir: profile.dir,
    patchPath: profile.patchPath,
    installAnchor: official.installAnchor,
    cwd: dataRoot,
    home,
    startedBundles: Array.isArray(profile.layers)
      ? profile.layers.map((layer: any) => layer.packageName)
      : [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  }

  const patches = appBoot.readProfilePatches('nano', profileContext, profile)
  patches.push({
    insert: [
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
      {
        id: 'file-reference-local',
        name: '@deepseek-ai/dsh-file-reference-local',
        config: { maxResults: 20 },
      },
    ],
  })
  patches.push({ id: 'session-persistence-jsonl', config: { root: join(dataRoot, 'sessions') } })
  patches.push({
    id: 'storage-json',
    config: { root: join(dataRoot, 'runtime-data', rootId, 'storage') },
  })
  patches.push({ id: 'hmr', disabled: true })

  const resolution = await appBoot.createRuntimeResolution({
    installAnchor: official.installAnchor,
    profile,
    home,
  })
  return {
    official,
    dataRoot,
    home,
    cwd,
    rootId,
    profile,
    profileContext,
    ensuredProfile,
    patches,
    resolution,
  }
}

/** Phase 2 (after the pre-boot frame): boot the official root and snapshot capabilities. */
export async function startCore(prepared: PreparedCore): Promise<CoreBoot> {
  const { official, profile, profileContext, ensuredProfile, patches, resolution } = prepared
  const appBoot = official.appBoot
  let ready = false
  const listeners = new Set<() => void>()
  const appReady = {
    onReady(listener: () => void) {
      if (ready) {
        listener()
        return () => {}
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commit() {
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }

  let stdoutWrites = 0
  const originalWrite = process.stdout.write.bind(process.stdout)
  ;(process.stdout as any).write = (...args: any[]) => {
    stdoutWrites++
    return originalWrite(...(args as [any]))
  }

  const startedAt = performance.now()
  let ctx: any
  try {
    ctx = await appBoot.boot('nano', `${profile.dir}/cordis.yml`, patches, async (host: any) => {
      host.provide('profileContext', profileContext)
      host.provide('cmdlineArgs', { get: () => Object.freeze([]) })
      host.provide('appExit', () => {})
      host.provide('appReady', appReady)
      await host.plugin(appBoot.PluginPackages, { resolution })
    })
  } finally {
    ;(process.stdout as any).write = originalWrite
  }
  appReady.commit()
  const bootMs = performance.now() - startedAt
  const capability = snapshotCapabilities(ctx)
  if (!capability.ok) {
    await ctx?.fiber?.dispose?.().catch?.(() => {})
    throw new Error(
      `nano: 能力快照失败，缺少：${[...capability.missingServices, ...missingTools(capability)].join('、')}`,
    )
  }
  return {
    ctx,
    profile,
    profileContext,
    ensuredProfile,
    bootMs,
    stdoutWritesDuringBoot: stdoutWrites,
    capability,
    async dispose() {
      await ctx?.fiber?.dispose?.()
    },
  }
}

/** Convenience wrapper used by tests and probes. */
export async function bootCore(options: CoreBootOptions): Promise<CoreBoot> {
  return startCore(await prepareCore(options))
}

export function snapshotCapabilities(ctx: any): CapabilitySnapshot {
  const services = Object.keys(ctx?.reflect?.props ?? {}).sort()
  const missingServices = REQUIRED_SERVICES.filter((name) => !ctx?.get?.(name))
  const toolsService = ctx?.get?.('tools')
  const tools: Record<string, boolean> = {}
  for (const name of REQUIRED_TOOLS) {
    tools[name] = Boolean(toolsService?.get?.(name))
  }
  return {
    services,
    missingServices,
    tools,
    ok: missingServices.length === 0 && Object.values(tools).every(Boolean),
  }
}

function missingTools(capability: CapabilitySnapshot): string[] {
  return Object.entries(capability.tools)
    .filter(([, present]) => !present)
    .map(([name]) => `tool:${name}`)
}
