import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assemblePrompt, findReferences } from '../../src/attachments/prompt.ts'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function fakeContext(options: { admitError?: Error } = {}) {
  const saved: any[] = []
  return {
    saved,
    get: (name: string) =>
      name === 'attachments'
        ? {
            saveImages: async (inputs: any[]) => {
              saved.push(...inputs)
              return inputs.map((input, index) => ({ id: `img-${index}`, mediaType: input.mediaType }))
            },
            admitPromptContent: async (parts: any[]) => {
              if (options.admitError) throw options.admitError
              return parts
            },
          }
        : undefined,
  }
}

describe('findReferences', () => {
  it('只在行首或空白后识别 @ 引用，并标出图片', () => {
    const refs = findReferences('see @shot.png and @notes.md and mail@example.com')
    // `mail@example.com` 不在行首/空白后，不算引用。
    expect(refs.map((ref) => ref.token)).toEqual(['@shot.png', '@notes.md'])
    expect(refs[0]?.image).toBe(true)
    expect(refs[1]?.image).toBe(false)
  })
})

describe('assemblePrompt', () => {
  it('没有图片引用时保持纯文本段', async () => {
    const assembled = await assemblePrompt({ ctx: fakeContext(), cwd: '/tmp', text: 'hi' })
    expect(assembled.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(assembled.rejected).toEqual([])
  })

  it('图片以 base64 data 进 prompt，准入由官方完成（无预上传）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-att-'))
    const file = join(dir, 'shot.png')
    writeFileSync(file, png)
    const ctx = fakeContext()
    const assembled = await assemblePrompt({ ctx, cwd: dir, text: `look @${file}` })
    // 不再调用 saveImages：图片只作为 base64 段交给 admitPromptContent。
    expect(ctx.saved).toHaveLength(0)
    expect(assembled.content[1]).toMatchObject({ type: 'image', mediaType: 'image/png' })
    expect(typeof (assembled.content[1] as any).data).toBe('string')
    expect((assembled.content[1] as any).data).toBe(png.toString('base64'))
  })

  it('通用文件引用走 saveFileStream 并作为 file 段提交', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-att-'))
    const file = join(dir, 'notes.md')
    writeFileSync(file, '# hi')
    const saved: any[] = []
    const ctx = {
      get: (name: string) =>
        name === 'attachments'
          ? {
              saveFileStream: async ({ data, name }: any) => {
                let bytes = 0
                for await (const chunk of data) bytes += chunk.byteLength
                saved.push({ name, bytes })
                return { attachmentId: 'file-1', name, bytes }
              },
              admitPromptContent: async (parts: any[]) => parts,
            }
          : undefined,
    }
    const assembled = await assemblePrompt({ ctx, cwd: dir, text: `read @${file}` })
    expect(saved).toHaveLength(1)
    expect(assembled.content[1]).toEqual({
      type: 'file',
      attachment: { attachmentId: 'file-1', name: 'notes.md', bytes: 4 },
    })
  })

  it('准入失败把错误抛给调用方，不产出半成品', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-att-'))
    const file = join(dir, 'shot.png')
    writeFileSync(file, png)
    const ctx = fakeContext({ admitError: new Error('model does not accept images') })
    await expect(assemblePrompt({ ctx, cwd: dir, text: `look @${file}` })).rejects.toThrow(
      'model does not accept images',
    )
  })
})

describe('attachFile', () => {
  it('按流交给官方存储，超过旧 20MiB 参考值也不拒绝，且每次都是新回执', async () => {
    const { attachFile, filePart } = await import('../../src/attachments/files.ts')
    const dir = mkdtempSync(join(tmpdir(), 'nano-file-'))
    const file = join(dir, 'big.bin')
    // 21 MiB：旧 v1 的 20 MiB 本地上限已删除，这里仍应通过。
    writeFileSync(file, Buffer.alloc(21 * 1024 * 1024, 7))
    let sequence = 0
    const ctx = {
      get: (name: string) =>
        name === 'attachments'
          ? {
              saveFileStream: async ({ data, name }: { data: AsyncIterable<Uint8Array>; name: string }) => {
                let bytes = 0
                for await (const chunk of data) bytes += chunk.byteLength
                sequence += 1
                return { attachmentId: `file-${sequence}`, name, bytes }
              },
            }
          : undefined,
    }
    const first = await attachFile(ctx, file)
    const second = await attachFile(ctx, file)
    expect(first.bytes).toBe(21 * 1024 * 1024)
    expect(first.attachment.attachmentId).toBe('file-1')
    expect(second.attachment.attachmentId).toBe('file-2')
    expect(filePart(first)).toEqual({ type: 'file', attachment: first.attachment })
  })
})
