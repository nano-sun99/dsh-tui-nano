/**
 * 附件两条链（S02 spec §2）。
 *
 * - 图片：提交时读本地文件 → `saveImages` 持久化 → 与文本一起
 *   `admitPromptContent` 校验（官方准入：上限、模型是否支持图片）；
 *   任何一张被拒整条消息失败。
 * - 通用文件：走 `saveFileStream`，回执一次性、绑定会话；本地不设大小上限。
 *
 * 本模块只组装官方 content 段，不自己造协议；失败一律抛给调用方，
 * 由它决定保留草稿。
 */
import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export interface ResolvedReference {
  readonly token: string
  readonly path: string
  readonly image: boolean
  readonly mediaType?: string
}

/** 从输入文本里抽出 `@path` 引用（行首或空白后触发）。 */
export function findReferences(text: string): ResolvedReference[] {
  const found: ResolvedReference[] = []
  const parts = text.split(/(\s+)/u)
  for (const part of parts) {
    if (!part.startsWith('@') || part.length < 2) continue
    const token = part.slice(1)
    const mediaType = IMAGE_TYPES[extname(token).toLowerCase()]
    found.push({
      token: `@${token}`,
      path: token,
      image: mediaType !== undefined,
      ...(mediaType ? { mediaType } : {}),
    })
  }
  return found
}

export interface PromptAssembly {
  readonly content: readonly any[]
  readonly displayText: string
  /** 被官方准入拒掉的原因；空数组表示全部通过。 */
  readonly rejected: readonly string[]
}

export interface AssembleOptions {
  readonly ctx: any
  readonly cwd: string
  readonly text: string
}

/**
 * 把文本 + `@` 引用组装成可直接提交的官方 content 段。
 * 没有图片引用时原样返回纯文本段；有图片时先持久化再走官方准入。
 */
export async function assemblePrompt(options: AssembleOptions): Promise<PromptAssembly> {
  const { ctx, cwd, text } = options
  const references = findReferences(text).filter((reference) => reference.image)
  if (references.length === 0) {
    return { content: [{ type: 'text', text }], displayText: text, rejected: [] }
  }
  const attachments = ctx.get('attachments')
  if (!attachments) {
    return { content: [{ type: 'text', text }], displayText: text, rejected: ['附件服务不可用'] }
  }
  const images: any[] = []
  for (const reference of references) {
    const absolute = resolve(cwd, reference.path)
    const data = await readFile(absolute)
    const refs = await attachments.saveImages([
      { data, mediaType: reference.mediaType, name: basename(reference.path) },
    ])
    for (const ref of refs) images.push({ type: 'image', attachment: ref })
  }
  const parts = [{ type: 'text', text }, ...images]
  const admitted = await attachments.admitPromptContent(parts)
  return { content: admitted, displayText: text, rejected: [] }
}
