/** Pre-boot frame: shown before the official core is ready (spec §2.3). */
import { Box, Text } from '../render/components.ts'
import { EDGE } from '../theme/spacing.ts'
import type { Theme } from '../theme/theme.ts'

export interface SkeletonProps {
  readonly theme: Theme
  readonly width: number
  readonly height: number
  readonly rootId: string
  readonly profileDir: string
  readonly dirtyNotice?: string
}

export function Skeleton(props: SkeletonProps) {
  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.height}
      paddingX={EDGE}
      paddingTop={1}
    >
      <Text color={props.theme.accent} bold>
        nano
      </Text>
      <Text color={props.theme.muted}>{'  正在启动官方核心…'}</Text>
      <Text> </Text>
      <Text color={props.theme.faint}>{`  根：${props.rootId}`}</Text>
      <Text color={props.theme.faint}>{`  profile：${props.profileDir}`}</Text>
      {props.dirtyNotice ? (
        <>
          <Text> </Text>
          <Text color={props.theme.warning}>{`  ${props.dirtyNotice}`}</Text>
        </>
      ) : null}
    </Box>
  )
}
