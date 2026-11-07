# B3 /plan：五阶段调研与 exit_plan_mode 交审

- 日期：2026-11-07；环境：Node 24.18.0、nano 0.2.4、官方 dsh 0.2.2-rc.1。
- 模型：真实 `deepseek-official/deepseek-flash`，reasoning effort `max`；不是 mock，也不是另写提示的模拟会话。
- 采集：真实 nano TUI + 自动化 PTY（控制终端 120×48）；独立数据根与凭据临时副本，不改真实 profile / 会话。
- Session：`research-b3`；源压缩会话日志 SHA-256：`4d0d1d37791283fc7ec3eeaebeac9804ca2ed7386df20245c93b096f8cda17a6`。
- 记录口径：用户固定输入、assistant 可见正文与工具调用参数按原文保存；不收录系统提示、注入上下文与模型思考。除 B2 外，工具返回正文不重复抄源码，只列真实返回状态及内容散列；本机路径用占位符替换。
- 实施基线：`3d29687` + 本 PR 的三个代码 / 测试文件；不含另一个模型的改写或人工补写回复。

## 用户输入

```text
/plan
给 nano 的会话列表增加按会话标题关键词筛选的功能，跨列表状态与界面等多个文件。请完成计划，先不要实施。
```

首轮在 300 秒测试时限内仍在只读调研，驱动用 Ctrl+C 中断；保留同一个会话恢复，未改变系统提示、模型与任务范围。恢复后用户输入：

```text
继续完成刚才的计划，不要实施。
```

最终审核卡出现后，测试驱动只采集、不替用户批准，用 Ctrl+C 退出；后续 abort 是驱动清理，不是模型实施。

## 判定：通过

- /plan 已激活；先进行独立读取 / 搜索，设计取舍与关键文件复核后形成完整计划，最后仅由 exit_plan_mode 提交。
- 最后一次模型 step：turn 2 / step 2，只有 `exit_plan_mode` 一次工具调用（seq 302），并显示真实 Plan review 卡。
- 所有 tracked 文件散列与 git status 保持不变；没有 write / edit / apply_patch / todo_write 调用，也没有替用户批准计划。

## Assistant 可见正文（按 seq 排序）

本会话无独立可见正文；完整计划只通过末尾的 exit_plan_mode 参数提交，未伪造普通文本回复。

## 最终计划（exit_plan_mode.plan 原文）

