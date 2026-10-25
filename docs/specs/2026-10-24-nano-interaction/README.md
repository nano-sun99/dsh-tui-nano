# [2026-10-24-nano-interaction] 交互对齐：/model、思考强度、/ 补全与输入框选区

- 组标识：`2026-10-24-nano-interaction`；角色：单份 spec（不拆，用户 2026-10-24 拍板），同时承担总纲与执行规格。
- 结构选择：保留四组验收（桥接修复、模型单页、命令补全、输入选区）在同一执行 issue 与同一 PR 内串行落地。不拆的原因：三块 UI 共用 `crates/nano-app/src/app.rs`、`ui.rs` 与 `crates/nano-conversation/src/input.rs` 这组热文件，拆开只能在文件边界上互相让路，省不下实施时间；代价是这批改动作为一个整体回滚。
- 状态：草案（2026-10-24）。
- 上游：`2026-10-20-nano-v1` 的 S02/S04/S05 已合并；`2026-10-22-nano-visual-followup` 已合并；`ADR-20261022-input-history` 生效中。
- 下游：无。
- 合入前提：本 spec 合并后开执行 issue；实施需 Rust 与桥接测试全绿，按 §5 留存证据。
- 替代关系：不重写已合并 spec 正文；与既有业务条款的兼容与取代见 §2.3。

## 1. 目标与边界

目标：把 nano 的斜杠交互对齐到 Claude Code 2.1.88 的实际行为，并修掉 `/model` 在当前 profile 下不可用的阻断缺陷：

- 输入 `/` 时出现命令补全候选，支持实时筛选、`↑↓` 选择、`Tab` 只补全、`Enter` 执行、行内灰字补全。
- `/model` 改为单页：`↑↓` 选模型，`←→` 当场调整思考强度，`Enter` 一次确认模型与强度。
- 输入框支持鼠标点击定位、拖选高亮、输入替换选区、`Shift` + 方向键扩选、复制。
- 修复桥接层把占位 `sessionController` 误当成完整控制器导致的目录读取与模型切换失败。

范围：

- `bridge/controls/` 的模型目录、模型切换与选择钩子安装路径；`bridge/runtime/capabilities.mjs` 的模型选择能力上报。
- `crates/nano-controls/` 的命令面板模型页与强度内联。
- `crates/nano-conversation/` 的输入缓冲区选区模型。
- `crates/nano-app/` 的命令补全状态、输入渲染、鼠标命中、选区高亮与复制。

不做：

- 不新增协议方法、RPC 字段或官方服务；不改数据所有权与凭据。
- 不做命令参数级补全、模糊搜索、别名系统、历史搜索（`Ctrl+R`）。
- 不改 `@file` 补全的候选来源与请求路径。
- 不改实时预览提示的文案与触发条件（第四条反馈是既有设计说明，见 §3.5）。
- 不新增主题色 token；选区与选中态复用现有 `selected_bg` / `hover_bg`。

拥有：`bridge/controls/service.mjs`、`bridge/runtime/capabilities.mjs`、`bridge/test/controls.test.mjs`、`crates/nano-controls/src/panel.rs`、`crates/nano-conversation/src/input.rs`、`crates/nano-app/src/{app,ui}.rs`、新增 `crates/nano-app/src/command_completion.rs`、对应测试、`docs/evidence/2026-10-24-nano-interaction/`、本 spec。

不碰：`protocol/`、`bridge/runtime/methods.mjs`、`crates/nano-transcript/`、`crates/nano-attachments/` 的补全实现、`crates/nano-skills/` 的数据模型、`crates/nano-theme/` 的调色板。

## 2. 已确认决定

### 2.1 用户反馈与决定

用户 2026-10-24 反馈四条，并指定以 Claude Code 的斜杠交互为参照：

| # | 反馈 | 决定 |
| --- | --- | --- |
| 1 | 输入 `/` 时没有补全提示 | 新增命令补全：候选列表 + 实时筛选 + `↑↓` + `Tab` 补全 + `Enter` 执行 + 行内灰字。见 §3.3。 |
| 2 | `/model` 交互不对 | 先修桥接能力探测；再把面板改成单页，`←→` 内联调强度。见 §3.1、§3.2。 |
| 3 | 输入框选中无效果、输入跳到别处 | 输入缓冲区增加选区；鼠标点击定位、拖选高亮、输入替换选区。见 §3.4。 |
| 4 | 「实时预览有缺失，完整内容以最终消息为准」是什么意思 | 这是流式预览漏帧或超长截断时的诚实提示，最终消息才是完整内容。设计不变，见 §3.5。 |

