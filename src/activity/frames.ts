/** @license
MIT License

Copyright (c) 2026 01Virex

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
/** Fixed upstream alpha masks. No runtime SVG renderer or native dependency. */
import { deflateSync, inflateSync } from 'node:zlib'
import type { Rgb } from '../theme/theme.ts'
import type { Tail } from './state.ts'
import masks from './tail-masks.json' with { type: 'json' }

const alphaCache = new Map<string, Buffer>()
export function tailFrame(tail: Tail, elapsed: number): number {
  const animation = masks.animations[tail]
  return Math.floor(
    ((Math.max(0, elapsed) % animation.periodMs) / animation.periodMs) * animation.frames.length,
  )
}
export function tailPixels(tail: Tail, frame: number, size: number, color: Rgb): string {
  const source = masks.animations[tail].frames[frame]
  if (!source || !Number.isInteger(size) || size < 1 || size > 256)
    throw new Error('invalid tail frame size')
  const key = `${tail}:${frame}`
  let alpha = alphaCache.get(key)
  if (!alpha) {
    alpha = inflateSync(Buffer.from(source, 'base64'))
    alphaCache.set(key, alpha)
  }
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4
      rgba[index] = color[0]
      rgba[index + 1] = color[1]
      rgba[index + 2] = color[2]
      rgba[index + 3] =
        alpha[
          Math.min(127, Math.floor(((y + 0.5) * 128) / size)) * 128 +
            Math.min(127, Math.floor(((x + 0.5) * 128) / size))
        ] ?? 0
    }
  return deflateSync(rgba).toString('base64')
}
export const tailMetadata = masks