```markdown
# 会话列表按标题关键词筛选（实施计划）

## 目标与成功标准

- 在 `Ctrl+L` 打开的会话面板（`SessionsPanel`）里，按 `/` 进入标题筛选，输入字符即时过滤列表。
- 只改变可见行；不改官方会话身份、官方排序、切换/改名/受控重启路径。
- 无筛选时，`a`、`r`、`↑↓`、`Enter`、`Esc` 的既有行为逐字不变。
- 成功标准：新增用例覆盖输入、回退、提交、跨刷新、目录切换、空态、无标题；`npm test`、`npm run typecheck`、`npm run lint` 全绿。

## 交互契约（定稿）

| 输入 / 状态 | 行为 |
| --- | --- |
| `/`（非输入态） | 进入筛选输入；保留已有查询，便于继续收窄 |
| 可打印字符 | 追加到查询，列表实时按标题过滤 |
| `Backspace` | 删除查询最后一个字符 |
| `Enter`（输入中） | 提交筛选、退出输入态，留在面板；**不切换会话** |
| `Enter`（非输入态） | 切换选中的匹配行（原行为） |
| `Esc`（输入中） | 清空查询并退出输入态，面板不关 |
| `Esc`（已提交且有筛选） | 清空筛选，面板不关 |
| `Esc`（无筛选） | 关闭面板（原行为） |
| `↑↓` / `r` / `a` | 只作用于筛选后的列表；`a` 切目录时保留筛选 |

匹配规则：

- 大小写不敏感的子串匹配；查询 `trim()` 后为空视为无筛选。
- 匹配“列表显示标题”：`row.title`；标题为空时回退 `row.id`（与现有渲染一致，见 `list.ts:216`）。
- 过滤保持官方列表顺序，不重排、不按相关度评分；不新增 `sessionQuery` 调用，不 debounce。
- 查询在面板生命周期内保留：`refresh()`、`a` 切目录、关闭再打开都保留；进程重启/切换会话后自然丢失，不落盘。

## 改动面

### 1. `src/sessions/filters.ts`（纯函数，约 21 行后新增）

复用现有“会话视图”文件，不新建模块：

- `SessionTitleView { id, title }`
- `sessionDisplayTitle(row)`：`title !== '' ? title : id`
- `filterSessionsByTitle<T extends SessionTitleView>(rows, query): T[]`：`trim + toLowerCase` 后 `includes`；空查询返回 `[...rows]`

不改 `continueCandidates`、`isTopLevelSession`、`sortNewestFirst`。

### 2. `src/sessions/list.ts`（状态 + 界面）

- `SessionRow extends SessionTitleView`（`:12`），保留现有 `cwd/createdAt/current` 字段。
- 新增状态（`:32-45` 附近）：`titleFilter = ''`、`filterEditing = false`、`filteredRows: SessionRow[] = []`。
- 新增私有 helper：`filterActive`、`isPrintable(key)`、`dropLastChar(text)`、`setTitleFilter(next)`、`rebuildFiltered(resetSelection)`、`headerText(width)`。
- `toggle()`（`:51`）/`hide()`（`:57`）：退出输入态；已提交的查询保留。
- `refresh()`（`:63`）：`this.rows = rows` 后调用 `rebuildFiltered(false)`；`selected` 改为按 `filteredRows.length` 夹取；筛选状态跨刷新保留。
- `handleKey()`（`:112`）：在 `renaming` 分支之后插入 `filterEditing` 分支；未处理按键吞掉，但 `Ctrl+C`/`Ctrl+D` 放行（沿用 `ModelPanel` 的退出键处理，`model-panel.ts:321-324`）。
- **选择行取值全部从 `this.rows` 换成 `this.filteredRows`**，共四处：重命名输入中的 Enter（`:121`）、`r` 进入改名（`:162`）、Enter 切换（`:171`）、↑↓ 边界（`:145-154`）。
- `render()`（`:192`）：
  - 行列表改用 `this.filteredRows`；`recoverable` 仍用 `this.rows`，区分“无会话”和“筛选无匹配”。
  - 新增筛选行：输入中用 `reverse`，已提交用 `dim`；用 `truncateText` + `wrap:false` 保证一行。
  - 行数预算：`Math.max(1, height - (筛选行可见 ? 5 : 4))`。
  - 复用 `sessionDisplayTitle` 替换现有标题回退；`formatTime` 不动。
- 复用 `src/render/text.ts` 的 `truncateText`、`displayWidth`。

**文案（定稿）**：

- 普通头部：`会话 · ↑↓ 选择 · Enter 切换（重启） · / 筛选 · a 全部目录 · r 改名 · Esc 关闭`（80 列终端内容宽 78，此串宽 77，不换行）
- 紧凑头部（可用宽度不足 77 时）：去掉 `（重启）`，其余不变
- 筛选输入态头部：`会话 · 筛选：输入标题关键词 · Enter 完成 · Esc 清除`
- 输入态筛选行：`  筛选：<query> · 匹配 n/m`
- 已提交筛选行：`  筛选「<query>」 · 匹配 n/m · / 修改 · Esc 清除`
- 无匹配行：`  没有匹配「<query>」的会话`
- 无会话空态保持原文：`没有可恢复的会话；直接在新会话里开始，或按 a 看全部目录`

### 3. `tests/unit/sessions-panel.test.ts`

- 扩展 `fakeCtx(records, titles?)`（`:24-34`），允许指定标题（含空标题）；`makePanel` 透传。
- 新增 `key(text)` 小 helper；导入 `filterSessionsByTitle`、`sessionDisplayTitle`。
- 新增用例见下。

### 不改的文件

- `src/controls/feature-host.ts`、`src/controls/feature-keys.ts`：面板已在 `handleKey` 链里；`/` 是面板局部键，不进全局 keymap。
- `README.md` / `README.en.md` / `--help`：面板内按键沿用 `a`/`r` 的既有做法，只在面板头部提示。
- `docs/specs/` 旧 spec：冻结记录，不回写；本功能不新增 ADR（局部交互，无跨模块长期契约）。
- 无 schema、无持久化、无新依赖。

## 状态流

1. 打开/`Ctrl+L` → `refresh()` 读取 cwd 内顶层会话 → `rows` → `rebuildFiltered()`。
2. `/` → `filterEditing = true`；每个字符 → `setTitleFilter()` → 重算 `filteredRows` 且 `selected = 0`。
3. `Enter` → 退出输入态；`Esc` → 按上述层级清空/关闭。
4. `↑↓`/`r`/`Enter`/`a` 全部基于 `filteredRows`；`a` 触发 `refresh()` 后仍按当前查询过滤。
5. 切换仍把选中行的 `id` 交给 `onSwitch`，受控重启路径不变。

## 边界与失败模式

- 空白查询：不过滤；提交时把纯空白查询归一成 `''`，避免“看不见的筛选”。
- 无标题会话：按列表显示的 id 参与匹配。
- 无匹配：显示专门空态，不误用“没有可恢复的会话”；`Enter`/`r` 无操作、不抛错。
- 无会话：即使有查询也显示原空态（没有东西可筛）。
- 标题读取失败/`sessionQuery` 不可用：沿用现有 `notice` 与空行行为；筛选函数对空数组安全。
- 窄终端/长查询：筛选行截断为一行；头部按宽度在完整/紧凑文案间二选一，避免挤占行预算。
- 输入中方向键不移动选择（避免误触），提交后再导航；`Ctrl+C`/`Ctrl+D` 不被面板吞掉。
- 关闭面板时只退出输入态，已输入查询保留；重新打开可见同一筛选。

## 测试用例（`tests/unit/sessions-panel.test.ts`）

1. **输入即过滤、大小写不敏感、Enter 只提交不切换**：`/` + `alpha` → 只剩匹配行；渲染含 `匹配 2/4`；Enter 后 `onSwitch` 未调用；↓ + Enter 才切换。
2. **Esc 分层**：输入中 Esc 清空并退出输入；已提交 Esc 清空筛选但不关面板；再无筛选 Esc 关闭。
3. **输入态不触发快捷键**：输入 `a`/`r` 只进入查询，不切全部目录、不进入改名；退出输入后 `a` 仍能切目录。
4. **筛选跨 `refresh()` 与 `a` 切换保持**：刷新、切全部目录后查询仍在，且对新行集重新过滤；选择序号被夹到匹配数内。
5. **两种空态分开**：有会话但无匹配 → 显示“没有匹配…”；完全没有可恢复会话 → 仍显示原空态。
6. **无标题会话按显示 id 匹配**：`title === ''` 时可用 id 片段筛到。
7. **纯函数**：`filterSessionsByTitle` 的 trim、大小写、空查询、无匹配；`sessionDisplayTitle` 回退；头部提示在 80 列含 `/ 筛选`。

## 验收与验证

- 快速回路：`npx vitest run tests/unit/sessions-panel.test.ts`
- 全量：`npm test`
- 类型：`npm run typecheck`
- 风格：`npm run lint`
- 可选（本机有 PTY 时）：`npm run test:e2e`，确认 `tests/e2e/session-lifecycle.test.mjs:361-364` 的 `会话 · `、`a 全部目录`、空态文案仍匹配；本计划不修改 e2e 文件。
- 手工冒烟：`Ctrl+L` → `/` → 输入标题片段 → `Enter` 完成 → `↓` + `Enter` 切换 → 再开面板确认筛选保留。

## 假设与前置

- **工作区**：当前 `.worktrees/issue-174` 有未提交的 #174 改动（`src/conversation/controller.ts`、`src/sessions/boot-patches.ts`、`tests/unit/conversation-delivery.test.ts`、未跟踪 evidence）。实施前应从 `origin/main` 另开 worktree/分支（如 `feature/session-title-filter`），不要把 #174 改动混进本功能 diff。
- **流程**：按仓库 `AGENTS.md`，这是新需求；若走 spec-flow，正式实施前需先落 spec/issue，本计划只覆盖实施、不改旧 spec 正文。
- **键位**：选 `/`（终端搜索惯例，面板内未占用）；若坚持单字母风格可改 `f`，只需改 `handleKey` 判定与头部文案，其余不变。
- **不改身份**：筛选只作用于显示层，不按标题推断会话身份（沿用 `S02` 与 `ADR` 的既有约束）。
```

