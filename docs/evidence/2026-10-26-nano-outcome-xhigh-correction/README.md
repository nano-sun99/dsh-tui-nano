# 工具结果判定与 XHigh 扫光纠偏 · 证据

- 规格：`docs/specs/2026-10-26-nano-outcome-xhigh-correction/README.md`
- 生成：`python3 scripts/pty-evidence-input-preview.py outcome-xhigh`
- 基线：issue-68 worktree，Spec 合并 commit `91f3da6`

所有 fixture 都是测试目录里的合成会话与合成模型目录；不读取、不写入账号真实会话，也不冒充真实 `/model` 数据。

## 工具状态（PTY 文本帧）

| 文件 | 场景 |
|---|---|
| 01 / 02 / 04 / 05 | 显式 `isError=false`、输出无退出标记：100 dark / 60 light / 100 light / 60 dark；主状态「完成」，无三种未知警告 |
| 03 | 显式成功、展开（100 dark）：原始输出不变 |
| 06 / 07 / 09 / 10 | 显式失败（`isError=true`）：100 dark / 60 light / 100 light / 60 dark；只显示失败，不追加缺码警告 |
| 08 | 显式失败、展开（100 dark） |
| 11 / 12 / 14 / 15 | 真正未知（结果消息没有 `isError`）：100 dark / 60 light / 100 light / 60 dark；保留「结果未确认」「退出状态未返回」「工具未返回成功或失败结论」 |
| 13 | 真正未知、展开（100 dark） |

## XHigh 扫光（连续 ANSI 帧）

19–22 分别对应 100 dark / 60 light / 100 light / 60 dark。每帧前一行 `frame N t=<elapsed>ms cycle=<phase>ms`；从进入 XHigh 起连续采样约 3.2 秒（≥2 个 1400ms 周期），帧间隔约 50ms。帧内容为强度条与标签两行，由真实 `App::tick` 时钟驱动，不是手工 phase 渲染。

## 回归（ANSI 帧）

- 16 默认态：轨道不亮
- 17 Max：原有脉冲节奏
- 18 XHigh + reduced motion：静态底色、填充比例及标签，无高光移动

## 产物定位

- 工具状态：tmux PTY 文本捕获（`tmux capture-pane -p`）。
- 扫光与回归：ANSI 帧（扫光为连续流，回归为 `capture-pane -e` 单帧）；含 ANSI 颜色码，需用支持 ANSI 的查看器或先剥离转义序列。
- 默认分组的旧 XHigh 双相位证据可用 `python3 scripts/pty-evidence-input-preview.py` 重新生成；本次修正了 `evidence_xhigh` 使其写入 XHigh 独立时钟。
