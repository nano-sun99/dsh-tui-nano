# dsh-tui-nano 0.2.1 发布验收

- **结论：发布（2026-11-02 用户指示构建 0.2.1、发布并安装）。** 发行渠道为 **GitHub Release `v0.2.1`**；**npm registry 仍不发布**。
- 产物：`packaging/dist/dsh-tui-nano-0.2.1.tgz`，579,366 字节 / 153 文件；SHA-256 `c346eeeeac2880151ff781696269c20a7377a7e1db0afb40f1223d8996320767`；npm integrity `sha512-jCjchW/VWJSqAj2h4gajyVp5TMfvF8KU1oCoyNZNu/BQgQPe0VtgYY3rle97aNQCBkevwBNA4klm5Po+c93jAQ==`。
- 构建基线：`59f34d0`（Merge PR #156）+ 本发布提交（`package.json` / lock 0.2.1、e2e Monitor 用例显式 `workspace-write`、README 版本面、本记录）。tag 打在发布 PR 的合并 commit。
- 安装：下载附件后 `npm install -g ./dsh-tui-nano-0.2.1.tgz`；**不要**执行 `npm install -g dsh-tui-nano`（E404，registry 未发布）。

## 本版内容（v0.2.0..v0.2.1）

| 范围 | 内容 |
| --- | --- |
| 运行时 | #139 生产构建 + 清理测量缓冲，止住长会话 OOM |
| 会话 | #143 默认新会话、`-c` / `-r` / `--root`、多窗口 |
| 命令 | #144 默认 `danger-full-access`、过程行整行 `muted`、`/compact` 预检与排队 |
| 输入 | #145 应用键盘 SS3 + kitty `KP_*` 小键盘映射 |
| transcript | #140 工具结果进 transcript 前收敛为显示预览 |
| UI | #146 状态行 cwd 按宽度预算折叠 |
| 测试 / 发布 | #147 / #141 / #150 e2e 与发布哈希用例；#142 三份 spec + 两条 ADR；#154 / #155 文档回填 |

## 验证

- `npm run typecheck`：通过。
- `npm test`：unit 503 / 503，feature 47 / 47。
- `npm run test:e2e`：61 项中 58 通过、0 失败、3 跳过（439s）。
- `npm run prepack`：通过（153 文件，入口 `dist/bin.js` 带 shebang）。
- lint 存量红：2 error + 5 warning（`tests/unit/activity.test.ts` 格式等，均与本次改动无关；0.2.0 发布记录也记过同类）。
- e2e 修正：Monitor 跨会话用例显式 `--permission-mode workspace-write`，保留审批卡流程；默认 bypass 下不再等待审批卡。

## 已知限制

- 默认 `danger-full-access`：无沙箱；两个窗口可写同一文件，文件级隔离靠 worktree。
- #110 IME 实机观感仍待确认；`⏰ 下次看：2026-11-09`。
- 平台、崩溃隔离、调度等沿用 `docs/release/0.2.0/known-limitations.md`。

## 复核方式

```sh
git switch --detach v0.2.1
npm ci
npm run build
npm test
npm run test:e2e
npm pack --pack-destination packaging/dist
shasum -a 256 packaging/dist/dsh-tui-nano-0.2.1.tgz
# 期望：c346eeeeac2880151ff781696269c20a7377a7e1db0afb40f1223d8996320767
```