## 工具事件全量索引

<details>
<summary>展开全部调用参数与真实返回状态</summary>

### seq 23 · turn 1 / step 1 · bash

```json
{"description": "Show repo status and branch info", "command": "git status -sb && echo '---' && git log --oneline -5 && echo '---' && ls -la"}
```

返回 seq 26：`isError=false`；content SHA-256：`ce17744cd582d24f0e3643083d5e273098aa7f9371118ed1bd12f301c5588ff7`。

### seq 27 · turn 1 / step 1 · glob

```json
{"pattern": "**/*sess*"}
```

返回 seq 28：`isError=false`；content SHA-256：`8b96e756f965f1ad6b9222700249aa8c290aab4932188cd373261f5e01123850`。

### seq 33 · turn 1 / step 2 · bash

```json
{"command": "ls -1 src && echo '--- sessions' && ls -1 src/sessions && echo '--- ui?' && ls -1 src/ui 2>/dev/null; echo '--- diff stat' && git diff --stat", "description": "List source layout and diff stat"}
```

返回 seq 36：`isError=false`；content SHA-256：`0b9484913755f6ce719dacddaf16fd4ac372a477f49f179d767d62564137edab`。

### seq 37 · turn 1 / step 2 · grep

```json
{"pattern": "session(s)?[Pp]anel|sessions-panel|SessionList|session-list|sessionList", "path": "src"}
```

返回 seq 38：`isError=false`；content SHA-256：`57fa2ad60630c5171ea5b459b9d01a9dade6c2dd56cc3fc9a5833db2fb790ed2`。

### seq 43 · turn 1 / step 3 · read

```json
{"file_path": "src/sessions/filters.ts"}
```

返回 seq 45：`isError=false`；content SHA-256：`f1b693886e29eff8122e8a774b0d00c93cfc8d8d16c7f9783d9aa37b5fc6fe8b`。

### seq 44 · turn 1 / step 3 · read

```json
{"file_path": "src/sessions/list.ts"}
```

返回 seq 46：`isError=false`；content SHA-256：`64171bed8f5a372911ffc89c122a4b6a0cd10a408d7d19933091ffd702fa7240`。

### seq 51 · turn 1 / step 4 · bash

```json
{"command": "gh issue view 174 --json number,title,state,body,labels,comments 2>&1 | head -c 12000", "description": "Read issue 174 details"}
```

返回 seq 54：`isError=false`；content SHA-256：`dfcd7b56d9e6c856df5db48269d41f3eae896763cebcb26c1793c1490e064971`。

### seq 55 · turn 1 / step 4 · grep

```json
{"pattern": "SessionsPanel|sessionsPanel", "path": "src"}
```

返回 seq 56：`isError=false`；content SHA-256：`9fd1e611d7559e8b22bec4dede693709abf7459195c8492e548a272a23fd290a`。

### seq 57 · turn 1 / step 4 · read

```json
{"file_path": "tests/unit/sessions-panel.test.ts"}
```

返回 seq 58：`isError=false`；content SHA-256：`19e6394a2ede1d361310165d057bad7484b0740970ff1efdb061044dc8a58a9f`。

### seq 63 · turn 1 / step 5 · read

```json
{"file_path": "src/controls/feature-host.ts", "offset": 1, "limit": 140}
```

返回 seq 64：`isError=false`；content SHA-256：`6a76ae0c128b17e3943aefa7896f2c98cdd64d5a1ce8fc12e06558b58bb23f9d`。

### seq 65 · turn 1 / step 5 · grep

```json
{"pattern": "filter|搜索|筛选|search|keyword", "path": "src"}
```

返回 seq 66：`isError=false`；content SHA-256：`4d68a36a8647f76d49e39cc9b531659a739ac27ccc1f1f683c817c816fb2b55a`。

### seq 67 · turn 1 / step 5 · bash

```json
{"command": "ls -1 docs/specs && echo '---' && ls -1 docs/specs/2026-10-28-nano-ts", "description": "List spec directories"}
```

返回 seq 70：`isError=false`；content SHA-256：`2038c39add01bd23713868d02865cb5d3c8141d8044a883b9203fee59e89eafb`。

### seq 75 · turn 1 / step 6 · grep

