# 鲸尾素材（固定来源）

- 上游：`01Virex/dsh-status-rotator`，提交 `0d486a80c55dabee9e62ce8d87612dc15792c805` 的 `lib/client.js`，`TAIL_ANIMATION_POSES`。
- 许可：MIT，`Copyright (c) 2026 01Virex`，完整文本见 `LICENSE`；`frames.ts` 头部同样保留。
- 帧与周期：official 150 帧 / 4 秒；wag 24 帧 / 2 秒；sway 24 帧 / 2 秒；twist 36 帧 / 2 秒。使用源 `viewBox 20 40 300 240`、evenodd 填充与原始帧序，不做补间。
- 生成：`node scripts/activity-dock/extract.mjs <client.js> <输出目录>`（需要 `sharp`，仅生成期依赖）。脚本先核对每款路径的 SHA-256，再把 128×128 alpha 蒙版 zlib 压缩写入 `tail-masks.json`；运行时只解压蒙版并按主题 accent 着色，不引入 SVG 渲染器或原生依赖。
- 来源摘要：`tail-masks.json` 的 `source` 字段记录固定提交；更换素材必须同时更新来源、摘要和提取说明，不能静默跟随远端。
