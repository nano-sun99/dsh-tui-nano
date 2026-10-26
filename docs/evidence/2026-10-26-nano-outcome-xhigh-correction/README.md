# 工具结果判定与 XHigh 扫光纠偏 · 证据

- 规格：`docs/specs/2026-10-26-nano-outcome-xhigh-correction/README.md`
- 生成：`python3 scripts/pty-evidence-input-preview.py outcome-xhigh`
- 基线：issue-68 worktree，Spec 合并 commit `91f3da6`

所有 fixture 都是测试目录里的合成会话与合成模型目录；不读取、不写入账号真实会话，也不冒充真实 `/model` 数据。

## 工具状态（PTY 文本帧）

| 文件 | 场景 |
|---|---|
| 01 / 02 | 显式 `isError=false`、输出无退出标记：100 列 dark / 60 列 light；主状态「完成」，无三种未知警告 |
| 03 | 显式成功、展开：原始输出不变 |
| 04 / 05 | 显式失败（`isError=true`）：100 列 dark / 60 列 light；只显示失败，不追加缺码警告 |
| 06 | 显式失败、展开 |
| 07 / 08 | 真正未知（结果消息没有 `isError`）：100 列 dark / 60 列 light；保留「结果未确认」「退出状态未返回」「工具未返回成功或失败结论」 |
| 09 | 真正未知、展开 |

## XHigh 扫光（连续 ANSI 帧）

13–16 分别对应 100/60 列 × dark/light。每帧前一行 `frame N t=<elapsed>ms cycle=<phase>ms`；从进入 XHigh 起连续采样约 3.2 秒（≥2 个 1400ms 周期），帧间隔约 50ms。帧内容为强度条与标签两行，由真实 `App::tick` 时钟驱动，不是手工 phase 渲染。

## 回归（PTY 文本帧）

- 10 默认态：轨道不亮
- 11 Max：原有脉冲节奏
- 12 XHigh + reduced motion：静态底色、填充比例及标签，无高光移动

## 产物定位

- 工具状态与回归：tmux PTY 文本捕获（`tmux capture-pane -p`）。
- 扫光：测试二进制直接输出的 ANSI 连续帧；含 ANSI 颜色码，需用支持 ANSI 的查看器或先剥离转义序列。