```json
{"path": "src/controls/feature-host.ts", "pattern": "sessions|handleKey|render\\(|onChange"}
```

返回 seq 76：`isError=false`；content SHA-256：`60459b772344593fcda638075e6e46b5c90291734bc4dc894b488a8efb7f5e3c`。

### seq 77 · turn 1 / step 6 · bash

```json
{"command": "grep -n \"会话列表\\|筛选\\|搜索\\|filter\\|关键字\\|关键词\" -r docs/specs/2026-10-28-nano-ts/S02-input-sessions-terminal.md docs/specs/2026-10-20-nano-v1/S07-sessions-context.md | head -50", "description": "Search specs for session list filtering"}
```

返回 seq 80：`isError=false`；content SHA-256：`0f80632cdb9cc3fbd3441da8d9946d88ab65caf738ebfe4170acb614f56198b6`。

### seq 81 · turn 1 / step 6 · read

```json
{"file_path": "src/input/parser.ts"}
```

返回 seq 82：`isError=false`；content SHA-256：`c1519ec1f8ae2d786b2750990cc6640d66d694160260b8b159f5d66cccb29b14`。

### seq 87 · turn 1 / step 7 · bash

```json
{"command": "ls -1 src/input src/controls src/render", "description": "List input, controls, render modules"}
```

返回 seq 90：`isError=false`；content SHA-256：`9a123e21cf3206d55f4c0182c61bd29441390a1a45adbaab618d53a35619c47a`。

### seq 91 · turn 1 / step 7 · read

```json
{"file_path": "src/controls/model-panel.ts"}
```

返回 seq 92：`isError=false`；content SHA-256：`edc02df59b3adc0da8f662f6a3c5ea14c74af51c79ce76d2c654945c2bcbd094`。

### seq 97 · turn 1 / step 8 · read

```json
{"file_path": "src/controls/feature-host.ts", "offset": 140, "limit": 220}
```

返回 seq 99：`isError=false`；content SHA-256：`367e76d663d2b4d8649ca8b4f25eb16013dd3ce0119b803eb46b485f0a7d1d4d`。

### seq 98 · turn 1 / step 8 · read

```json
{"file_path": "src/input/segments.ts"}
```

返回 seq 100：`isError=false`；content SHA-256：`84ac2880e88d76ee45e949c0bbca23ecf22a1adc37509234e3333d1a8847ec3e`。

### seq 101 · turn 1 / step 8 · bash

```json
{"command": "grep -n \"handleKey\\|key.name === 'char'\\|backspace\\|private \\(query\\|filter\\)\" src/jobs/panel.ts src/controls/info-panel.ts src/subagents/view.ts | head -60", "description": "Inspect char-key handling in other panels"}
```

返回 seq 104：`isError=false`；content SHA-256：`a806c4d38bea77bf3fafccf7c67fd9eb2bf59e19945f7046528b090b11b30f6a`。

### seq 109 · turn 1 / step 9 · bash

```json
{"command": "gh issue list --state open --limit 30 --json number,title,labels 2>&1 | head -c 6000; echo '--- branches'; git branch -a --sort=-committerdate | head -20", "description": "List open issues and branches"}
```

返回 seq 112：`isError=false`；content SHA-256：`ec2d22f3358592e069217e6bf36e0afe67821cee37400657cda7052090f60a43`。

### seq 113 · turn 1 / step 9 · read

```json
{"file_path": "docs/specs/2026-10-28-nano-ts/S02-input-sessions-terminal.md"}
```

返回 seq 114：`isError=false`；content SHA-256：`5b7a58e0e4284af6431291be627e0dcfd92778d4bff9c4b2fedec566266deec4`。

### seq 115 · turn 1 / step 9 · bash

```json
{"command": "cat package.json && echo '--- vitest'; cat vitest.config.ts && echo '--- tsconfig'; cat tsconfig.json", "description": "Read project scripts and config"}
```

返回 seq 118：`isError=false`；content SHA-256：`93b297848c07c4399b5e740e26ca79ba343e4b0a4e65c29803d88a5cc0f0443a`。

### seq 123 · turn 1 / step 10 · bash

```json
{"command": "grep -rn \"会话 ·\\|Ctrl+L\\|Ctrl+l\\|r 改名\\|a 全部目录\\|会话列表\" README.md README.en.md docs tests src --include='*.md' --include='*.ts' --include='*.mjs' 2>/dev/null | grep -v node_modules | head -60", "description": "Find docs and tests mentioning session panel keys"}
```

返回 seq 126：`isError=false`；content SHA-256：`9137cbd15181bda2cd3b63a597b55c22446e09a48acaab84fa0d0ba5441ab72c`。

### seq 127 · turn 1 / step 10 · read

```json
{"file_path": "src/jobs/panel.ts", "offset": 100, "limit": 120}
```

返回 seq 128：`isError=false`；content SHA-256：`35d62170e727589a720727b5aec3c37eee42a355ca81f80fc0f66f751a00cd25`。

### seq 133 · turn 1 / step 11 · read

```json
{"file_path": "tests/e2e/session-lifecycle.test.mjs", "limit": 80, "offset": 320}
```

返回 seq 134：`isError=false`；content SHA-256：`fb360adf98d8bfdc9c2cb38c7c5996c0a314ed79018b45d776a8df894eab124d`。

### seq 135 · turn 1 / step 11 · bash

```json
{"command": "sed -n '95,135p' README.md; echo '--- feature tests'; cat tests/feature/vitest.config.ts; ls -1 tests/feature tests/unit | head -80", "description": "Read README key table and test layout"}
```

返回 seq 138：`isError=false`；content SHA-256：`11c967bc76b1d5871ba923d419cc3bb28b3bc7c6bf8c372d96fb3f28f735f7b9`。