### 2.2 机制清单（用户 2026-10-24 全要）

| 机制 | 解决什么 | 没有会怎样 |
| --- | --- | --- |
| 命令补全状态 | 输入 `/` 立即看到可用命令、视图命令与可调用技能，以及说明与可用性；`↑↓` 选、`Tab` 补全、`Enter` 执行 | 只能背命令名，打错靠报错发现 |
| 行内灰字 | 唯一前缀匹配时把剩余字母画在光标后，`Tab`/`→` 接受 | 列表仍可用，只是多看一眼 |
| 输入选区（anchor + caret） | 拖选高亮、输入/删除替换选区、`Shift` + 方向键扩选、复制 | 只能整段重打，「选中无效果」仍在 |
| 鼠标命中映射 | 把屏幕坐标换算成文本偏移，处理 `> ` 前缀、折行、CJK 宽度、输入区滚动 | 点击不定位光标，输入仍落回旧位置 |
| 模型单页 + 内联强度 | 一个列表选模型，`←→` 调强度，`Enter` 一次确认；取代两级面板 | 修好报错后仍是两层翻页，与 Claude Code 不一致 |
| 桥接能力探测（修复） | 区分占位 `sessionController` 与真控制器，缺方法时走官方 `buildModelCatalog` / `llm` 回退 | `/model` 与选模型永远报 `is not a function` |

### 2.3 取代清单

| 旧行为 | 位置 | 本 spec 的处理 |
| --- | --- | --- |
| 模型页 `Enter` 进入单独的强度页 | `crates/nano-controls/src/panel.rs` 现有 `PanelAction::OpenEfforts` 路径 | 由单页 + `←→` 内联强度取代；不再进入强度页 |
| 目录与切换把「`sessionController` 存在」当成「完整控制器」 | `bridge/controls/service.mjs` 的 `modelCatalog()` 与 `selectModel()`；`bridge/runtime/capabilities.mjs` 的能力上报 | 改为逐方法探测；只有控制器真的提供该方法才走控制器路径。选择钩子安装按构造时是否已有真控制器判断（当前启动顺序下构造时占位对象尚未提供，钩子本来就会装；本次只去掉「存在即跳过」的误判） |
| 输入缓冲区只有光标，没有选区 | `crates/nano-conversation/src/input.rs` | 增加 `selection_anchor` 与相关编辑语义 |
| 视图命令在 `Ctrl+P` 面板、技能在独立技能面板，两条来源互不相通 | `crates/nano-controls/src/model.rs` 的 `commands()` 与 `crates/nano-skills/src/catalog.rs` 的 `entries()` | 两者都进入 `/` 补全候选；官方命令仍优先于同名技能 |

### 2.4 与既有 ADR / spec 的关系

- `ADR-20261022-input-history`：选区不改变已提交历史的持久化；上键进入历史浏览时清空选区，历史草稿恢复后回到进入历史前的光标（沿用现有 `saved_cursor` 行为）。
- `ADR-20261022-nano-theme-scope` / `ADR-20261022-independent-tui-theme`：选区底色与面板选中态复用 `selected_bg`，不新增颜色角色。
- `2026-10-20-nano-v1/S04` §3：强度仍只列模型声明的档位；未显式选择时仍显示「默认」，不伪造具体档位。本文只改交互形态，不改这条业务事实。
- `2026-10-22-nano-visual-followup` §3.1：实时预览提示保持原文案与触发条件。
- `2026-10-22-nano-visual-followup` §3.4：输入框上键历史行为不变；选区只在普通编辑态生效。

## 3. 详细规格

### 3.1 桥接：能力逐项探测

问题：`provideSessionController` 为调度服务提供了一个只含 `resolveAgent` 的占位对象；`ControlsService` 只要看到 `sessionController` 存在，就调用 `controller.modelCatalog()` / `controller.selectModel()`。真实启动顺序是 `host.mjs` 先构造 `ControlsService`、之后才提供占位对象，所以选择钩子在构造时已经正常安装；真正坏掉的是构造之后的目录读取与模型切换。dsh 0.2.1-rc.2 的该 profile 因此在 `/model` 处报 `host error 1026: controller.modelCatalog is not a function`。

