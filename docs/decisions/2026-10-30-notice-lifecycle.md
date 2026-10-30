# ADR-20261030-notice-lifecycle：notice 单槽、信息类 8 秒、错误保留到下次编辑、显示在状态行左侧

- 状态：生效中
- 日期：2026-10-30
- 决策人：用户
- 适用范围：主界面的临时 notice（模型/强度切换、停止、引导、发送失败等）
- 取代：无
- 被取代：无
- 决策来源：用户 2026-10-30 决定「notice 应该有 TTL」并选择 8 秒；「临时挤占一下 cwd，尽可能不要新增行也不要强行占一行」

## 决定

- notice 是单槽状态：文本 + 语气（`info` / `danger`）+ 过期时间；新通知覆盖旧通知。
- 信息类 8 秒自动消失；错误类不自动过期，保留到下一次文本编辑或被新通知替换。
- 任何文本编辑立即清除。
- 显示在底部状态行左侧，临时顶替 cwd；不新增行，不改变布局高度；不进入输入区文本。
- 右侧快捷键提示在有空间时保留，否则让位；超宽文本截断。

## 依据

- Claude Code：模型切换提示 `Set model to X` 走 `addNotification(..., priority: 'immediate')`（`src/utils/handlePromptSubmit.ts:272-287`）；默认超时 8000ms（`src/context/notifications.tsx:34`）；非全屏显示在 footer（`src/components/PromptInput/PromptInputFooter.tsx:145`）；全屏用绝对定位、`height=1` + `overflow:hidden` 做单行截断（`src/components/PromptInput/PromptInput.tsx:2293`，注释 2277-2285）。
- 用户反馈：切换档位后的提示一直贴在输入行，被当成占位符。

## 否决了什么

- 独立常驻行、右上角浮层 toast、输入框内联。
- 4 秒或 5 秒的 TTL（用户最终选 8 秒）。
- 只做「打字即清」而不设 TTL。
- 队列/优先级（本仓暂不需要）。

## 接受的代价

- 提示显示期间 cwd 不可见；长提示被截断。
- 连续通知只保留最后一条。
- 错误提示会一直显示到用户编辑或下一条通知。

## 允许重开的条件

- 需要同时显示多条通知或排队。
- 需要更长驻留，或状态行宽度不足以承载重要提示。
- 出现必须跨会话保留的通知类型。

## 关联

- spec：`docs/specs/2026-10-30-nano-input-caret-notice/README.md`
- 相关：`ADR-20261030-input-caret-parking`
