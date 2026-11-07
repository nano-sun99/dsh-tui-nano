# dsh-tui-nano v0.2.4

本地构建的安装包（GitHub Release 附件），**未发布到 npm registry**。

## 安装

下载附件 `dsh-tui-nano-0.2.4.tgz` 后：

```sh
npm install -g ./dsh-tui-nano-0.2.4.tgz
nano --version   # nano 0.2.4 (harness 0.2.2-rc.1)
```

> 不要执行 `npm install -g dsh-tui-nano`：整包未上 npm registry（E404）。

> `0.2.3.1` 不是合法 semver，已撤回（Release 与 tag 均删除）；本版改用标准 `0.2.4`。

## 本版内容

- **官方 harness 同步**：`@deepseek-ai/dsh` `0.2.1-rc.2` → `0.2.2-rc.1`；Cordis 4.1.0、Loader/Include 1.1.0、timer 1.2.0。
- **Node 下限**：官方 0.2.2 要求 `>=24.9.0`，nano 跟随；Node 22 用户需先升级。
- **模型切换修复**：官方 0.2.2 把选择收进 Agent，旧的 `installModelSelection(agentCtx, ref)` 第二参数失效；新代码用 `agent.model.select`，`/model` 的请求真的会换模型（新增 e2e 断言）。
- **恢复会话**：会话记录的模型不可用时，启动后有界对账并回退 profile 默认，避免每个回合都报错。
- **旧 profile 自愈**：删除 0.2.2 已废弃的 `list-agents` 子路径 entry，备份为 `.bak-*`，不再有启动 warning。
- **信息面板**：模型身份读会话记录值，与状态栏一致。
- **安全边界**：Web Fetch 按官方 0.2.2 行为可访问回环/私网；README 增加「安全边界」，用户已明确接受并留痕。
- **依赖**：`pi-ai` / `pi-telemetry` 钉回 `1.4.0`，其余第三方小版本随官方树解析。

## 验证

- typecheck / build 通过。
- unit 544 / 544；feature 56 / 56。
- e2e 63 项：62 通过、0 失败、1 跳过（发布哈希复核日常跳过）。
- lint 0 error / 5 存量 warning。
- Node 24.9.0 精确下限启动通过；20.20 按预期拒绝。
- 真实 profile 无 `list-agents` warning；旧 v4 会话可恢复。

## 校验

```
文件名    dsh-tui-nano-0.2.4.tgz
大小      598,021 字节 / 157 文件
SHA-256   82b241761fa58f6df3a516d98f0587ba8a58a6db5902bb29b0e1ea3ba8af3be3
integrity sha512-FRsbX5s7KR4VPrET0m8RBqwyda520QOxX4S3K6VyI334HbIq0Br3d8h1LmX9IrJA/3KuVMKshUnQUFfn8t5tcQ==
```