要求：

- `modelCatalog()`：仅当 `typeof controller?.modelCatalog === 'function'` 时走控制器；否则走既有回退 `buildCatalogInjected(ctx, defaults.currentSelection(), official.buildModelCatalog)`。
- `selectModel()`：仅当 `typeof controller?.selectModel === 'function'` 时走控制器；否则走既有 `llm` + `agentDefaultModel` 路径（校验模型、解析调用配置、追加 `model/selection`、后台保存默认值）。
- `installSelectionHooks()`：当前启动顺序下构造时控制器不存在，钩子已经会安装；本次只把守卫从「`sessionController` 存在」改为「控制器提供 `selectModel`」，防止其他部署在构造前提供占位对象时误跳过。真控制器提供 `selectModel` 时仍跳过，避免重复安装。
- `capabilities.mjs` 的 `modelSelection`：改为「真控制器提供 `selectModel`」或「`llm` 与 `agentDefaultModel` 都存在」才算 supported。
- 占位对象的 `resolveAgent` 行为不变；调度服务仍能解析根 Agent。
- 错误映射沿用现有 `mapOfficialError`；不新增 RPC 错误码。

测试：

- 真实启动顺序（先构造 `ControlsService`，再提供占位控制器）：目录来自注入的官方 builder；切换走 `llm` 路径；选择钩子安装一次。
- 构造前就提供占位控制器（仅 `resolveAgent`）：目录与切换仍走回退；选择钩子安装一次，不因占位对象跳过。
- 真控制器在构造时存在且提供两个方法：优先走控制器，不重复安装钩子。
- 能力上报：占位控制器 + 缺 `llm`/`agentDefaultModel` 时报告 unsupported。

### 3.2 `/model` 单页与内联强度

#### 3.2.1 结构

面板只保留 `PanelMode::Models`：

- 顶部标题：`模型 · 查询：<query>`。
- 头部一行：`当前：<model> · 强度 <effort|默认>`；目录可能过期或状态读取失败时沿用现有后缀。
- 模型列表：沿用 provider 分组、当前项 `（当前）`、不可用行与原因、选中行详情。
- 列表下方固定一行强度条（不随列表滚动）：
  - 模型声明了强度：`强度：<指示> <名称>（默认） · ← → 调整`；未显式选择时名称为「默认」，括号内补模型默认强度名。
  - 模型没有强度元数据：`强度：该模型未声明（不可调）`。
  - 焦点行不可用或目录读取失败：`强度：—`。
- 底部提示：`↑↓ 选择 · ← → 调强度 · Enter 确认 · Esc 返回 · 输入筛选`。

指示符规则：

- 循环项为「默认」+ 模型声明的强度，按目录顺序。
- 总项数 ≤ 5 时，用等量 `●`/`○` 表示当前位置；超过 5 项时省略圆点，只显示名称。
- 「默认」不画实心圆点。

#### 3.2.2 键位

- `↑` / `↓`：移动模型焦点；焦点变化时重置强度选择。
- `←` / `→`：在「默认」与声明档位之间循环，首尾相接。
- `Enter`：提交焦点模型与当前强度；与现有成功/失败回执一致。
- `Esc`：关闭面板，不写任何选择。
- 可打印字符：仍作为筛选词，不触发强度调整。
- 删除键 / Backspace：仍编辑筛选词。

#### 3.2.3 强度选择与提交

- 焦点移到某个模型时：
  - 若该模型就是当前模型且官方投影里有显式强度，初始为那个强度；
  - 否则初始为「默认」。
- `Enter` 提交：强度为「默认」时不发送 `reasoningEffort` 字段（保留模型默认，不伪造档位）；否则发送声明的强度 id。
- 提交后立即关闭面板，沿用现有 `Pending::ControlsSelectModel` 回执：成功通知、失败保留旧选择并显示错误、writer-held 不接管。writer-held 的协议码是 **1022**；现有 `app.rs` 检查的 1019 实际是 `nano/skills/not-found`，本次一并把模型与权限两处判断改为 1022 并补测试。
- 目录为空、读取失败或模型行不可用时，`Enter` 只显示原因，不发请求。

#### 3.2.4 兼容

