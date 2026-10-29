/**
 * Resolve the official DSH runtime from the installed `@deepseek-ai/dsh`
 * package. Nano never duplicates the harness: the app depends on the exact
 * version and imports the packages that ship inside that install.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PINNED_HARNESS_VERSION = '0.2.1-rc.2'

export interface OfficialModules {
  readonly appBoot: Record<string, any>
  readonly session: Record<string, any>
  readonly agent: Record<string, any>
  readonly llm: Record<string, any>
  readonly installAnchor: string
  readonly version: string
  readonly packageRoot: string
}

const requireFromHere = createRequire(import.meta.url)

/** Absolute package.json path of the official DSH install. */
export function resolveInstallAnchor(): string {
  try {
    return requireFromHere.resolve('@deepseek-ai/dsh/package.json')
  } catch (error) {
    throw new Error(`nano: 找不到官方 @deepseek-ai/dsh 安装（${String(error)}）。请先安装依赖。`)
  }
}

/**
 * Load the official modules. The app-boot package lives in the official
 * install's own node_modules, so it is resolved from the anchor rather than
 * from Nano's top-level dependencies.
 */
export async function loadOfficial(
  installAnchor = resolveInstallAnchor(),
): Promise<OfficialModules> {
  const packageRoot = dirname(installAnchor)
  const anchorRequire = createRequire(installAnchor)
  const nanoRequire = createRequire(import.meta.url)
  const version = (JSON.parse(readFileSync(installAnchor, 'utf8')) as { version?: unknown }).version
  if (version !== PINNED_HARNESS_VERSION) {
    throw new Error(
      `nano: 官方 harness 版本不受支持：${String(version ?? '未知')}（需要 ${PINNED_HARNESS_VERSION}）`,
    )
  }

  // Cordis / React 必须是单实例：两个副本会让官方插件与 UI 各拿一套上下文。
  const assertSingleInstance = (name: string): void => {
    const fromAnchor = anchorRequire.resolve(name)
    let fromNano: string
    try {
      fromNano = nanoRequire.resolve(name)
    } catch {
      return // nano 不直接依赖它，没有可比对的第二份
    }
    if (fromAnchor !== fromNano) {
      throw new Error(`nano: ${name} 存在多实例（${fromAnchor} vs ${fromNano}），拒绝启动`)
    }
  }
  assertSingleInstance('@deepseek-ai/cordis')
  assertSingleInstance('react')
  const load = async (name: string): Promise<Record<string, any>> => {
    const resolved = anchorRequire.resolve(name)
    if (!existsSync(resolved)) throw new Error(`nano: 官方模块缺失：${name}`)
    return (await import(pathToFileURL(resolved).href)) as Record<string, any>
  }
  const appBoot = await load('@deepseek-ai/dsh-app-boot')
  const session = await load('@deepseek-ai/dsh-session')
  const agent = await load('@deepseek-ai/dsh-agent')
  const llm = await load('@deepseek-ai/dsh-llm')
  return { appBoot, session, agent, llm, installAnchor, version: version ?? 'unknown', packageRoot }
}

/** Absolute path used by Node's ESM loader for the profile's module tree. */
export function officialPackageRoot(installAnchor: string): string {
  return join(dirname(installAnchor), 'node_modules')
}
