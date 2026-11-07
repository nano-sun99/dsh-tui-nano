# dsh-tui-nano 0.2.3.1 发布验收

- **结论：发布（2026-11-07 用户指示「0.2.3.1 版本吧」）。** 发行渠道为 **GitHub Release `v0.2.3.1`**；**npm registry 仍不发布**。
- 产物：`packaging/dist/dsh-tui-nano-0.2.3.1.tgz`，598,027 字节 / 157 文件；SHA-256 `52c5de8a0fad4bd43d777cc353407ac0490d79af3d59bb1bb3217fc797c57ba4`；npm integrity `sha512-KD8sqyzIFNIWzlmIg+hDcBKufZUj2Bgtb0YGtvR3Sh8as2y9KA8L3iyMfqWUwAutaPhqYEVewG2+JFUiA2ChpQ==`。
- 构建基线：`d8ec678`（Merge PR #170）+ 本发布提交（`package.json` / lock 0.2.3.1、两个 README 版本面、本记录）。tag 打在发布提交。
- 安装：下载附件后 `npm install -g ./dsh-tui-nano-0.2.3.1.tgz`；**不要**执行 `npm install -g dsh-tui-nano`（E404，registry 未发布）。

## 版本号注意事项

`0.2.3.1` **不是合法 semver**：`npm publish` 会直接报 `Invalid version: "0.2.3.1"`。本项目当前不发布 npm registry，且已实测 `npm pack` 与 `npm install -g <tarball>` 可用，所以本版按用户指定使用该版本号；下一次进入 registry 或使用 `npm version` 前必须换成合法 semver（如 `0.2.4`）。

## 本版内容（v0.2.3..v0.2.3.1）

| 范围 | 内容 |
| --- | --- |
| 官方 harness | `@deepseek-ai/dsh` `0.2.1-rc.2` → `0.2.2-rc.1`；Cordis `4.1.0` / Loader+Include `1.1.0` / timer `1.2.0` |
| Node 下限 | 官方整包要求 `>=24.9.0`；`engines`、入口检查、README 与 e2e 矩阵同步 |
| 模型切换 | 改用 `agent.model.select` / `agent.model.current()`；旧 `installModelSelection` 第二参数已失效，修复「/model 只改界面不改请求」 |
| 恢复会话 | 会话记录的模型失效时，启动后 2s 有界对账，回退 profile 默认并给可见提示 |
| 旧 profile | 启动时删除已废弃的 `list-agents` 子路径 entry 并备份 `.bak-*`，不再产生启动 warning |
| 信息面板 | 模型身份优先读 `agent.model.current()`，与状态栏一致 |
| 安全边界 | Web Fetch 按官方 0.2.2 行为可访问回环/私网；README 增加「安全边界」，用户已明确接受并留痕 |
| 依赖 | `@earendil-works/pi-ai` / `pi-telemetry` 钉回 `1.4.0`；其余第三方小版本随官方树解析 |

## 验证

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm test`：unit 544 / 544；feature 56 / 56。
- `npm run test:e2e`（`NANO_NODE_24=v24.9.0`、`NANO_NODE_20=v20.20.0`）：63 项中 62 通过、0 失败、1 跳过（`NANO_RELEASE_VERIFY` 未设置，发布哈希复核日常跳过；438.9s）。
- `npm run lint`：0 error / 5 warning（存量 warning）。
- `npm pack` / `npm install -g <tarball>`：157 文件；隔离前缀 `nano --version` 为 `nano 0.2.3.1 (harness 0.2.2-rc.1)`。
- 真实数据只读验证：`~/.dsh-tui-nano/sessions` 401 个 v4 会话可读；旧会话 `-r <id>` 可在新 TUI 恢复；真实 profile 启动无 `list-agents` warning，工具表 26 项且 `list_agents` 存在。

## 已知限制

- 本机全局 `nano` 未替换；发布附件是独立 tarball，需手动安装。
- 本版仍不发布 npm registry；版本号 `0.2.3.1` 不可用于 `npm publish`。
- 调度门面 `ScheduleRuntime.catalog()` 当前没有生产入口，仅测试/后续 UI 使用。
- 升级带来 33 个第三方小版本漂移（AWS SDK / Smithy 补丁为主），已记录在 PR #170；`pi-ai` / `pi-telemetry` 已钉回 `1.4.0`。
