# 真终端证据（主活动栏与鲸尾）

- 环境：Ghostty 1.4.0，macOS 27.0.1（arm64），Apple M5；采集日期 2026-11-01。
- 方法：隔离探针 `scripts/activity-dock/ghostty-probe.py`（不经 agent、无凭据、无模型调用）跑四款动画与清理；另用真实 `dist/bin.js` + 本地 slow mock（`DEEPSEEK_BASE_URL`，假 key）做产品冒烟，无真实模型消费。
- 协议：Kitty graphics APC。`a=q` 探测 + `CSI 16 t` 取单元格像素；`a=T,f=32,o=z,C=1,q=2` 逐帧发送 32 位 RGBA（zlib），`a=d,d=I` 删除。图像边长 `min(cellHeight, cellWidth*3, 256)`，方形、不拉伸。
- 场景与实测尺寸：
  - `dark-100/`：100 列 × 30 行，cell 8×18，image 18×18；`report.json` 记录终端版本、探测回应、光标与草稿校验。
  - `light-60/`：60 列 × 30 行，cell 8×18，image 18×18；同上。
- 文件：`official-* / wag-* / sway-* / twist-*` 为四款逐帧；`hidden-*` 隐藏清除；`static-*` 减少动态效果静态图；`fallback-*` 文字降级。动画切换前先删除旧图片再清行（2026-11-01 清理了旧证据中"理…"重影）。
- 产品冒烟 `product-dark-100/`：真实产品在 Ghostty 里显示鲸尾 +「正在处理…」；`product-light-60/` 为 60 列浅色主题下的同一状态；正文进入显示路径后活动栏空白且图片删除；tty 级 resize（`stty -f <tty> cols 60` 触发 SIGWINCH）后重排、图片移至新位置，回到 100 列后无残影；空闲仍保留一行。
- 未覆盖 / 边界：
  - Ghostty 拒绝 AX `set size`，resize 用 tty 级 SIGWINCH 模拟；窗口本身仍为 100 列，因此 60 列截图右侧可能保留旧列。
  - 真实 IME 组合输入未跑；只验证草稿文字与光标位置不因图片更新改变。
  - 协议失败/不支持的降级由单测夹具覆盖，未在真终端制造失败。
- 复跑：在 Ghostty 窗口内执行
  `python3 scripts/activity-dock/ghostty-probe.py --frames src/activity/tail-masks.json --out <dir> --hold 3 --theme dark`；
  截图可用 `screencapture -x -l <window-id> -o <file>`。
