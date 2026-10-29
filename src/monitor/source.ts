/**
 * Monitor 投递的官方消息来源标记（spec §3.4：`role=user / source=monitor`）。
 *
 * 与官方 schedule 的做法一致：用声明合并给 `MessageSourceMap` 补一个来源种类，
 * 只是展示身份，不构成授权。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    monitor: { kind: 'monitor' }
  }
}

export const MONITOR_SOURCE = { kind: 'monitor' } as const
