# dsh-tui-nano v0.2.2

本地构建的安装包（GitHub Release 附件），**未发布到 npm registry**。

## 安装

下载附件 `dsh-tui-nano-0.2.2.tgz` 后：

```sh
npm install -g ./dsh-tui-nano-0.2.2.tgz
nano --version   # nano 0.2.2 (harness 0.2.1-rc.2)
```

> 不要执行 `npm install -g dsh-tui-nano`：整包未上 npm registry（E404）。

## 本版内容

- **#159** harness 手感：状态行版本、提问纪律、问卷决策留痕、流式思考尾巴、前台 Bash 最后 5 行、Esc 停止、四类视觉语言。
- **#158** spec 与 4 条 ADR：提问纪律、流式过程、问卷记录、四类视觉。
- **#160** 实施与轻审修订；**#161** spec 回填。

## 验证

- typecheck 通过；lint 0 error / 5 warning；unit 530 / 530；feature 55 / 55。
- e2e：61 项中 58 通过、0 失败、3 跳过（428.8s）。
- prepack 通过（155 文件，入口 `dist/bin.js`）。

## 产物

- 大小 / 文件数：592,887 字节 / 155 文件
- SHA-256：`0d86aa15518da844d2c1f58c2bc71769e42cfeac0026bd22983ff21391d9c2a2`
- npm integrity：`sha512-475/pcF7GVB1oytt4NGLPpcB9jSQS/26saGKlw32l2bh/WaSXm3i0OGvTGLe6WRoXV+o+NjmeuiCuwekIDu+aQ==`
- 构建基线：`2e1878a` + 发布提交；tag 打在发布 PR 的合并 commit。

## 已知限制

- 默认 `danger-full-access`：无沙箱；两个窗口可写同一文件，文件级隔离靠 worktree。
- #110 IME 实机观感仍待确认（下次看 2026-11-09）。
- #159 观察项不在本单验收：模型实际少问比例、真实终端下 Bash 输出观感；出问题另开 bug 单。
- 平台、崩溃隔离、调度等沿用 `docs/release/0.2.0/known-limitations.md`。