### seq 143 · turn 1 / step 12 · read

```json
{"file_path": "docs/decisions/README.md"}
```

返回 seq 144：`isError=false`；content SHA-256：`0dc76955db5d2b4e3661102cd4a3df73191441333175233794a7825936cf241a`。

### seq 145 · turn 1 / step 12 · bash

```json
{"command": "ls -1 docs/decisions; echo '--- grep filter/search in decisions and lifecycle spec'; grep -n \"筛选\\|搜索\\|filter\\|标题\\|键位\\|按键\" docs/specs/2026-11-02-nano-session-lifecycle/README.md docs/decisions/*.md | head -40", "description": "Inspect ADR rules and session lifecycle decisions"}
```

返回 seq 148：`isError=false`；content SHA-256：`fa74043eea59e6f3361b0ed47f47f3d3aa84012ca98800d54ce5d6953bb9d18a`。

### seq 153 · turn 1 / step 13 · read

```json
{"file_path": "docs/specs/2026-11-02-nano-session-lifecycle/README.md", "offset": 100, "limit": 70}
```

返回 seq 154：`isError=false`；content SHA-256：`ca2a5953570ce4cacb11a3be0907489a337b778030a8b53ef38379db7fdb1274`。

### seq 159 · turn 1 / step 14 · bash

```json
{"command": "grep -n \"export function Text\\|export function Box\\|interface TextProps\\|interface BoxProps\\|reverse\\|dim\" src/render/components.ts | head -40; echo '--- width helpers'; grep -n \"export function\" src/render/text.ts | head -30", "description": "Inspect render component props and text helpers"}
```

返回 seq 162：`isError=false`；content SHA-256：`0e53ba8c625725d32f67a86ae515fe5c74e9cceba04f3ccf12289448fb5dd774`。

### seq 163 · turn 1 / step 14 · bash

```json
{"command": "grep -rn \"reverse: true.*输入\\|输入：\\|query\\|cursor\" src/controls/*.ts src/subagents/*.ts | head -40", "description": "Find existing text-input cursor rendering patterns"}
```

返回 seq 166：`isError=false`；content SHA-256：`ff78fa2a9fda4054505457509a1641a2cd039a63f7829b7032d02b5d48645b0c`。

### seq 171 · turn 1 / step 15 · read

```json
{"file_path": "src/render/components.ts"}
```

返回 seq 172：`isError=false`；content SHA-256：`2d47ac06cb61004ebb8ecb0c2b3ab3beb03580e8467714f6e4f5bc7313fef22c`。

### seq 173 · turn 1 / step 15 · bash

```json
{"command": "grep -rn \"interface PressableTextProps\\|interface PressableBoxProps\\|reverse\" src/render/*.ts | head -30", "description": "Find Text/Box prop definitions"}
```

返回 seq 176：`isError=false`；content SHA-256：`07a128e00ec6a4e43d9f5dcddb27ed7cc08b48f93f21b8b4cfdb13195f4c383a`。

### seq 181 · turn 1 / step 16 · read

```json
{"file_path": "src/render/host.ts", "limit": 80, "offset": 30}
```

返回 seq 182：`isError=false`；content SHA-256：`64ae60d5fbca3f5022740a176b555f496d441adf7c353c9ee1ac05d25dcb642b`。

### seq 187 · turn 1 / step 17 · bash

```json
{"command": "grep -n \"wrap\" src/render/host.ts | head -20; echo '--- truncate signature'; sed -n '284,302p' src/render/text.ts", "description": "Check wrap handling and truncate helper"}
```

返回 seq 190：`isError=false`；content SHA-256：`c3ce29ae5b9d2a3b85b3a0570fd102b8cca37a976552f1048cb410138cf42d31`。

### seq 195 · turn 1 / step 18 · bash

```json
{"command": "grep -rn \"SessionRow\\|from './list.ts'\\|sessions/list.ts\" src tests | grep -v node_modules", "description": "Find SessionRow consumers"}
```

返回 seq 198：`isError=false`；content SHA-256：`87126049d2f570e9a30b0085c54ac1f018025216bc346e1fbddd90f53df8fbbe`。

### seq 199 · turn 1 / step 18 · bash

```json
{"command": "grep -rn \"textOf\\|render(\" tests/unit/*panel*.test.ts tests/unit/model-panel.test.ts | head -30; echo '--- info panel test'; sed -n '1,80p' tests/unit/features-input-active.test.ts", "description": "Review panel test rendering patterns"}
```

返回 seq 202：`isError=false`；content SHA-256：`ce66191b622aea3b38320a6f5b05f8fad822fe100737a16b5d8638735e9a58ce`。

### seq 207 · turn 1 / step 19 · bash

```json
{"command": "npx vitest run tests/unit/sessions-panel.test.ts 2>&1 | tail -20 && echo '=== typecheck' && npm run typecheck 2>&1 | tail -20", "description": "Run baseline panel test and typecheck", "timeoutMs": 180000}
```

返回 seq 210：`isError=false`；content SHA-256：`58a5b0c895ecd270be92c0c5284183213a21c38f16058875a38c4a98fafca48c`。

### seq 215 · turn 1 / step 20 · bash

```json
{"command": "git diff -- src/sessions/boot-patches.ts src/conversation/controller.ts tests/unit/conversation-delivery.test.ts | head -120", "description": "Inspect uncommitted worktree changes"}
```

返回 seq 218：`isError=false`；content SHA-256：`ff35051150574bcf81b86b94c92725f709b637a2dee7def329f2c814c9040c14`。

### seq 223 · turn 1 / step 21 · skill

