# [2026-11-02-nano-numpad] 小键盘输入兼容

- 组标识：`2026-11-02-nano-numpad`
- 角色：单份 spec，总纲与执行规格合一
- 状态：已合入（方案 PR #142）；执行 issue：#145；代码 PR：#148
- Issue：[#145](https://github.com/nano-sun99/dsh-tui-nano/issues/145)
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：M1–M4（见 §6）
- 上游：
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：`src/ink/parse-keypress.ts:311-328`（应用键盘模式 SS3 表）、`:499-533`（kitty `KP_*` 码表）
  - [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)（`KP_0..KP_9` = 57399–57408，`KP_DECIMAL..KP_SEPARATOR` = 57409–57416，`KP_LEFT..KP_BEGIN` = 57417–57427）
  - [xterm ctlseqs](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)（DECKPAM 应用键盘模式 `ESC O p..y` / `ESC O j..o` / `ESC O M`）
  - Ghostty DEC mode 1035 默认 true（忽略应用键盘模式，始终数字模式）
- ADR：无新增 ADR。这是解析器兼容修复，不改变长期接口、安全、数据或部署边界；按 ADR 规则不记录。
- 替代关系：替代 `src/input/parser.ts` 当前「SS3 只认 A–D、kitty KP 码当普通码点」的行为；不改 keymap、输入模型或渲染。
- 下游：无。
- 合入前提：单测全绿 + 真实 Ghostty 小键盘证据（NumLock 开时数字/运算符/Enter；NumLock 关时 kitty 导航键与 legacy 不猜；Shift+numpad 不输出 p–y）。

## 1. 目标与边界

目标：数字键盘在三种编码路径下都能正常输入。

1. **应用键盘模式（SS3）**：`ESC O p..y` → `0..9`；`ESC O j/k/l/m/n/o/M` → `* + , - . / Enter`；`ESC O X` → `=`。
2. **kitty keyboard protocol（CSI-u）**：`KP_0..KP_9` 57399–57408、`KP_DECIMAL..KP_SEPARATOR` 57409–57416 映射成对应字符；`KP_ENTER` 映射成 `enter`。
3. **kitty NumLock off**：`KP_LEFT/RIGHT/UP/DOWN/PAGE_UP/PAGE_DOWN/HOME/END/INSERT/DELETE` 映射到现有导航键；`KP_BEGIN` 忽略。
4. **不把未识别的功能键码点写进输入**：任何无法识别的 `KP_*` 或其他功能键码点都丢弃，不产生 `char` 事件。

### 非目标

- 不实现可配置的小键盘行为（例如「numpad 当方向键」开关）。
- 不尝试在 legacy 编码下区分 NumLock 状态：NumLock off 时终端发的是与真实方向键/Home/End 完全相同的字节，终端侧信息已经丢失。
- 不改鼠标、IME、bracketed paste、focus reporting。
- 不改 keymap：数字/运算符进输入框，Enter 提交，方向键移动光标，沿用现有绑定。
- 不改 `KeyName` 联合类型；继续用 `char` + `text` 表示数字/运算符。

## 2. 现状与证据

调查基线：`origin/main` @ `17cc80b`；Ghostty 1.4.0；Node ≥ 22.19。

| 事实 | 证据 |
|---|---|
| `consumeSs3` 只处理 `A/B/C/D`；其它 SS3 被整段消费后丢弃，不产生事件 | `src/input/parser.ts:271-290` |
| kitty CSI-u 分支用 `String.fromCodePoint(codePoint)`；`namedFromCodepoint` 只认 13/9/27/127，`KP_0` 57399 会变成私有区字符 | `src/input/parser.ts:240-249`、`:338-351` |
| `parseModifierFlags` 只取 shift/alt/ctrl/meta 四位（bit1/2/4/8），忽略 num-lock（64）、caps-lock（128）以及 kitty 的 hyper/super；bit8 在 kitty 里是 super，nano 现有模型沿用 `meta` 命名 | `src/input/parser.ts:297-305` |
| nano 进入终端时启用 kitty keyboard protocol `\x1b[>1u` | `src/render/ansi.ts:229`；`src/runtime/terminal.ts` 的 `enter()` |
| Ghostty 默认 DEC mode 1035 为 true，忽略应用键盘模式、始终数字模式；SS3 路径主要出现在其它终端、显式 reset 1035、或 Shift+numpad | Ghostty 源码 `src/terminal/modes.zig`（1035 `.default = true`）与 `src/input/key_encode.zig`；[ghostty-org/ghostty#1267](https://github.com/ghostty-org/ghostty/pull/1267) |
| Ghostty 已知 issue：macOS numpad 不识别、Shift+numpad 输出 `pqrstuvwxy`，说明 SS3 路径确实存在 | [ghostty-org/ghostty#1099](https://github.com/ghostty-org/ghostty/issues/1099) |
| Claude Code 的 SS3 表：`Op..Oy` → 0–9，`Oj *`、`Ok +`、`Ol ,`、`Om -`、`On .`、`Oo /`、`OM return` | `src/ink/parse-keypress.ts:311-328` |
| Claude Code 的 kitty 表：57399–57408 → 0–9，57409 `.`、57410 `/`、57411 `*`、57412 `-`、57413 `+`、57414 return、57415 `=` | `src/ink/parse-keypress.ts:499-533` |
| 现状后果：应用键盘模式下数字/Enter 被吞；kitty `KP_*` 路径可能插入 U+E037 一类私有区字符 | 2026-11-02 用户反馈「没有兼容小键盘」；源码路径如上 |

## 3. 行为规格

### 3.1 SS3（应用键盘模式）

| 序列 | 语义 |
|---|---|
| `ESC O p` … `ESC O y` | `0` … `9`（`char` + `text`） |
| `ESC O j` | `*` |
| `ESC O k` | `+` |
| `ESC O l` | `,` |
| `ESC O m` | `-` |
| `ESC O n` | `.` |
| `ESC O o` | `/` |
| `ESC O M` | `enter` |
| `ESC O X` | `=` |

- 仍保留 `ESC O A/B/C/D` 的 up/down/right/left 映射。
- 其它 SS3 继续丢弃，不产生事件。

### 3.2 kitty CSI-u（`KP_*`）

| 码点 | 语义 |
|---|---|
| 57399–57408 | `0` … `9` |
| 57409 `KP_DECIMAL` | `.` |
| 57410 `KP_DIVIDE` | `/` |
| 57411 `KP_MULTIPLY` | `*` |
| 57412 `KP_SUBTRACT` | `-` |
| 57413 `KP_ADD` | `+` |
| 57414 `KP_ENTER` | `enter` |
| 57415 `KP_EQUAL` | `=` |
| 57416 `KP_SEPARATOR` | `,`（与 SS3 的 `Ol` 对齐；见 §7） |
| 57417 `KP_LEFT` | `left` |
| 57418 `KP_RIGHT` | `right` |
| 57419 `KP_UP` | `up` |
| 57420 `KP_DOWN` | `down` |
| 57421 `KP_PAGE_UP` | `pageup` |
| 57422 `KP_PAGE_DOWN` | `pagedown` |
| 57423 `KP_HOME` | `home` |
| 57424 `KP_END` | `end` |
| 57425 `KP_INSERT` | `insert` |
| 57426 `KP_DELETE` | `delete` |
| 57427 `KP_BEGIN` | 忽略（NumLock off 时小键盘 5 是 Begin，不应插入 `5`） |

- 保留 CSI-u 携带的 shift/alt/ctrl/meta 修饰位；例如 `Shift+KP_0` 仍产生 `0` 的 `char`，但 `shift=true`，由上层 keymap 决定行为。
- 不再把 57399–57427 当普通 Unicode 码点插入。

### 3.3 NumLock off 的边界

- **legacy 编码无法区分**：NumLock off 时小键盘发的是与真实方向键/Home/End/PgUp/PgDn/Insert/Delete 相同的字节；解析器把它们当普通导航键处理，不做「这是小键盘」的猜测。
- **kitty 编码可区分**：`KP_LEFT` 等专用码点按 3.2 映射；`KP_BEGIN` 忽略。
- 不承诺「NumLock off 时小键盘数字也能输入」；这需要终端在 kitty 协议下发送 `KP_0..9`，或用户打开 NumLock。

### 3.4 输入行为

- 数字/运算符：作为普通字符进入输入框，走现有 `char` 路径；补全、草稿、历史、32 KiB 上限都不变。
- Numpad Enter：等价 `enter`；输入态提交，运行态按现有 Enter 语义处理。
- Numpad 方向键（kitty NumLock off）：等价现有方向键；输入态移动光标，列表/面板态移动焦点。
- 修饰键：`Alt+Enter` / `Shift+Enter` 等换行路径保持；numpad Enter 不带修饰时是 `enter`。

### 3.5 未知序列

- 任何不在 3.1 / 3.2 表内的**小键盘** SS3 或 `KP_*` CSI-u 序列：丢弃，不产生 `char`，不插入功能键码点。
- 非小键盘 CSI-u（例如 `\x1b[13;2u` Shift+Enter、普通字符、Enter/Tab/Esc/Backspace）保持现有分支，不受本 spec 影响。
- 不为未知序列新增告警 notice，避免每按一次键就刷屏；诊断日志可选。

## 4. 失败与不变量

1. **绝不把未识别的功能键码点写进输入**：57399–57427 必须走映射或丢弃；其它未识别功能键码点也不能退化成 `char`。
2. **未知小键盘序列不变成文本**：未识别的 SS3 / `KP_*` CSI-u → 丢弃；非 KP CSI-u 走现有分支。
3. **不猜 NumLock 状态**：legacy 方向键字节按导航键处理，不做物理键位推断。
4. **不改 keymap**：数字/运算符/Enter/方向键的语义由现有绑定决定；本 spec 只补解析。
5. **无回归**：真实方向键、Home/End/PgUp/PgDn/Insert/Delete、F1–F4、鼠标、粘贴、focus 事件保持现有行为。
6. **修饰位不丢**：CSI-u 的 shift/alt/ctrl/meta 按现有四位保留；hyper/super 本轮不新增。
7. **KP_BEGIN 不插入 5**：NumLock off 时小键盘 5 是 Begin，按导航/忽略处理。

## 5. 验收

- [x] SS3 每个序列（`p..y`、`j/k/l/m/n/o/M/X`）单测：产生正确的 `char`/`enter`，sequence 正确，且 pending 为空。
- [x] kitty `KP_0..KP_9`、`KP_DECIMAL..KP_SEPARATOR` 单测：产生正确字符/`enter`；57416 产生 `,`；pending 为空。
- [x] kitty `KP_LEFT..KP_DELETE` 单测：产生对应 `KeyName`；`KP_BEGIN` 不产生事件；pending 为空。
- [x] CSI-u 带修饰位：shift/alt/ctrl/meta 按现有四位保留；hyper/super 不新增。
- [x] 未知小键盘 SS3 / `KP_*` CSI-u：不产生事件，pending 为空，输入框无功能键码点。
- [x] 非 KP CSI-u（`\x1b[13;2u` Shift+Enter 等）：现有行为不变。
- [x] 真实 Ghostty（默认 1035）：NumLock 开时 numpad 0–9、`+ - * / .`、Enter 全部可用；NumLock 关时 legacy 方向键按导航键处理，不承诺数字输入；kitty 下 `KP_LEFT..` 可用；Shift+numpad 不输出 `pqrstuvwxy`。（Ghostty 1.4.0 实测：0–9、`. / * - + =`、Enter、Shift+1–5 正常；macOS 无 NumLock，`KP_LEFT..` 导航码由单测覆盖）
- [x] SS3 路径：单测覆盖；Ghostty 默认 1035 下未另做真机。
- [x] 现有 `tests/unit/input.test.ts` 全绿；`input-frame.test.ts` 渲染用例不受影响；真实方向键、Home/End/PgUp/PgDn 无回归。（unit 426 + feature 46 全绿）
- [x] legacy NumLock off：`\x1b[A` / `\x1b[3~` 仍产生 up/delete，无附加事件。
- [x] 输入框接受 numpad 数字后，补全/草稿/历史/32 KiB 上限行为不变。（沿用 `char` 路径，相关测试全绿）

## 6. 机制清单

| 机制 | 解决什么 / 没有会怎样 | 确认与代价 |
| --- | --- | --- |
| M1 SS3 应用键盘映射 | 应用键盘模式下数字/符号/Enter 可用；没有则吞键 | 照抄 Claude Code 2.1.88 的表；无新依赖 |
| M2 kitty `KP_*` 映射 | kitty 协议下 numpad 不插功能键码点；没有则输入框出现 U+E0xx | 照抄 kitty 码表；57416 为自定扩展；保留修饰位 |
| M3 NumLock off 导航映射 | kitty 下 KP 方向键可用；没有则 NumLock off 的小键盘方向键无效 | 只做 kitty 可区分的部分；legacy 不猜 |
| M4 未知小键盘序列丢弃 | 防止功能键码点变成文本；没有则输入框出现 PUA/怪字符 | 只丢弃未识别的小键盘序列；非 KP CSI-u 不动 |

## 7. 自定细节

- SS3 `ESC O X` → `=`：xterm ctlseqs 的应用键盘表包含 `=`；Claude Code 的 SS3 表未列，但为完整兼容加入。
- `ESC O l` → `,`：与 Claude Code 一致；`KP_SEPARATOR` 57416 也映射为 `,`，保持 SS3 / kitty 两条路径一致。
- `KP_BEGIN` 57427 忽略：NumLock off 时小键盘 5 是 Begin，插入 `5` 会与用户预期冲突。
- `KP_SEPARATOR` 不在 Claude Code 的 kitty 表内；本 spec 加入是为了与 SS3 的 `Ol` 对齐，标为自定扩展。
- CSI-u 修饰位保留；不新增 `KeyName`，继续用 `char` + `text`。
- 未知序列只丢弃，不新增 notice；诊断日志可选。
- 不实现 legacy NumLock-off 的物理键位区分；终端字节层已丢失信息。
- 解析器测试放在现有 `tests/unit/input.test.ts`；`input-frame.test.ts` 是输入区渲染回归，不塞解析器用例；不新建测试框架。

## 8. 审核修订记录

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 重要 | §5 要求 NumLock 开/关全部可用，与 §3.3「不承诺 NumLock off 数字」矛盾 | 已改：验收拆成 NumLock 开（数字/运算符/Enter）与关（legacy 导航、kitty KP 方向键，不承诺数字） |
| 2 | 重要 | 「任何未知 CSI-u 丢弃」会吞 Shift+Enter 等非 KP 序列 | 已改：§3.5 / §4.2 收窄到未识别的**小键盘** SS3 / `KP_*`；非 KP CSI-u 走现有分支 |
| 3 | 重要 | Ghostty 1035 默认 true 与 SS3 证据互斥，真实 Ghostty 能否验 M1 说不清 | 已改：§2 区分默认数字模式与 SS3 路径（其它终端 / reset 1035 / Shift+numpad）；验收补单测或 `CSI ?1035l` |
| 4 | 轻微 | Claude Code 行号偏差 | 已改：`311-328`、`499-533` |
| 5 | 轻微 | 修饰位「原样保留」不成立；hyper/super 被丢 | 已改：明确只保留现有四位；hyper/super 本轮不新增 |
| 6 | 轻微 | PUA 不变量范围过窄 | 已改：改为「未识别的功能键码点」；KP 段必须映射或丢弃 |
| 7 | 轻微 | 测试位置写成 `input-frame.test.ts`，它是渲染回归 | 已改：解析器用例只进 `input.test.ts` |
| 8 | 轻微 | 57416 未进入头部区间与 §1 目标 | 已改：头部改为 `KP_DECIMAL..KP_SEPARATOR`，§1 同步 |
| 9 | 轻微 | §6 缺「未知序列丢弃」机制；M2 未标 57416 是自定扩展 | 已改：新增 M4；M2 注明 57416 |
| 10 | 轻微 | 验收只写「不产生事件」，没断言序列被完整消费 | 已改：关键项补「pending 为空」 |
| 11 | 轻微 | 「不猜 NumLock」没有验收项 | 已改：补 legacy `\x1b[A` / `\x1b[3~` 仍产生 up/delete |
