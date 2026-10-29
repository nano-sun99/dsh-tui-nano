/**
 * 附件两条链（S02 spec §2）。
 *
 * - 图片：按 spec「以 base64 data 进入 prompt，官方准入时校验/规范化/持久化」——
 *   这里只把本地文件读成 base64 段，交给 `admitPromptContent` 完成准入与持久化；
 *   任何一张被拒整条消息失败。
 * - 通用文件：走官方 `saveFileStream`（`src/attachments/files.ts`），结果是
 *   一次性回执，作为 `file` 段随消息提交；本地不设大小上限。
 */
import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { attachFile, filePart } from './files.ts'

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
 * 没有引用时原样返回纯文本段；有图片时以 base64 段走官方准入；有通用文件时
 * 先 `saveFileStream` 拿一次性回执再作为 `file` 段提交。
 */
export async function assemblePrompt(options: AssembleOptions): Promise<PromptAssembly> {
  const { ctx, cwd, text } = options
  const references = findReferences(text)
  if (references.length === 0) {
    return { content: [{ type: 'text', text }], displayText: text, rejected: [] }
  }
  const attachments = ctx.get('attachments')
  if (!attachments) {
    return { content: [{ type: 'text', text }], displayText: text, rejected: ['附件服务不可用'] }
  }
  const parts: any[] = [{ type: 'text', text }]
  for (const reference of references) {
    const absolute = resolve(cwd, reference.path)
    if (reference.image) {
      const data = await readFile(absolute)
      parts.push({
        type: 'image',
        mediaType: reference.mediaType,
        data: data.toString('base64'),
        name: basename(reference.path),
      })
      continue
    }
    // 通用文件：官方存储给出一次性回执，作为 file 段提交。
    const attached = await attachFile(ctx, absolute)
    parts.push(filePart(attached))
  }
  const admitted = await attachments.admitPromptContent(parts)
  return { content: admitted, displayText: text, rejected: [] }
}
