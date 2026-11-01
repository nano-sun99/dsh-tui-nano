# #125 问卷卡实施证据

- 日期：2026-11-01；工作区：`issue-125`。
- 获批规格：[问卷卡 parity](../../specs/2026-11-01-nano-question-card-parity/README.md)。
- 沿用现行 [ADR-20261101-question-card-cancel](../../decisions/2026-11-01-question-card-cancel.md)，没有新增或取代长期决定。
- 接管既有未提交实现，保留后补齐回看焦点、缺项校验、跳过后重答、实际 Shift+Tab 解析、题签点击、短屏预算和真实取消链路。

## 自动化覆盖

| 验收 | 证据 |
| --- | --- |
| A1 / A4 / A5 / A9 | `tests/unit/question-card.test.ts`、`tests/unit/question-navigation.test.ts`、`tests/unit/decisions.test.ts`：键盘/鼠标单选前进，多选空选拦截，其他行可达，跳过空数组、回改后重新校验。 |
| A2 / A3 / A11 / A12 | `tests/feature/question-render.test.ts`：60/100 列 × 深浅主题，编号/指针/选中符号，5ch 描述只一次，实际 renderer ANSI RGB 断言、可点击题签、长标题退让。 |
| A6 / A7 | 逐题焦点恢复，Tab/Shift+Tab/左右切页，末题到提交页，缺项返回首道未答题，固定提交按钮和错误提示。 |
| A8 | `tests/feature/question-service.test.ts` 使用真实 Cordis + 官方 UserQuestionService；取消还原为官方 UserQuestionError / ASK_ABORTED，未触发调用方 signal。`cancel.terminal.txt` 记录真实官方宿主工具错误。 |
| A10 | 长列表的箭头焦点可见、PageUp/Down、固定页脚；所有高度与 transcript 预算复用同一布局计算。 |
| A13 | 原审批单测、子代理 gate 单测与其余全量单测/feature 测试保留。 |
| A14 | 计划审阅沿用同卡：header、Markdown detail、approve 标签；长 detail 保留行数提示。 |
| A15 | `npm test`、`npm run typecheck`、`npm run lint`、`node scripts/keymap-docs.mjs --check`、`npm run build`。lint 的无关既有警告未扩范围修改。 |

最终验证：`npm test` 通过 **309 条单测 + 34 条 feature 测试**；类型检查、build、lint、keymap-docs 均退出 0。lint 仅有 5 条未触碰文件的存量警告，本次新增文件无警告。真实 PTY 的 submit / cancel 两条链路均通过。

## 真机视觉

`capture.py` 启动专用 Ghostty 实例，使用当前构建的 `dist/bin.js`、隔离 HOME/数据根和本机 mock 模型；无真实 API 凭据、模型费用或用户会话修改。截图均由 `screencapture -l` 捕获窗口，不是浏览器或重绘画面。

- `dark-100-question.png` / `dark-60-question.png`
- `light-100-question.png` / `light-60-question.png`
- `dark-100-submit.png`：多题回答后的提交页。
- `*.keys.txt`：实际输入事件、当前题/焦点迁移、`stty size`；四图列宽为实测 100/60，行数 36。Ghostty 本机窗口宽度参数比实际列数少 2，脚本已校准。
- `*.screen.txt`：对应真实应用渲染文本，宽屏深色记录末态提交页。

由于当前 macOS 的 System Events 粘贴没有稳定到达应用，`drive.mjs` 在隔离测试进程内向实际终端输入解析器注入原始字节，并记录事件和屏幕；不注入问卷状态，不替换业务处理和渲染。截图本身仍来自真实 Ghostty。

## 真实工具链路

`interaction.mjs` 用 PTY 自动化驱动真实官方宿主，调用本地 SSE 模型；不是视觉验收替代品。

- `submit.terminal.txt`：数字选择第二项 → 多选空格 → Enter 到提交页 → Enter 整体提交；模型收到完整答案。
- `cancel.terminal.txt`：Esc 取消；模型收到 `is_error:true` 与 `ask_user_question was aborted before the user answered`，没有空答案数组。
- mock 工具参数使用官方的 `multi_select`，经官方工具转换成事件的 `multiSelect`，避免把实际单选错当多选验收。

复现（仓库根目录，先安装依赖；真机截图需要 macOS 屏幕录制和辅助功能权限）：

```sh
npm run build
node docs/evidence/2026-11-01-nano-question-card-parity/interaction.mjs
python3 docs/evidence/2026-11-01-nano-question-card-parity/capture.py
```

## 范围与限制

- 不接倒计时/askTimed，不改审批视觉，不新增计划审阅专用版式，不重做只读回看或跨窗口回填。
- `src/input/parser.ts` 的单处 Shift+Tab 适配是 A6 真实终端回看所必需：此前 CSI Z 丢失 Shift 标志。
- 本次没有发版、没有自动合并、没有关闭 issue；实施成果待用户选审核档并单独确认合并。
- 仓库未声明且不存在 `scripts/check-docs.sh` / `scripts/check-doc-links.sh`：文档检查无入口；已执行键位文档检查及 diff 空白检查。
