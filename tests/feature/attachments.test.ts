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

  it('图片引用先持久化，再按文本 + 图片顺序交给官方准入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-att-'))
    const file = join(dir, 'shot.png')
    writeFileSync(file, png)
    const ctx = fakeContext()
    const assembled = await assemblePrompt({ ctx, cwd: dir, text: `look @${file}` })
    expect(ctx.saved).toHaveLength(1)
    expect(ctx.saved[0]?.mediaType).toBe('image/png')
    expect(assembled.content).toEqual([
      { type: 'text', text: `look @${file}` },
      { type: 'image', attachment: { id: 'img-0', mediaType: 'image/png' } },
    ])
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
