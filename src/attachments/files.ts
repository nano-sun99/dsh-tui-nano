/**
 * 通用文件附件链（S02 spec §2）。
 *
 * 走官方 `saveFileStream`：按流读盘，不把整个文件读进内存，也不设本地大小上限
 * （受磁盘/内存约束即止）。每次提交都产生一份新的回执，不复用旧回执。
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

export interface AttachedFile {
  readonly attachment: any
  readonly name: string
  readonly bytes: number
}

/** 把本地文件作为通用附件提交给官方存储；回执一次性、不复用。 */
export async function attachFile(
  ctx: any,
  path: string,
  signal?: AbortSignal,
): Promise<AttachedFile> {
  const service = ctx.get('attachments')
  if (!service) throw new Error('附件服务不可用')
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`不是普通文件：${path}`)
  const stream = createReadStream(path) as unknown as AsyncIterable<Uint8Array>
  const ref = await service.saveFileStream({
    data: stream,
    name: basename(path),
    ...(signal ? { signal } : {}),
  })
  return { attachment: ref, name: ref.name ?? basename(path), bytes: ref.bytes ?? info.size }
}

/** 官方 content 段：通用文件附件。 */
export function filePart(file: AttachedFile): { type: 'file'; attachment: any } {
  return { type: 'file', attachment: file.attachment }
}