```json
{"name": "spec-flow"}
```

返回 seq 224：`isError=false`；content SHA-256：`35caa50cff07a485f314f5c0a95bc19839e800b3ca9fb7ef1e52cc98effc9661`。

### seq 229 · turn 1 / step 22 · bash

```json
{"command": "grep -rn \"关键词\\|关键字\\|按标题\\|筛选会话\\|会话筛选\\|搜索会话\\|filter.*session\\|session.*filter\" docs README.md README.en.md 2>/dev/null | head -40", "description": "Search docs for existing title-filter requirement"}
```

返回 seq 232：`isError=false`；content SHA-256：`068f9adfc9e7beb2cb006a49d4d6e05ead8a8553d49271e066b926db8181e159`。

### seq 237 · turn 1 / step 23 · bash

```json
{"command": "sed -n '1,70p' src/render/text.ts", "description": "Inspect width overrides for symbols"}
```

返回 seq 240：`isError=false`；content SHA-256：`2543d26a2084ff3cb74f825b27128ab48c1e408fbdb297212a290257624ec85e`。

### seq 245 · turn 1 / step 24 · read

```json
{"file_path": "src/controls/feature-host.ts", "limit": 80, "offset": 640}
```

返回 seq 246：`isError=false`；content SHA-256：`b24c068898fe1fe932e9bf0cf6a898899cd5472de02ea7f94b8ff7ff5b4aa881`。

### seq 251 · turn 1 / step 25 · bash

```json
{"command": "node -e \"const sw=require('string-width'); const a='会话 · ↑↓ 选择 · Enter 切换（受控重启） · a 全部目录 · r 改名 · Esc 关闭'; const b='会话 · ↑↓ 选择 · Enter 切换（受控重启） · / 筛选 · a 全部目录 · r 改名 · Esc 关闭'; const c='会话 · ↑↓ 选择 · Enter 切换（受控重启） · / 筛选 · a 全部目录 · r 改名 · Esc 清除筛选'; const d='会话 · 筛选：输入标题关键词 · Enter 完成 · Esc 清除'; for (const [k,v] of Object.entries({a,b,c,d})) console.log(k, sw(v), v)\"", "description": "Measure header display widths"}
```

返回 seq 254：`isError=false`；content SHA-256：`9f19966295f764d10883b75ff64077305620efaab79665d6ed385eec4bef80da`。

### seq 259 · turn 1 / step 26 · bash

```json
{"command": "node --input-type=module -e \"import sw from 'string-width'; const a='会话 · ↑↓ 选择 · Enter 切换（受控重启） · a 全部目录 · r 改名 · Esc 关闭'; const b='会话 · ↑↓ 选择 · Enter 切换（受控重启） · / 筛选 · a 全部目录 · r 改名 · Esc 关闭'; const c='会话 · ↑↓ 选择 · Enter 切换（受控重启） · / 筛选 · a 全部目录 · r 改名 · Esc 清除筛选'; const d='会话 · 筛选：输入标题关键词 · Enter 完成 · Esc 清除'; const e='  筛选：alpha · 匹配 2/4 · Enter 完成 · Esc 清除'; const f='  筛选「alpha」 · 匹配 2/4 · / 修改 · Esc 清除'; for (const [k,v] of Object.entries({a,b,c,d,e,f})) console.log(k, sw(v))\"", "description": "Measure header and filter line widths"}
```

返回 seq 262：`isError=false`；content SHA-256：`a07028a42505ad2fc6f3c40817a33fd92de197fbede526c789c9f4a36c069d78`。

### seq 267 · turn 1 / step 27 · bash

```json
{"command": "grep -n \"innerWidth\\|innerHeight\" -A6 src/controls/feature-host.ts | sed -n '1,40p'; grep -n \"bodyHeight\\|innerWidth\" -A4 src/controls/feature-host.ts | tail -30", "description": "Check panel width calculation"}
```

返回 seq 270：`isError=false`；content SHA-256：`fdc3fb2a61511c05fb4f087614cc6b43ba20cbeb8aa9638636dec10474717dfb`。

### seq 275 · turn 1 / step 28 · bash

```json
{"command": "node --input-type=module -e \"import sw from 'string-width'; const variants={orig:'会话 · ↑↓ 选择 · Enter 切换（受控重启） · a 全部目录 · r 改名 · Esc 关闭', plus:'会话 · ↑↓ 选择 · Enter 切换（受控重启） · / 筛选 · a 全部目录 · r 改名 · Esc 关闭', short:'会话 · ↑↓ 选择 · Enter 切换（重启） · / 筛选 · a 全部目录 · r 改名 · Esc 关闭', shortEsc:'会话 · ↑↓ 选择 · Enter 切换（重启） · / 筛选 · a 全部目录 · r 改名 · Esc 清除筛选', noRestart:'会话 · ↑↓ 选择 · Enter 切换 · / 筛选 · a 全部目录 · r 改名 · Esc 关闭', noRestartEsc:'会话 · ↑↓ 选择 · Enter 切换 · / 筛选 · a 全部目录 · r 改名 · Esc 清除筛选', edit:'会话 · 筛选：输入标题关键词 · Enter 完成 · Esc 清除', compact:'会话 · ↑↓ · Enter 切换 · / 筛选 · a 目录 · r 改名 · Esc 关闭'}; for (const [k,v] of Object.entries(variants)) console.log(k, sw(v))\"", "description": "Measure compact header variants"}
```

返回 seq 278：`isError=false`；content SHA-256：`f513b88e61d9aa08072b32eaa5123e32e0df444c33b4aba91df8cfa56c7ff3c2`。

### seq 294 · turn 2 / step 1 · bash

