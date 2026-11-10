# dsh-tui-nano v0.2.5

本地构建的安装包（GitHub Release 附件），**未发布到 npm registry**。

## 安装

下载附件 `dsh-tui-nano-0.2.5.tgz` 后：

```sh
npm install -g ./dsh-tui-nano-0.2.5.tgz
nano --version   # nano 0.2.5 (harness 0.2.2-rc.1)
```

> 不要执行 `npm install -g dsh-tui-nano`：整包未上 npm registry（E404）。

## 本版内容

- **需求阶段强制调研**：根 agent 新增常驻纪律段，非平凡需求先给调研清单（关键文件与路径 / 可复用函数或模式 / 调用链 / 风险 / 验证方式），再给方案。
- **plan 五阶段**：进入 `/plan` 后按「并行调研 → 设计 → 复核 → 写计划 → 交审」推进，替代官方单段式 plan 引导；官方只读、decision-complete 清单与 `exit_plan_mode` 约束保留。
- **测试预算修复**：heap-growth 预算测试不再产生负 GC 基线，跨 Node 版本运行更稳。
- **文档**：新增 spec、ADR 与三场真实会话 evidence。

## 验证

- typecheck / build 通过。
- unit 547 / 547；feature 56 / 56。
- e2e 63 项：62 通过、0 失败、1 跳过（发布哈希复核留到 tag 后）。
- lint 0 error / 5 存量 warning。
- 隔离前缀安装后 `nano --version` 为 `nano 0.2.5 (harness 0.2.2-rc.1)`。

## 校验

```
文件名    dsh-tui-nano-0.2.5.tgz
大小      599,780 字节 / 157 文件
SHA-256   af145f45aa389ee7c06843e4ce27054e75db87e491db0f173ebb3ca0ccdf4401
integrity sha512-T1j6gVyYtiJIUqGquKFu8yQfHrr9zyzppg55EWptYOYB8j4DZC/sCpDDmx2d+kW4Q6ZaxwdnK0vQSNTXq2ehLA==
```