- 不再产生 `OpenEfforts` 动作；`PanelMode::Efforts` 可从界面上移除，是否保留类型由实施决定，但用户不可再进入。
- `Esc` 不再从强度页返回模型页，而是直接关闭。

### 3.3 `/` 命令补全

#### 3.3.1 触发条件

同时满足时显示：

- 输入框获得焦点，且没有打开面板、附件选择器、决策卡或会话列表；
- 不在子代理输入框（子代理视图不显示命令补全，保持现有 `child_active` 行为）；
- 草稿以 `/` 开头；
- 光标位于第一个 token 内（第一个空白字符之前）。

光标移出第一个 token、草稿不再以 `/` 开头、或用户按 `Esc` 关闭后，隐藏候选。`@file` 补全与命令补全互斥；草稿以 `/` 开头时不显示文件补全。

#### 3.3.2 候选来源与排序

- 来源一：`ControlsModel::commands()`（官方命令 + nano 视图命令），保留名称、描述、参数提示、可用性与原因。
- 来源二：`SkillCatalog` 中 `user_invocable == true` 的技能；名称已被命令占用时命令优先，技能不重复出现。
- 候选行：`/name`，右侧描述；技能加 `[技能]` 标签；不可用命令附原因。
- 筛选：大小写不敏感；先取前缀匹配集合，前缀集合为空时再取子串匹配集合；两组不混排；不引入模糊匹配依赖。
- 排序：完全匹配最前，其余同组内按名称升序。
- 最多显示 6 条，复用现有补全区高度。

#### 3.3.3 键位

- `↑` / `↓`：移动选中候选。
- `Tab`：接受当前候选，只补全不执行，统一补 `/name `（尾随一个空格）。
- `Enter`：接受当前候选，并按 §3.3.4 决定是否执行。
- `→`：仅当行内灰字可见且光标在 token 末尾时接受灰字；否则保持普通光标右移。
- `Esc`：关闭候选，保留已输入文本；同一次输入内不再自动弹出，直到输入发生变化。
- 其他可打印字符：继续输入并重新筛选。

#### 3.3.4 接受与执行

- 接受时只替换草稿的第一个 token：`/prefix` → `/name `；保留 token 之后的文本与光标相对位置。
- `Enter` 的执行动作复用 Ctrl+P 面板的既有 `command_action` 的动作分类（只借分类，不直接调用其 `PrefillCommand` 实现——那会用 `set_text` 覆盖整段草稿）：
  - `/model`、`/permission`：打开对应面板；
  - 其他带参数提示（`input_hint` 非空）的官方命令：只补全 `/name `，不执行，焦点留在输入框；
  - 无参数提示的官方命令：补全 `/name ` 并按现有斜杠路由执行；
  - 技能：补全 `/name ` 并按现有技能路径提交（与直接输入 `/技能名` 回车一致）。
- `Tab`：无论哪种候选，都只补全 `/name `，不执行。
- 不可用候选：`Enter` 不发请求，只在状态区显示既有原因；`Tab` 允许补全。
- 执行路径复用 `dispatch_controls_line` / `execute_controls_command` / 现有技能提交路径，不新增 RPC。

#### 3.3.5 行内灰字

- 条件：草稿第一个 token 是某个候选名称的严格前缀，光标在 token 末尾，且没有其他同前缀候选并列第一。
- 内容：候选名称去掉已输入前缀后的剩余字符。
- 样式：muted，不占缓冲区、不参与点击命中、不换行；只画在光标所在行，按剩余宽度截断。
- 接受：`Tab` 或 `→` 把灰字并入草稿；光标停在补全后的名称末尾，尾随空格规则同 §3.3.4。
- 有多条同前缀候选或没有前缀匹配时不画灰字。

#### 3.3.6 渲染

- 复用输入框上方的补全区，标题改为：`命令补全（<N> 项） · ↑↓ 选择 · Tab 补全 · Enter 确认 · Esc 关闭`。
- 选中行使用 `▶` 或现有选中样式 + `selected_bg`；描述 muted；不可用行 muted 并附原因。
- 没有候选时不占高度；候选变化引起的高度变化与现有文件补全一致。

### 3.4 输入框点击、选区与复制

#### 3.4.1 缓冲区

`InputBuffer` 增加选区状态：

