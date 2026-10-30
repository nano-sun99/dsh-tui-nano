# 已知限制（0.2.0）

本清单同时是 README「已知边界」的来源。未勾掉的条目不是待办，而是已经接受的产品边界。

## 必须披露（spec §5）

| # | 限制 | 后果 / 缓解 |
| --- | --- | --- |
| 1 | **无崩溃隔离** | UI 与业务同在一个 Node 进程；渲染或业务异常一起结束。恢复靠官方会话持久化，重开后 resume |
| 2 | **共享事件循环上限** | 渲染、输入与官方 Agent 共用一个事件循环；重负载下延迟互相影响，没有独立渲染线程 |
| 3 | **强杀后终端可能残留** | `SIGKILL` 无法捕获，raw mode / 备用屏可能留在终端；下次启动检测到陈旧挂载锁会提示运行 `reset` |
| 4 | **调度没有暂停 / 恢复** | 停止任务只能删除；没有暂停 API |
| 5 | **投递非严格一次** | 调度与 Monitor 的投递可能重复，消费方需容忍重复 |
| 6 | **Monitor `notify` 计费** | 默认 `quiet`：官方 inject，不唤醒、不新建 turn，内容随下一次请求计费；切 `notify` 会唤醒模型并产生费用 |
| 7 | **三处与 v1 不同的行为**（用户 2026-10-28 保留） | Monitor 默认 `quiet`；冷会话改名先取写权限（受控重启）；权限切换失败保留原值并提示重开 `/permission` 核对 |

## 运行与平台

- 只在 macOS arm64 + Ghostty 上做过手工交互验证；其他系统、终端和架构未验证。
- 只接受官方 `@deepseek-ai/dsh` `0.2.1-rc.2`；其他版本在骨架前拒绝启动。
- Node 下限 22.19；低于下限在入口给出可操作错误并退出。
- 官方依赖树自带原生预编译包（node-pty / koffi / sharp 等）；nano 自身不新增原生 addon，也不承诺整条依赖树无 native。
- 常驻两个 Node 进程（launcher + runtime）；「单一宿主」指持有业务的 runtime，不是 OS 进程数（ADR-20261029-single-process-fd-guard）。

## 证据未覆盖（不当作已验证）

- **Ghostty 真机视觉**：0.2.0 已有真机截图（深/浅、60/100 列、CJK、0.8 透明度、diff 工具行），见 `docs/release/0.2.0/evidence/ghostty/`。diff 展开态在 Ghostty 截图中为折叠，由 PTY e2e 断言；process-display 的逐项观感没有单独截图。
- **IME 组合态**：parser 按 UTF-8 / grapheme 处理，组合中的预编辑文本由终端负责；真实输入法组合未自动模拟。
- **鼠标拖选与剪贴板**：选区提取、宽字符起点、OSC 52 / pbcopy 有单测；Ghostty 实际拖选手感未取证。
- **主链路只对 mock 验证**：`tests/e2e/main-chain.test.mjs` 用本地 Anthropic Messages SSE mock 跑通对话/工具/差异/审批/完成，未连接真实模型服务。
- **断网**：未模拟真实网络不可达；「官方调用失败」路径已有 e2e（无凭据时界面显示回合出错且不崩）。
- **跨会话九面内容隔离**：session/storage 目录隔离、同根第二窗口拒绝、双 root 并发已有 e2e；transcript / 草稿 / 队列 / 附件 / 审批 / 问卷 / 终端七面已有真 PTY 内容隔离证据（`cross-surface.test.mjs`）；Monitor / 调度两面的内容隔离仍未逐面取证。
