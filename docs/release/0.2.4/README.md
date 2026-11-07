# dsh-tui-nano 0.2.4 发布验收

- **结论：发布（2026-11-07 用户指示「用标准版本号 0.2.4，把 0.2.3.1 删了」）。** 发行渠道为 **GitHub Release `v0.2.4`**；**npm registry 仍不发布**。
- 产物：`packaging/dist/dsh-tui-nano-0.2.4.tgz`，598,021 字节 / 157 文件；SHA-256 `82b241761fa58f6df3a516d98f0587ba8a58a6db5902bb29b0e1ea3ba8af3be3`；npm integrity `sha512-FRsbX5s7KR4VPrET0m8RBqwyda520QOxX4S3K6VyI334HbIq0Br3d8h1LmX9IrJA/3KuVMKshUnQUFfn8t5tcQ==`。
- 构建基线：`fe41dd6`（0.2.3.1 撤回后的 main）+ 本发布提交（`package.json` / lock 0.2.4、两个 README 版本面、本记录）。tag 打在发布提交。
- 安装：下载附件后 `npm install -g ./dsh-tui-nano-0.2.4.tgz`；**不要**执行 `npm install -g dsh-tui-nano`（E404，registry 未发布）。

## 关于 0.2.3.1

`0.2.3.1` 不是合法 semver，`npm publish` 会报 `Invalid version`；用户决定撤回该版本。`v0.2.3.1` 的 GitHub Release 与 tag 已删除，版本面改为合法的 `0.2.4`。不要再引用 `0.2.3.1`。

## 本版内容（v0.2.3..v0.2.4）

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
- `npm run test:e2e`（`NANO_NODE_24=v24.9.0`、`NANO_NODE_20=v20.20.0`）：63 项中 62 通过、0 失败、1 跳过（`NANO_RELEASE_VERIFY` 未设置，发布哈希复核日常跳过）。
- `npm run lint`：0 error / 5 warning（存量 warning）。
- `npm pack` / `npm install -g <tarball>`：157 文件；隔离前缀 `nano --version` 为 `nano 0.2.4 (harness 0.2.2-rc.1)`。
- 真实数据只读验证：`~/.dsh-tui-nano/sessions` 401 个 v4 会话可读；旧会话 `-r <id>` 可在新 TUI 恢复；真实 profile 启动无 `list-agents` warning，工具表 26 项且 `list_agents` 存在。

## 已知限制

- 本机全局 `nano` 未替换；发布附件是独立 tarball，需手动安装。
- 本版仍不发布 npm registry。
- 调度门面 `ScheduleRuntime.catalog()` 当前没有生产入口，仅测试/后续 UI 使用。
- 升级带来 33 个第三方小版本漂移（AWS SDK / Smithy 补丁为主），已记录在 PR #170；`pi-ai` / `pi-telemetry` 已钉回 `1.4.0`。
