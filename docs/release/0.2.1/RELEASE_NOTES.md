# dsh-tui-nano v0.2.1

本地构建的安装包（GitHub Release 附件），**未发布到 npm registry**。

## 安装

下载附件 `dsh-tui-nano-0.2.1.tgz` 后：

```sh
npm install -g ./dsh-tui-nano-0.2.1.tgz
nano --version   # nano 0.2.1 (harness 0.2.1-rc.2)
```

> 不要执行 `npm install -g dsh-tui-nano`：整包未上 npm registry（E404）。

## 本版内容

- **#139** 生产构建 + 清理测量缓冲，止住长会话 OOM。
- **#143** 默认新会话、`-c` / `-r` / `--root`、多窗口。
- **#144** 默认 `danger-full-access`、过程行整行 `muted`、`/compact` 预检与排队。
- **#145** 应用键盘 SS3 + kitty `KP_*` 小键盘映射。
- **#140** 工具结果进 transcript 前收敛为显示预览。
- **#146** 状态行 cwd 按宽度预算折叠。
- **#147 / #141 / #150** e2e 与发布哈希用例；**#142** 三份 spec + 两条 ADR；**#154 / #155** 文档回填。

## 验证

- typecheck 通过；unit 503 / 503；feature 47 / 47。
- e2e：61 项中 58 通过、0 失败、3 跳过（439s）。
- prepack 通过（153 文件，入口 `dist/bin.js`）。
- lint 存量红 2 error + 5 warning（`tests/unit/activity.test.ts` 格式等，与本次改动无关）。

## 产物

- 大小 / 文件数：579,366 字节 / 153 文件
- SHA-256：`c346eeeeac2880151ff781696269c20a7377a7e1db0afb40f1223d8996320767`
- npm integrity：`sha512-jCjchW/VWJSqAj2h4gajyVp5TMfvF8KU1oCoyNZNu/BQgQPe0VtgYY3rle97aNQCBkevwBNA4klm5Po+c93jAQ==`
- 构建基线：`59f34d0` + 发布提交；tag 打在发布 PR 的合并 commit。

## 已知限制

- 默认 `danger-full-access`：无沙箱；两个窗口可写同一文件，文件级隔离靠 worktree。
- #110 IME 实机观感仍待确认（下次看 2026-11-09）。
- 平台、崩溃隔离、调度等沿用 `docs/release/0.2.0/known-limitations.md`。
