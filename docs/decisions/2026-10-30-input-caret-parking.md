# ADR-20261030-input-caret-parking：交互输入把隐藏真光标停靠到 caret

- 状态：生效中
- 日期：2026-10-30
- 决策人：用户
- 适用范围：所有可编辑文本输入的终端光标与 IME 锚点
- 取代：无
- 被取代：无
- 决策来源：用户 2026-10-30 在方案确认中选择「反色块 + 真光标暗中停靠」，并要求按 Claude Code 的实现对齐

## 决定

- 视觉光标继续用反色块，不改成显示硬件光标。
- 每一帧把隐藏的硬件光标 CUP 到 caret 所在的屏幕格；无 caret 时不停靠。
- 未来新增的交互输入面沿用同一契约：视觉可自绘，但 IME 锚点必须由停靠到 caret 的物理光标承担。

## 依据

- 终端输入法的候选窗锚在物理光标位置；隐藏光标仍保留位置。Claude Code 的 `useDeclaredCursor` + 帧末 CUP 已按此方式运行（本机解包源码 `src/ink/hooks/use-declared-cursor.ts`、`src/ink/ink.tsx:654-696`）。
- 本仓当前只在启动时隐藏真光标（`src/runtime/terminal.ts:56`），帧末没有 CUP（`src/render/ansi.ts:107-127`），导致候选窗跟着最后一个重绘区域漂移。

## 否决了什么

- 只显示硬件光标、删掉反色块：光标形状与闪烁跟终端设置走，观感不一致。
- 反色块与真光标都显示：重影、闪烁。
- 不做停靠、只修提示：IME 漂移无法解决。

## 接受的代价

- 依赖终端在隐藏光标下仍按物理光标定位候选窗；若某终端不跟随，需要退回显示光标。
- 有 caret 的帧多一次 CUP 写入；无 caret 的帧不写。

## 允许重开的条件

- 目标终端（Ghostty / iTerm2 / Terminal.app / VS Code 终端）出现隐藏光标不定位 IME 的可复现实测。
- 需要统一光标形状/闪烁，或需要读屏软件跟随主输入框之外的输入面。

## 关联

- spec：`docs/specs/2026-10-30-nano-input-caret-notice/README.md`
- 相关：`ADR-20261030-notice-lifecycle`