- `selection_anchor: Option<usize>` 与现有 `cursor` 组成选区；anchor 与 cursor 都是字符边界。
- `selection_range()` 返回 `(start, end)`，顺序归一化；anchor 为空或与光标相等时无选区。
- `select_to(cursor)`：保留 anchor，移动光标；`begin_selection()` 在首次扩选时把当前光标设为 anchor；`clear_selection()` 清空 anchor。
- 插入文本、粘贴、换行：有选区时先删除选区再插入。
- Backspace / Delete：有选区时删除选区，不再多删一个字符。
- 方向键与 Home/End：无 `Shift` 时移动光标并清空选区；有 `Shift` 时保留 anchor 并移动光标。
- 提交、`set_text`、切换草稿、输入框失焦、`Esc` 关闭补全：清空选区。

#### 3.4.2 鼠标

- 左键按下落在输入框内区（上下边框之间、发送按钮之外），且处于可发送草稿、没有 picker / 面板 / 决策卡时：
  - 把焦点切到输入框；
  - 把点击位置映射为文本偏移并设置光标；
  - 清空旧选区，记录拖动起点。
- 左键拖动：从起点扩选到当前映射偏移；选区跨越折行与 CJK 字符时按字符边界处理。
- 左键松开：发生过拖动则保留选区；未拖动（原地点击）则保持无选区、光标在点击处。
- 点击发送按钮仍优先走 `click_send`；点击边框、状态栏、notice 行、附件行、picker 路径行、只读行或输入框外区域不移动光标。

命中映射：

- 普通可发送草稿行有 2 格前缀（首行 `> `，续行两个空格）；点击前缀区域映射到该行开头。notice 行、附件行、picker 路径行、只读行没有草稿行映射，不参与点击定位。
- 使用渲染时的折行结果与滚动偏移；点击超出末行映射到缓冲区末尾，点击行尾之后映射到该行末尾。
- 宽字符：点击其左半格落在字符前，右半格落在字符后。
- `\r` 在显示中隐藏，映射时视为零宽。
- 点击命中只读取最近一帧的布局；窗口尺寸变化后先重绘再接受点击。

#### 3.4.3 键位

- `Shift+←/→/↑/↓/Home/End`：扩选；`Home/End` 保持现有 `\n` 逻辑行语义（不改成显示折行），只增加选区扩展。
- 无 `Shift` 的移动、点击、输入、提交、失焦：清空选区。
- `Ctrl+Y`：有选区时复制选区；无选区时保持现有「复制整段草稿」行为。复制走现有 OSC 52 路径，并在状态区显示 `已复制选区` / `已发送复制草稿（原文）请求`。
- 其他 `Ctrl` / `Alt` 快捷键不因选区改变。

#### 3.4.4 渲染

- 选中字符使用 `selected_bg` 底色与 `fg` 前景；跨行选区逐行绘制。
- 光标仍在 caret 位置显示；选区高亮不改变字符宽度。
- 输入框内容滚动时，选区跟随文本行滚动。
- 灰字补全不参与选区，也不会被选中。

#### 3.4.5 与其他面板的关系

- 输入框失焦（焦点移到队列、dock、面板）时清空选区。
- 附件行、pick 路径行、只读记录不显示选区。
- 历史浏览恢复草稿后，回到进入历史前的光标（现有 `saved_cursor`），且无选区。

### 3.5 实时预览提示（不改）

`（实时预览有缺失，完整内容以最终消息为准）` 与 `（实时预览过长已截断，完整内容以最终消息为准）` 是 `2026-10-22-nano-visual-followup` §3.1 已批准的诚实提示：

- 流式预览观察到 dense-index / revision 缺口，或预览达到字节上限时显示；
- 最终消息落定后完整呈现，预览只是中间态；
- 本次不改文案、颜色、触发条件或位置。

## 4. 验收

