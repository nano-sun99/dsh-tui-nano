# 强度扫光改绑官方倒数第二档 · 证据

- 规格：`docs/specs/2026-10-26-nano-effort-sweep-binding/README.md`
- 生成：`python3 scripts/pty-evidence-input-preview.py effort-sweep-binding`
- 构建：worktree `issue-72`，基线 commit `7a67143`，`target/debug/nano`
- 环境：真实 dsh `0.2.1-rc.2`、真实账号凭据；真实目录 `Off / Low / High / Max`，扫光档为倒数第二档 `High`

所有帧都是真实 PTY 捕获：tmux 内启动真实二进制，打开 `/model`，方向键聚焦 `High`，随后每约 50ms `capture-pane -p -e` 采样 3.2 秒。整个采集不发送消息、不产生模型费用；每次运行会创建一个真实会话。

## 扫光连续帧

| 文件 | 场景 |
|---|---|
| 01-real-sweep-100-dark.txt | 真实目录 100 列 dark，聚焦 High，64 帧 / 3154ms |
| 02-real-sweep-60-light.txt | 真实目录 60 列 light，聚焦 High，64 帧 / 3155ms |
| 03-real-sweep-100-light.txt | 真实目录 100 列 light，聚焦 High，64 帧 / 3155ms |
| 04-real-sweep-60-dark.txt | 真实目录 60 列 dark，聚焦 High，64 帧 / 3153ms |

每帧前一行 `frame N t=<elapsed>ms`，`t` 从采集循环开始计，不是应用内部相位；聚焦 High 后立即开始采集，第一帧接近起播。帧内容是整屏 ANSI。

## 回归帧

| 文件 | 场景 |
|---|---|
| 05-real-max-pulse-100-dark.txt | 真实目录聚焦 Max，间隔 600ms 两帧；Max 脉冲仍在动，未被扫光替换 |
| 06-real-low-static-100-dark.txt | 真实目录聚焦 Low，间隔 600ms 两帧；无扫光、无脉冲 |
| 07-real-reduced-motion-100-dark.txt | `NANO_REDUCED_MOTION=1`，聚焦 High，间隔 700ms 两帧；高光静止 |

## 测量方法

- 从每帧里取背景色 span 最多的那一行作为强度条；按 ANSI `48;2;r;g;b` 还原每个 cell 的颜色。
- 填充区按官方档位位置计算：四档时 High（索引 2）占 `2/3` 轨道宽度（100 列实测 64 格，60 列实测 37 格），只在填充区内找亮度峰值。
- dark 主题下轨道 `rgb(66,73,83)` 比高光暗；light 主题下轨道 `rgb(196,198,201)` 比高光亮，因此必须限制在填充区，不能在全条上取峰值。
- 实测峰位：
  - 01：1 → 63，52 个不同位置，约 1400ms 回绕
  - 02：0 → 36，36 个不同位置，约 1400ms 回绕
  - 03：1 → 63，47 个不同位置，约 1400ms 回绕
  - 04：0 → 36，37 个不同位置，约 1400ms 回绕
- 05 两帧强度条颜色不同；06 / 07 两帧强度条逐 cell 相同。

## 确定性回归（Rust 单测）

真实目录帧证明“真机可见”；周期、相位、边界由 `cargo test -p nano-app` 覆盖：

- `the_sweep_is_visible_from_the_first_frame_and_never_blanks`：1400ms 内每一帧都有高光。
- `the_sweep_moves_left_to_right_over_the_fill`：高光从左到右移动。
- `the_sweep_clock_restarts_on_entry_and_reopen_but_not_on_repaint`：进入 / 重入起播，重绘不重置。
- `the_real_catalog_sweeps_on_the_second_highest_level`：`Off / Low / High / Max` 下 High 使用扫光配色，且不再使用 High 的灰蓝。
- `sets_without_a_second_highest_level_do_not_sweep`：两档集合不扫光。
- `a_max_second_to_last_keeps_the_pulse_without_the_sweep`：倒数第二档为 max 时只脉冲。
- `an_xhigh_that_is_not_second_to_last_stays_static`：id 为 xhigh 但不在倒数第二位时不扫光。

## 边界

- 这是本机账号目录的事实，不外推到其他账号或 provider；其他档位集合按 spec §3 规则处理。
- `t` 是采集循环时间，不冒充应用内部相位；跨帧比较峰位用于证明移动和回绕，不用于精确测量 1400ms 的起始偏移。
- 真实目录证据依赖本机 dsh 与凭据，不能在无凭据环境复现；确定性相位与 reduced motion 由 fixture 单测和旧证据目录的合成帧覆盖。
