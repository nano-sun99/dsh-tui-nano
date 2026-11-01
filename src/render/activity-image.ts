/** A single bounded Kitty image, emitted only by the core renderer's writer. */
import { tailFrame, tailPixels } from '../activity/frames.ts'
import type { Activity } from '../activity/state.ts'
import type { Rgb } from '../theme/theme.ts'
export const ACTIVITY_IMAGE_ID = 129001
export const ACTIVITY_QUERY_ID = 129002
export interface ActivityGraphics {
  readonly cellWidth: number
  readonly cellHeight: number
}
export interface ActivityImage extends Activity {
  readonly row: number
  readonly col: number
  readonly color: Rgb
}
const APC = '_G'
const ST = String.fromCharCode(27, 92)
export function deleteActivityImage(): string {
  return `${APC}a=d,d=I,i=${ACTIVITY_IMAGE_ID},q=2${ST}`
}
export function activityQuery(): string {
  return `${APC}a=q,i=${ACTIVITY_QUERY_ID},f=32,s=1,v=1;AAAAAA==${ST}[16t`
}
export class ActivityImagePlayer {
  private key: string | undefined
  private present = false
  private failed = false
  get visible(): boolean {
    return this.present
  }
  get disabled(): boolean {
    return this.failed
  }
  clear(): string {
    this.key = undefined
    if (!this.present) return ''
    this.present = false
    return deleteActivityImage()
  }
  disable(): string {
    const bytes = this.clear()
    this.failed = true
    return bytes
  }
  paint(
    image: ActivityImage | undefined,
    graphics: ActivityGraphics | undefined,
    reduced: boolean,
    now: number,
  ): string {
    if (this.failed || !image?.tail || !graphics || !image.requestKey) return this.clear()
    const size = Math.min(graphics.cellHeight, graphics.cellWidth * 3, 256)
    if (!Number.isInteger(size) || size <= 0 || image.row < 0 || image.col < 0) return this.clear()
    const index = reduced ? 0 : tailFrame(image.tail, now - (image.startedAt ?? now))
    const key = `${image.requestKey}:${image.tail}:${index}:${size}:${image.row}:${image.col}:${image.color}`
    if (this.key === key) return ''
    const payload = tailPixels(image.tail, index, size, image.color)
    let bytes = `${this.clear()}7[${image.row + 1};${image.col + 1}H`
    for (let offset = 0; offset < payload.length; offset += 4096) {
      const more = offset + 4096 < payload.length ? 1 : 0
      bytes +=
        offset === 0
          ? `${APC}a=T,f=32,o=z,s=${size},v=${size},i=${ACTIVITY_IMAGE_ID},C=1,q=2,m=${more};${payload.slice(offset, offset + 4096)}${ST}`
          : `${APC}m=${more};${payload.slice(offset, offset + 4096)}${ST}`
    }
    this.present = true
    this.key = key
    return `${bytes}8`
  }
}