- [ ] 桥接：只有占位 `sessionController` 时 `/model` 能列出真实目录；选模型走 `llm` 回退；选择钩子安装一次。
- [ ] 桥接：真控制器存在时仍优先走控制器，目录、切换、钩子行为不变。
- [ ] 桥接：能力上报在缺 `llm`/`agentDefaultModel` 时报告 unsupported。
- [ ] `/model`：单页列出模型；`↑↓` 移动；`←→` 在「默认」与声明档位间循环；`Enter` 一次提交模型+强度；`Esc` 不写入。
- [ ] `/model`：未显式选择强度时不发送 `reasoningEffort`，界面显示「默认」；模型不支持强度时显示不可调。
- [ ] `/model`：目录失败、空目录、不可用行仍显示原因，不自动替换模型。
- [ ] `/model`：writer-held 按协议码 1022 识别（模型与权限两处），1019 不再被当成 writer-held。
- [ ] `/` 补全：输入 `/` 出现候选；继续打字实时筛选；`↑↓` 选择；`Tab` 只补全；`Enter` 执行。
- [ ] `/` 补全：带参数提示的命令 `Enter` 只补全不执行；视图命令打开对应面板；补全不覆盖 token 之后的文本。
- [ ] `/` 补全：`user_invocable` 技能出现在候选并带 `[技能]`；与命令同名时命令优先、不重复出现。
- [ ] `/` 补全：行内灰字在唯一前缀匹配时出现，`Tab`/`→` 接受；多候选或无匹配时不出现。
- [ ] `/` 补全：不可用命令显示原因，`Enter` 不发请求。
- [ ] `/` 补全：子代理输入框不显示命令补全。
- [ ] 输入框：鼠标点击任意位置光标落点正确，包含折行、CJK、滚动后的行；notice / 附件 / picker / 只读行不移动光标。
- [ ] 输入框：拖选有高亮；输入/粘贴替换选区；Backspace/Delete 删除选区；`Shift` + 方向键扩选。
- [ ] 输入框：`Shift+Home/End` 与现有普通 `Home/End` 使用同一 `\n` 逻辑行边界。
- [ ] 输入框：`Ctrl+Y` 有选区时复制选区，无选区时复制整段草稿。
- [ ] 回归：`@file` 补全、历史浏览（恢复草稿回到进入前光标）、队列编辑、子代理输入、决策卡焦点不受影响。
- [ ] 证据：桥接测试、Rust 测试与 Ghostty 实拍齐全，见 §5。

## 5. 证据

- `npm --prefix bridge test`：全部通过。
- `cargo test`：全部通过。
- Ghostty 实拍（80 列与 100 列至少各一组）：
  - `/model` 单页、强度循环、确认后的状态；
  - 输入 `/` 的候选列表、筛选、灰字；
  - 鼠标点击定位、拖选区高亮、替换输入、CJK 文本点击。
- 证据目录：`docs/evidence/2026-10-24-nano-interaction/`，README 记录构建 commit、终端尺寸、主题与每个文件的说明。

## 6. 自定细节

- 命令筛选使用前缀 + 子串：前缀集合优先，为空才取子串集合，两组不混排。
- 补全候选最多 6 条，沿用现有补全区高度。
- 不可用命令仍出现在候选里，`Enter` 仅报原因，`Tab` 可补全。
- `Tab` 补全总是补 `/name `（带尾随空格）。
- `Enter` 的执行动作只借面板 `command_action` 的分类：`/model`、`/permission` 打开面板，其他带参数提示的官方命令只补全，其余官方命令与技能按现有路径提交；不复用 `PrefillCommand` 的整段 `set_text`。
- 强度循环包含「默认」项；「默认」省略 `reasoningEffort` 字段，不伪造档位。
- 强度指示圆点在总项数 ≤ 5 时显示，超过 5 项只显示名称。
- 选区复制复用 `Ctrl+Y`；`Ctrl+C` 的退出行为不变。
- 点击输入框边框、notice 行、附件行、picker 路径行、只读行都不移动光标；普通草稿行内区前缀映射到行首。
- `Shift+Home/End` 使用现有 `\n` 逻辑行边界，不改成显示折行。
- 拖动结束后保留选区；原地点击清空选区。
- 切换草稿、失焦、提交、`set_text` 清空选区。
- 不做命令参数补全、模糊搜索、别名系统、历史搜索。

## 7. 关联

- ADR：`docs/decisions/2026-10-22-input-history.md`、`docs/decisions/2026-10-22-nano-theme-scope.md`、`docs/decisions/2026-10-22-independent-tui-theme.md`
- spec：`docs/specs/2026-10-20-nano-v1/S04-controls.md`、`docs/specs/2026-10-22-nano-visual-followup/README.md`
- 参考实现：Claude Code 2.1.88（本机归档 `~/Downloads/归档/06-软件与安装包/ClaudeCode/src`）的 `components/ModelPicker.tsx`、`utils/suggestions/commandSuggestions.ts`、`hooks/useTypeahead.tsx`。
- 执行 issue：待开。