```json
{"command": "npx biome check src/sessions tests/unit/sessions-panel.test.ts 2>&1 | tail -15; echo '=== status'; git status -sb", "description": "Check lint baseline for touched files", "timeoutMs": 120000}
```

返回 seq 297：`isError=false`；content SHA-256：`4c39165a144537061ee4280f76e8f8c949a1a85badeae7f570691734db8da2a5`。

### seq 302 · turn 2 / step 2 · exit_plan_mode

```json
{"plan": "# 会话列表按标题关键词筛选（实施计划）\n\n## 目标与成功标准\n\n- 在 `Ctrl+L` 打开的会话面板（`SessionsPanel`）里，按 `/` 进入标题筛选，输入字符即时过滤列表。\n- 只改变可见行；不改官方会话身份、官方排序、切换/改名/受控重启路径。\n- 无筛选时，`a`、`r`、`↑↓`、`Enter`、`Esc` 的既有行为逐字不变。\n- 成功标准：新增用例覆盖输入、回退、提交、跨刷新、目录切换、空态、无标题；`npm test`、`npm run typecheck`、`npm run lint` 全绿。\n\n## 交互契约（定稿）\n\n| 输入 / 状态 | 行为 |\n| --- | --- |\n| `/`（非输入态） | 进入筛选输入；保留已有查询，便于继续收窄 |\n| 可打印字符 | 追加到查询，列表实时按标题过滤 |\n| `Backspace` | 删除查询最后一个字符 |\n| `Enter`（输入中） | 提交筛选、退出输入态，留在面板；**不切换会话** |\n| `Enter`（非输入态） | 切换选中的匹配行（原行为） |\n| `Esc`（输入中） | 清空查询并退出输入态，面板不关 |\n| `Esc`（已提交且有筛选） | 清空筛选，面板不关 |\n| `Esc`（无筛选） | 关闭面板（原行为） |\n| `↑↓` / `r` / `a` | 只作用于筛选后的列表；`a` 切目录时保留筛选 |\n\n匹配规则：\n\n- 大小写不敏感的子串匹配；查询 `trim()` 后为空视为无筛选。\n- 匹配“列表显示标题”：`row.title`；标题为空时回退 `row.id`（与现有渲染一致，见 `list.ts:216`）。\n- 过滤保持官方列表顺序，不重排、不按相关度评分；不新增 `sessionQuery` 调用，不 debounce。\n- 查询在面板生命周期内保留：`refresh()`、`a` 切目录、关闭再打开都保留；进程重启/切换会话后自然丢失，不落盘。\n\n## 改动面\n\n### 1. `src/sessions/filters.ts`（纯函数，约 21 行后新增）\n\n复用现有“会话视图”文件，不新建模块：\n\n- `SessionTitleView { id, title }`\n- `sessionDisplayTitle(row)`：`title !== '' ? title : id`\n- `filterSessionsByTitle<T extends SessionTitleView>(rows, query): T[]`：`trim + toLowerCase` 后 `includes`；空查询返回 `[...rows]`\n\n不改 `continueCandidates`、`isTopLevelSession`、`sortNewestFirst`。\n\n### 2. `src/sessions/list.ts`（状态 + 界面）\n\n- `SessionRow extends SessionTitleView`（`:12`），保留现有 `cwd/createdAt/current` 字段。\n- 新增状态（`:32-45` 附近）：`titleFilter = ''`、`filterEditing = false`、`filteredRows: SessionRow[] = []`。\n- 新增私有 helper：`filterActive`、`isPrintable(key)`、`dropLastChar(text)`、`setTitleFilter(next)`、`rebuildFiltered(resetSelection)`、`headerText(width)`。\n- `toggle()`（`:51`）/`hide()`（`:57`）：退出输入态；已提交的查询保留。\n- `refresh()`（`:63`）：`this.rows = rows` 后调用 `rebuildFiltered(false)`；`selected` 改为按 `filteredRows.length` 夹取；筛选状态跨刷新保留。\n- `handleKey()`（`:112`）：在 `renaming` 分支之后插入 `filterEditing` 分支；未处理按键吞掉，但 `Ctrl+C`/`Ctrl+D` 放行（沿用 `ModelPanel` 的退出键处理，`model-panel.ts:321-324`）。\n- **选择行取值全部从 `this.rows` 换成 `this.filteredRows`**，共四处：重命名输入中的 Enter（`:121`）、`r` 进入改名（`:162`）、Enter 切换（`:171`）、↑↓ 边界（`:145-154`）。\n- `render()`（`:192`）：\n  - 行列表改用 `this.filteredRows`；`recoverable` 仍用 `this.rows`，区分“无会话”和“筛选无匹配”。\n  - 新增筛选行：输入中用 `reverse`，已提交用 `dim`；用 `truncateText` + `wrap:false` 保证一行。\n  - 行数预算：`Math.max(1, height - (筛选行可见 ? 5 : 4))`。\n  - 复用 `sessionDisplayTitle` 替换现有标题回退；`formatTime` 不动。\n- 复用 `src/render/text.ts` 的 `truncateText`、`displayWidth`。\n\n**文案（定稿）**：\n\n- 普通头部：`会话 · ↑↓ 选择 · Enter 切换（重启） · / 筛选 · a 全部目录 · r 改名 · Esc 关闭`（80 列终端内容宽 78，此串宽 77，不换行）\n- 紧凑头部（可用宽度不足 77 时）：去掉 `（重启）`，其余不变\n- 筛选输入态头部：`会话 · 筛选：输入标题关键词 · Enter 完成 · Esc 清除`\n- 输入态筛选行：`  筛选：<query> · 匹配 n/m`\n- 已提交筛选行：`  筛选「<query>」 · 匹配 n/m · / 修改 · Esc 清除`\n- 无匹配行：`  没有匹配「<query>」的会话`\n- 无会话空态保持原文：`没有可恢复的会话；直接在新会话里开始，或按 a 看全部目录`\n\n### 3. `tests/unit/sessions-panel.test.ts`\n\n- 扩展 `fakeCtx(records, titles?)`（`:24-34`），允许指定标题（含空标题）；`makePanel` 透传。\n- 新增 `key(text)` 小 helper；导入 `filterSessionsByTitle`、`sessionDisplayTitle`。\n- 新增用例见下。\n\n### 不改的文件\n\n- `src/controls/feature-host.ts`、`src/controls/feature-keys.ts`：面板已在 `handleKey` 链里；`/` 是面板局部键，不进全局 keymap。\n- `README.md` / `README.en.md` / `--help`：面板内按键沿用 `a`/`r` 的既有做法，只在面板头部提示。\n- `docs/specs/` 旧 spec：冻结记录，不回写；本功能不新增 ADR（局部交互，无跨模块长期契约）。\n- 无 schema、无持久化、无新依赖。\n\n## 状态流\n\n1. 打开/`Ctrl+L` → `refresh()` 读取 cwd 内顶层会话 → `rows` → `rebuildFiltered()`。\n2. `/` → `filterEditing = true`；每个字符 → `setTitleFilter()` → 重算 `filteredRows` 且 `selected = 0`。\n3. `Enter` → 退出输入态；`Esc` → 按上述层级清空/关闭。\n4. `↑↓`/`r`/`Enter`/`a` 全部基于 `filteredRows`；`a` 触发 `refresh()` 后仍按当前查询过滤。\n5. 切换仍把选中行的 `id` 交给 `onSwitch`，受控重启路径不变。\n\n## 边界与失败模式\n\n- 空白查询：不过滤；提交时把纯空白查询归一成 `''`，避免“看不见的筛选”。\n- 无标题会话：按列表显示的 id 参与匹配。\n- 无匹配：显示专门空态，不误用“没有可恢复的会话”；`Enter`/`r` 无操作、不抛错。\n- 无会话：即使有查询也显示原空态（没有东西可筛）。\n- 标题读取失败/`sessionQuery` 不可用：沿用现有 `notice` 与空行行为；筛选函数对空数组安全。\n- 窄终端/长查询：筛选行截断为一行；头部按宽度在完整/紧凑文案间二选一，避免挤占行预算。\n- 输入中方向键不移动选择（避免误触），提交后再导航；`Ctrl+C`/`Ctrl+D` 不被面板吞掉。\n- 关闭面板时只退出输入态，已输入查询保留；重新打开可见同一筛选。\n\n## 测试用例（`tests/unit/sessions-panel.test.ts`）\n\n1. **输入即过滤、大小写不敏感、Enter 只提交不切换**：`/` + `alpha` → 只剩匹配行；渲染含 `匹配 2/4`；Enter 后 `onSwitch` 未调用；↓ + Enter 才切换。\n2. **Esc 分层**：输入中 Esc 清空并退出输入；已提交 Esc 清空筛选但不关面板；再无筛选 Esc 关闭。\n3. **输入态不触发快捷键**：输入 `a`/`r` 只进入查询，不切全部目录、不进入改名；退出输入后 `a` 仍能切目录。\n4. **筛选跨 `refresh()` 与 `a` 切换保持**：刷新、切全部目录后查询仍在，且对新行集重新过滤；选择序号被夹到匹配数内。\n5. **两种空态分开**：有会话但无匹配 → 显示“没有匹配…”；完全没有可恢复会话 → 仍显示原空态。\n6. **无标题会话按显示 id 匹配**：`title === ''` 时可用 id 片段筛到。\n7. **纯函数**：`filterSessionsByTitle` 的 trim、大小写、空查询、无匹配；`sessionDisplayTitle` 回退；头部提示在 80 列含 `/ 筛选`。\n\n## 验收与验证\n\n- 快速回路：`npx vitest run tests/unit/sessions-panel.test.ts`\n- 全量：`npm test`\n- 类型：`npm run typecheck`\n- 风格：`npm run lint`\n- 可选（本机有 PTY 时）：`npm run test:e2e`，确认 `tests/e2e/session-lifecycle.test.mjs:361-364` 的 `会话 · `、`a 全部目录`、空态文案仍匹配；本计划不修改 e2e 文件。\n- 手工冒烟：`Ctrl+L` → `/` → 输入标题片段 → `Enter` 完成 → `↓` + `Enter` 切换 → 再开面板确认筛选保留。\n\n## 假设与前置\n\n- **工作区**：当前 `.worktrees/issue-174` 有未提交的 #174 改动（`src/conversation/controller.ts`、`src/sessions/boot-patches.ts`、`tests/unit/conversation-delivery.test.ts`、未跟踪 evidence）。实施前应从 `origin/main` 另开 worktree/分支（如 `feature/session-title-filter`），不要把 #174 改动混进本功能 diff。\n- **流程**：按仓库 `AGENTS.md`，这是新需求；若走 spec-flow，正式实施前需先落 spec/issue，本计划只覆盖实施、不改旧 spec 正文。\n- **键位**：选 `/`（终端搜索惯例，面板内未占用）；若坚持单字母风格可改 `f`，只需改 `handleKey` 判定与头部文案，其余不变。\n- **不改身份**：筛选只作用于显示层，不按标题推断会话身份（沿用 `S02` 与 `ADR` 的既有约束）。"}
```

无返回（采集时仍待用户交互）。

</details>
