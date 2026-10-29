/**
 * The application-owned profile (spec §2.1): first launch initialises it under
 * the data root, every later launch repairs only missing files and refuses to
 * silently overwrite a damaged one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { OfficialModules } from './official.ts'

export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

export interface EnsuredProfile {
  readonly dir: string
  readonly manifestPath: string
  readonly cordisPath: string
  readonly patchPath: string
  /** True when this launch created the profile (first run). */
  readonly created: boolean
}

const BASE_BUNDLE = '@deepseek-ai/dsh-base'

/** Create or verify `<dataRoot>/profile`; returns the three file paths. */
export function ensureProfile(dataRoot: string, official: OfficialModules): EnsuredProfile {
  const dir = join(dataRoot, 'profile')
  const manifestPath = join(dir, 'package.json')
  const cordisPath = join(dir, 'cordis.yml')
  const patchPath = join(dir, 'cordis.patch.yml')
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  let created = false
  if (!existsSync(manifestPath)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    official.appBoot.initProfile(dir, [BASE_BUNDLE])
    created = true
  }

  assertParseableJson(manifestPath, 'package.json')
  ensureArrayYaml(cordisPath, 'cordis.yml')
  ensureArrayYaml(patchPath, 'cordis.patch.yml')
  return { dir, manifestPath, cordisPath, patchPath, created }
}

/** Load the profile and reject partial loads instead of continuing silently. */
export function loadProfile(
  official: OfficialModules,
  ensured: EnsuredProfile,
  installAnchor: string,
): any {
  let profile: any
  try {
    profile = official.appBoot.loadProfileDirectory('nano', ensured.dir, installAnchor)
  } catch (error) {
    throw new ProfileError(`nano: profile 加载失败：${message(error)}。位置：${ensured.dir}`)
  }
  const skipped = profile?.skippedBundles ?? []
  if (Array.isArray(skipped) && skipped.length > 0) {
    const names = skipped
      .map((entry: any) => entry?.packageName ?? entry?.name ?? String(entry))
      .join('、')
    throw new ProfileError(`nano: profile 中以下 bundle 加载失败：${names}。请修复后重试。`)
  }
  return profile
}

function assertParseableJson(path: string, label: string): void {
  const size = fileSize(path)
  if (size === 0) failCorrupt(path, label, '文件为 0 字节')
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    failCorrupt(path, label, message(error))
  }
  if (value === null || typeof value !== 'object') failCorrupt(path, label, '顶层不是对象')
}

function ensureArrayYaml(path: string, label: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, '[]\n', { mode: 0o600 })
    return
  }
  const size = fileSize(path)
  if (size === 0) failCorrupt(path, label, '文件为 0 字节（loader 会判为非法）')
  let value: unknown
  try {
    value = parseYaml(readFileSync(path, 'utf8'))
  } catch (error) {
    failCorrupt(path, label, message(error))
  }
  if (!Array.isArray(value)) failCorrupt(path, label, '顶层必须是数组')
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Back up the damaged file (never overwrite user settings) and abort startup. */
function failCorrupt(path: string, label: string, reason: string): never {
  const backup = `${path}.corrupt-${Date.now()}`
  try {
    renameSync(path, backup)
  } catch {
    throw new ProfileError(`nano: profile 的 ${label} 损坏（${reason}），且备份失败。位置：${path}`)
  }
  throw new ProfileError(
    `nano: profile 的 ${label} 损坏（${reason}），已备份为 ${backup}。请修复后重试；不会覆盖你的 settings。`,
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