## 8. 审核修订记录

用户 2026-10-24 点「轻审」，1 个只读 agent 审出 11 条；用户点「改」，处置如下：

| # | 严重度 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | major | 钩子安装在构造时判断，真实启动顺序下占位对象尚未提供，不会跳过 | 已改 §3.1 / §2.3：修正断言；守卫改为按控制器是否提供 `selectModel` 判断；补真实顺序与构造前占位两种测试 |
| 2 | major | writer-held 协议码是 1022，`app.rs` 现查的 1019 实为 `nano/skills/not-found` | 已改 §3.2.3 / §4：明确 1022，并把模型与权限两处判断一并修正、补测试 |
| 3 | major | 历史恢复草稿用的是进入前光标，不是末尾 | 已改 §2.4 / §3.4.5 / §4：改为回到 `saved_cursor` |
| 4 | major | 技能候选出现在正文，但机制清单与验收没覆盖 | 已改 §2.2 / §4：机制清单补技能源，验收补 `[技能]` 与命令同名优先 |
| 5 | minor | 技能不在 `Ctrl+P` 面板，而在独立技能面板 | 已改 §2.3：改为「视图命令在 Ctrl+P、技能在技能面板，两者都进 `/` 候选」 |
| 6 | minor | §6 仍写提交 `null`，与 §3.2.3 省略字段冲突 | 已改 §6：统一为省略 `reasoningEffort` |
| 7 | minor | 筛选规则丢弃子串集后，排序里的子串档永远用不上 | 已改 §3.3.2 / §6：前缀集优先，为空才取子串集，两组不混排 |
| 8 | minor | 直接走 `PrefillCommand` 会用 `set_text` 覆盖整段草稿 | 已改 §3.3.4 / §6：只借动作分类，不复用 `set_text` 实现 |
| 9 | minor | 并非所有输入行都有 2 格前缀；notice / 路径 / 只读行不应接受点击定位 | 已改 §3.4.2 / §6 / §4：限定可发送草稿行，其余行不移动光标 |
| 10 | minor | `Shift+Home/End` 用显示行会与现有逻辑行语义不一致 | 已改 §3.4.3 / §6 / §4：统一用现有 `\n` 逻辑行边界 |
| 11 | minor | 触发条件未排除子代理输入框 | 已改 §3.3.1 / §4：子代理视图不显示命令补全 |

### 实施期重审（2026-10-25）

用户点「重审」，2 个只读 agent（规格符合性 18 条 + 对抗 10 条）；用户点「改」。处置：

| # | 严重度 | 发现 | 处置 |
| --- | --- | --- | --- |
| M1 | major | 灰字未限制在 token 末尾，光标左移后渲染成 `/perissionm`（F1 / 对抗 6） | 已改：ghost 仅在 `cursor == token_end` 时计算与接受；补 token 边界测试 |
| M2 | major | Shift 扩选到边界会清空既有选区（F2 / 对抗 1） | 已改：Shift 分支始终消费按键；Home/End 先取 anchor 再算 changed；补边界测试 |
| M3 | major | 冷启动打开 `/model` 丢失显式强度，Enter 悄悄改回模型默认（F3 / 对抗 5） | 已改：目录回包后重跑 `reset_effort_for_focus`；补晚到目录测试 |
| M4 | major | 补全选中项可移出可见 6 行，Enter 执行屏幕外候选（F4 / 对抗 3） | 已改：弹窗按选中行计算 6 行窗口；补渲染测试 |
| M5 | major | `Ctrl+U` / 提交 / 打开面板后补全残留，空草稿可被写回并执行（对抗 2 / F7） | 已改：清草稿、提交、开面板统一清 `command_completion`；补测试 |
| M6 | major | 鼠标点击后不刷新补全，`@file` 接受可能删字（对抗 4 / F13） | 已改：点击与拖动后 `refresh_completion()`；既有映射测试保留 |
| M7 | major | 证据缺鼠标场景与 Ghostty，README 两处说明与实拍不符（F16-F18） | 已改：补确认态 PTY 证据、修正 02 说明、逐项披露缺口；Ghostty/鼠标实拍仍待补 |

其余 minor（默认圆点、失焦/Esc 清选区、附件锚点、候选描述与原因、dismiss 保持、未使用 API、桥接目录优先与后置占位测试）已按发现逐条处理，见 commit `57ee776`。
