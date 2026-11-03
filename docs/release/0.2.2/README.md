# dsh-tui-nano 0.2.2 发布验收

- **结论：发布（2026-11-03 用户指示发布 0.2.2）。** 发行渠道为 **GitHub Release `v0.2.2`**；**npm registry 仍不发布**。
- 产物：`packaging/dist/dsh-tui-nano-0.2.2.tgz`，592,887 字节 / 155 文件；SHA-256 `0d86aa15518da844d2c1f58c2bc71769e42cfeac0026bd22983ff21391d9c2a2`；npm integrity `sha512-475/pcF7GVB1oytt4NGLPpcB9jSQS/26saGKlw32l2bh/WaSXm3i0OGvTGLe6WRoXV+o+NjmeuiCuwekIDu+aQ==`。
- 构建基线：`2e1878a`（Merge PR #161）+ 本发布提交（`package.json` / lock 0.2.2、README 版本面、本记录）。tag 打在发布 PR 的合并 commit。
- 安装：下载附件后 `npm install -g ./dsh-tui-nano-0.2.2.tgz`；**不要**执行 `npm install -g dsh-tui-nano`（E404，registry 未发布）。

## 本版内容（v0.2.1..v0.2.2）

| 范围 | 内容 |
| --- | --- |
| 状态行 | #159 左下角常驻 `v<version> · <cwd>`；版本缺失只显示 cwd |
| 提问纪律 | #159 注册 `nano:question-discipline`，只在真岔路开问卷卡 |
| 决策留痕 | #159 问卷答案投影为 `· 问题 → 答案`；跳过 / 取消 / 多选 / 自定义可回看 |
| 流式过程 | #159 思考保留 2 行尾巴；前台 Bash 保留最后 5 行 live 输出，完成后不撤回 |
| 输入 | #159 运行中 `Esc` 停止；Other 行未聚焦且空值不再显示 `直接输入` |
| 视觉 | #159 四类视觉：`❯` / `∴` / `⏺` / `⎿`、`userBg` 整行底色、diff `⏺ Update` + `┄` 框 + 行号 / `+N -M` |
| 规格 / ADR | #158 一份 spec + 4 条 ADR；#160 实施与轻审修订；#161 spec 回填 |

## 验证

- `npm run typecheck`：通过。
- `npm run lint`：0 error / 5 warning（均为存量 warning，无 error）。
- `npm test`：unit 530 / 530，feature 55 / 55。
- `npm run test:e2e`：61 项中 58 通过、0 失败、3 跳过（428.8s）。
- `npm run prepack`：通过（155 文件，入口 `dist/bin.js` 带 shebang）。
- 轻审：实施期 1 个 agent 对抗审查，8 条发现（1 H / 3 M / 4 L）全部修复后复跑全绿；处置见 PR #160 评论。

## 已知限制

- 默认 `danger-full-access`：无沙箱；两个窗口可写同一文件，文件级隔离靠 worktree。
- #110 IME 实机观感仍待确认；`⏰ 下次看：2026-11-09`。
- #159 的观察项不进本单验收：模型实际少问比例、真实终端下 Bash 输出观感；出问题另开 bug 单。
- 平台、崩溃隔离、调度等沿用 `docs/release/0.2.0/known-limitations.md`。

## 复核方式

```sh
git switch --detach v0.2.2
npm ci
npm run build
npm test
npm run test:e2e
npm pack --pack-destination packaging/dist
shasum -a 256 packaging/dist/dsh-tui-nano-0.2.2.tgz
# 期望：0d86aa15518da844d2c1f58c2bc71769e42cfeac0026bd22983ff21391d9c2a2
```
