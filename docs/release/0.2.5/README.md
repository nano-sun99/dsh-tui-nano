# dsh-tui-nano 0.2.5 发布验收

- **结论：发布（2026-11-10 用户指示「构建 nano 0.2.5」，随后拍板「发布到 GitHub」）。** 发行渠道为 **GitHub Release `v0.2.5`**；**npm registry 仍不发布**。
- 产物：`packaging/dist/dsh-tui-nano-0.2.5.tgz`，599,780 字节 / 157 文件；SHA-256 `af145f45aa389ee7c06843e4ce27054e75db87e491db0f173ebb3ca0ccdf4401`；npm integrity `sha512-T1j6gVyYtiJIUqGquKFu8yQfHrr9zyzppg55EWptYOYB8j4DZC/sCpDDmx2d+kW4Q6ZaxwdnK0vQSNTXq2ehLA==`。
- 构建基线：`b5bd222`（main，PR #176 合并后）+ 本发布提交（`package.json` / lock 0.2.5、两个 README 版本面、本记录）。tag 打在发布提交。
- 安装：下载附件后 `npm install -g ./dsh-tui-nano-0.2.5.tgz`；**不要**执行 `npm install -g dsh-tui-nano`（E404，registry 未发布）。

## 本版内容（v0.2.4..v0.2.5）

| 范围 | 内容 |
| --- | --- |
| 调研纪律 | #174：根 agent 新增常驻段 `nano:research-discipline`（order 10140）。非平凡需求先给可核对的调研清单（关键文件 / 可复用模式 / 调用链 / 风险 / 验证方式），小改与纯查事实不触发仪式 |
| plan 五阶段 | `/plan` 内整段覆盖官方 `plan-mode` 引导：并行调研 → 设计 → 复核 → 写计划 → 交审；保留官方只读、`todo_write` 禁令、decision-complete 清单与 `exit_plan_mode` 约束 |
| 测试预算 | #176：heap-growth 预算测试避免负 GC 基线，消除跨 Node 版本的假失败 |
| 文档 | 新增 spec、ADR-20261107、三场真实会话 evidence；issue #174 仍为待上线 |

## 验证

- `npm run typecheck`：通过。
- `npm pack`（prepack 内 build + keymap 文档校验 + prepack-check）：通过，157 文件。
- `npm test`：unit 547 / 547；feature 56 / 56。
- `npm run test:e2e`（`NANO_NODE_24=v24.9.0`、`NANO_NODE_20=v20.20.0`）：63 项中 62 通过、0 失败、1 跳过（`NANO_RELEASE_VERIFY` 未设置，发布哈希复核留到 tag 后）。
- `npm run lint`：0 error / 5 warning（存量 warning）。
- 隔离前缀安装 `npm install -g --prefix <tmp> ./packaging/dist/dsh-tui-nano-0.2.5.tgz`：`nano --version` 输出 `nano 0.2.5 (harness 0.2.2-rc.1)`。

## 已知限制

- 本机全局 `nano` 未替换；产物需手动安装。
- 发布哈希复核在发布提交上以 `NANO_RELEASE_VERIFY=1` 执行，结果见 `version-matrix.md`；tag 与发布提交内容一致。
- 调研纪律是提示层软约束，模型不保证 100% 遵守；plan 模式只读不是安全边界（spec §5.5）。
- 本版仍不发布 npm registry；官方 harness 维持 `@deepseek-ai/dsh` `0.2.2-rc.1`，Node 下限 `>=24.9.0`。
