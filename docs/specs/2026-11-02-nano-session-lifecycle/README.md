# [2026-11-02-nano-session-lifecycle] 会话生命周期与多窗口

- 组标识：`2026-11-02-nano-session-lifecycle`
- 角色：单份 spec，总纲与执行规格合一
- 状态：草案（待过闸）
- Issue：待开（spec 合并后开执行单）
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：M1–M7（见 §6）
- 上游：
  - `docs/specs/2026-10-20-nano-v1/S07-sessions-context.md`（会话身份、认领、切换、不静默新建）
  - `docs/decisions/2026-10-29-root-session-resume-first.md`（同一目标先 resume，NotFound 才 create）
  - `docs/specs/2026-10-28-nano-ts/README.md` §3.1（现行根身份解析顺序）
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：`src/main.tsx:988`（`-c`/`-r`/`--fork-session`）、`src/main.tsx:3101-3117`（`-c` 无会话直接报错）、`src/utils/listSessionsImpl.ts:227-291`（按 mtime 倒序）、`src/utils/concurrentSessions.ts`（PID 检测，无 transcript 写锁）
- ADR：新增 [ADR-20261102-nano-default-new-session](../../decisions/2026-11-02-nano-default-new-session.md)
- 替代关系：替代 `2026-10-28-nano-ts/README.md` §3.1 的默认根解析口径（`--root` → `last-root` → 生成）与 `src/main.ts` 的 `--root` 帮助文案；**局部取代** `ADR-20261029-root-session-resume-first` 的「否决每次启动生成新 session id」一条（该否决在多窗口刚需出现后不再成立），其 resume-first 决定继续有效；本 spec 只在其上增加 `resumeOnly` 模式。旧 spec 保留为历史，不重写冻结正文。
- 下游：无硬依赖；B 的默认 bypass 与本文正交。
- 合入前提：单测 + 真实双窗口 PTY 证据；`nano --help` 同步；现有 `--root` 用法不被破坏。

## 1. 目标与边界

目标：让「开多个 nano 窗口，每个窗口负责不同的事」成为默认可用路径。

1. **默认新会话**：`nano` 不带参数时生成新的会话身份，不再沿用上一次的会话。
2. **显式续接**：`-c` 续当前目录最近使用的会话；`-r` 打开会话选择器；`-r <id>` 精确恢复。
3. **精确逃生口**：`--root <id>` 保留，作为「就用这个会话 id」的低级入口。
4. **多窗口**：每个窗口驱动一个会话；不同会话可并存；同一会话只允许一个 writer。
5. **不静默新建**：`-c` / `-r` 的目标不存在时必须报错，不能创建一个同 id 的空会话冒充恢复。

### 非目标

- 不实现 `--fork-session`（Claude Code 的分叉恢复）；需要时另立 spec。
- 不实现同一会话的多窗口只读查看；同一会话仍只允许一个 writer。
- 不实现跨机器 / 跨 clone 的会话恢复。
- 不实现项目级单实例锁；锁仍按会话 id。
- 不改官方会话存储、标题、压缩、配额与写锁语义。
- 不改 S07 的受控重启、草稿/锚点交接与拒绝路径；只改「默认拿哪个会话 id」和「怎么显式选会话」。

## 2. 现状与证据

调查基线：`origin/main` @ `17cc80b`；官方 `@deepseek-ai/dsh` 0.2.1-rc.2。

| 事实 | 证据 |
|---|---|
| 默认根身份解析顺序是 `--root <id>` → `<数据根>/last-root` → 生成时间戳 id；`last-root` 是全局的，不按 cwd | `src/boot/root.ts:38-55`；`src/main.ts:76-78` |
| `last-root` 在每次启动时被覆盖写入 | `src/main.ts:100-105`；`src/boot/root.ts:57-70` |
| 会话 id 就是根 id；启动时先 resume，NotFound 才 create | `src/conversation/controller.ts:123-151` |
| 挂载认领按根 id 加锁：`<数据根>/mount/<id>.lock`，第二个同 id 窗口在进备用屏前被拒绝 | `src/boot/root.ts:83-107`；`src/main.ts:107-130` |
| 错误文案只写「根 … 已被进程 … 占用；同一根只允许一个窗口」，没有给出路 | `src/boot/root.ts:25-34` |
| 会话列表来自官方 `sessionQuery.listSessions`，返回 `header`（含 `cwd` / `createdAt` / `parentSession` / `origin` / `delegationDepth`）与 `live` / `persisted` | `node_modules/@deepseek-ai/dsh-session-query/lib/index.js:95-120`；`node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:59-88` |
| 现有会话列表面板读取标题 / cwd，但渲染只显示标题；切换走受控重启；入口是 `Ctrl+L` | `src/sessions/list.ts:58-100`（读取）、`:169-199`（渲染只用 title）；`src/controls/feature-keys.ts:33`；`src/controls/feature-host.ts:203-216`（面板构造） |
| 受控重启已能把草稿带过 handoff，并以 `--root <id>` 重启 | `src/app/nano-app.ts:889-910`；`src/runtime/handoff.ts` |
| Claude Code 默认新会话；`-c` 只看当前目录、无会话直接报 `No conversation found to continue`；`-r` 打开选择器或按 ID 恢复 | `src/main.tsx:988`；`src/main.tsx:3101-3117`；[Manage sessions](https://code.claude.com/docs/en/sessions) |
| Claude Code 的「最近」按 `.jsonl` mtime 倒序；存在会话文件被元数据写入污染 mtime 的已知问题 | `src/utils/listSessionsImpl.ts:227-291`；[Manage sessions](https://code.claude.com/docs/en/sessions) |
| Claude Code 不靠 transcript 写锁防多开：只有 PID 文件做 `claude ps` 检测；同一会话两个 writer 会交错写 | `src/utils/concurrentSessions.ts`；[#83719](https://github.com/anthropics/claude-code/issues/83719)、[#101392](https://github.com/anthropics/claude-code/issues/101392)（报告者结论，非官方确认） |
| 现状的真实后果：用户第二个窗口得到「根 `preview-main` 已被进程 36737 占用」，无法开第二个窗口 | 2026-11-02 用户现场；`~/.dsh-tui-nano/mount/preview-main.lock` 的 pid 仍存活 |

## 3. 行为规格

### 3.1 启动模式矩阵

| 命令 | 目标会话 | 目标不存在时 | 备注 |
|---|---|---|---|
| `nano` | 新生成的会话 id | 创建 | 默认新上下文 |
| `nano -c` / `--continue` | 当前 cwd 最近使用的顶层会话 | 报错，不创建 | resume-only |
| `nano -r` / `--resume` | 打开会话面板（新会话 + 面板） | 空态仍留在新会话 | 不额外创建第二个会话 |
| `nano -r <id>` | 精确会话 id | 报错，不创建 | resume-only |
| `nano --root <id>` | 精确会话 id | 创建（保留旧语义） | 低级逃生口，不打开选择器 |

- `--root` 与 `-c` / `-r` 同时出现 → 启动报错：`--root 不能和 -c / -r 同时使用`。
- `-c` 与 `-r` 同时出现 → 启动报错：`-c 和 -r 只能选一个`。
- `purge`、`--help`、`--version` 的解析顺序不变；`--root` 的值仍不参与子命令判断。

### 3.2 默认新会话

- `resolveRootId` 不再读取 `<数据根>/last-root`；无 `--root` 时直接生成新 id。
- 新 id 沿用现行格式：`<UTC 时间戳>-<8 hex>`（`src/boot/root.ts:162-165`），不改为 UUID；官方 dsh 接受任意合法 id，现有会话 id 也保持可读。
- `last-root` 文件停止读写；保留在磁盘上不迁移、不删除；`nano purge` 仍会连带删除数据根。
- 每次 `nano` 启动都写 `last-session.json`（见 3.3），用于 `-c`；不写 `last-root`。

### 3.3 `-c`：当前目录最近使用的会话

**候选集**（全部满足）：

1. `header.cwd` 与当前 cwd 相同。比较时同时接受 `process.cwd()` 与 `realpathSync.native(process.cwd())` 两种写法；两者任一相等即命中。
2. 顶层会话：`header.parentSession === undefined`、`header.origin !== 'subagent'`、`(header.delegationDepth ?? 0) === 0`。子代理会话不参与 `-c`。
3. 官方列表里存在；能否真正恢复由认领与 resume 结果决定，不在候选阶段推断「可恢复」。

**排序**：

1. 先读 `<数据根>/last-session.json`（nano 自有导航提示，不是官方历史副本）：
   ```json
   { "version": 1, "byCwd": { "/abs/cwd": { "sessionId": "…", "lastUsedAt": 1793… } } }
   ```
   该文件原子写（tmp + fsync + rename，0600），启动成功与受控重启成功后更新。
2. 标记命中且会话仍在候选集 → 选它。
3. 标记缺失 / 损坏 / 指向的会话不在候选集 → 回退到官方列表按 `header.createdAt` 倒序，再按 id 升序取第一个。
4. 仍无候选 → 报错，不创建。

**边界**：

- `-c` 选中的会话若已被另一个窗口认领：挂载认领失败，显示 3.6 的占用文案；不自动改选下一个会话。
- `-c` 不跨目录；`-r <id>` / `--root <id>` 若跨目录，按 §3.4 的 cwd 规则处理（首版拒绝，不静默用启动 cwd）。
- `last-session.json` 只是提示；损坏、只读、写入失败都不得阻塞启动或 `-c`；失败只写诊断。

### 3.4 `-r`：会话选择器与精确恢复

**`-r <id>`**：

- 目标必须是已存在的顶层会话；NotFound 直接报错，不创建。
- 认领失败（被其他窗口占用）→ 显示 3.6 的占用文案。
- 成功后按现有受控重启路径启动，草稿经 handoff 带过。
- **跨目录恢复的 cwd**：目标会话的 `header.cwd` 可能与启动 cwd 不同。窗口的 UI 工作目录（`!` 人工命令、附件、文件引用、终端）必须切到会话的 effective working directory（`ctx.workingDirectory.get(session)`，其投影由 `header.cwd` 初始化），不能继续用 `process.cwd()`。首版若不能在启动前切换，直接拒绝：`该会话属于 <cwd>；请在该目录启动 nano。` 选择器里从「全部目录」选中的会话同样适用。

**`-r`（无 id）**：

- 复用默认新会话的启动：先按 `nano` 建一个新会话，再打开现有 `Ctrl+L` 会话面板（resume 模式）。不额外创建第二个会话，也不做启动前的一次性选择器。
- 面板默认只列当前 cwd 的顶层会话；`a` 切换「全部目录」。每行显示：标题（缺失时显示 id）、cwd、创建时间（官方 `header.createdAt`；官方未提供逐会话 lastUsedAt，不伪造）、当前标记；排序沿用官方 `sessionQuery` 的新优先（与 S07 一致），`last-session.json` 只在 `-c` 里用，不改变面板排序。
- Enter 选择 → 走现有受控重启进入目标会话；Esc 关闭面板，留在新会话。空列表显示「没有可恢复的会话；直接在新会话里开始，或按 `a` 看全部目录」。
- 选择后走与 `-r <id>` 相同的认领与启动路径。

**实现约束**：

- `-r` 复用默认新会话，不额外 create；若用户在选择前退出，这个新会话可能为空会话（官方 lazy persistence 决定是否落盘）；首版接受，不做删除。
- 复用官方 `sessionQuery` 与现有 `SessionsPanel`；不直接读会话日志文件、不按文件路径猜会话身份。
- 面板在 TUI 内打开，不新增启动前选择器；`Ctrl+L` 仍是同一面板的常规入口。

### 3.5 `--root <id>`

- 保留现有语义：先 resume，NotFound 才 create；返回的 session id 必须等于 `--root`，不一致硬失败。
- 不读 `last-root`；不写 `last-session.json` 之外的根状态。
- 帮助文案改为：`--root <id>  使用指定会话身份（不存在则新建；日常续接用 -c / -r）`。
- `--root` 是逃生口，不作为默认路径。

### 3.6 多窗口与会话所有权

- **一窗一会话**：每个窗口认领一个会话 id；不同会话可同时存在，各自拥有 storage、schedule、terminal、handoff、草稿与阅读位置。
- **同一会话单 writer**：第二个窗口对同一会话的认领必须失败；不删除锁、不强接管、不降级成新会话。
- **会话列表共享**：所有窗口看到同一个官方会话列表；`-c` / `-r` 可以打开其他窗口创建的会话（在对方释放 writer 之后）。
- **同仓库不同 worktree**：不同 cwd 的会话天然独立；这是推荐的多窗口用法。
- **错误文案**（用户可见，不出现「根」这个内部词）：
  - 占用：`会话 <id> 已在另一个窗口打开（pid <pid>）。开新窗口直接运行 nano；换一个会话用 nano -r；如果那个窗口已经不用了，关掉它再试。`
  - `-c` 无候选：`当前目录没有可续接的会话。直接运行 nano 开新会话。`
  - `-r <id>` 不存在：`会话 <id> 不存在。用 nano -r 打开选择器（跨目录先按 a 看全部目录）。`
  - `-r` 无候选：`没有可恢复的会话。直接运行 nano 开新会话。`

### 3.7 受控重启与会话切换

- 现有 `Ctrl+L` 会话面板的 Enter 切换仍走 `requestRestart`；切换成功后更新 `last-session.json` 的当前 cwd 记录。
- 切换失败仍按 S07 的失败矩阵处理：不新建替代会话、不丢掉草稿、不保留假旧窗口。
- `-c` / `-r` 选中的会话，切换语义与面板切换相同；不新增第二套重启路径。

## 4. 失败与不变量

1. **默认不续接**：`nano` 无参数不得 resume 任何已有会话；`last-root` 不得再影响启动目标。
2. **resume-only 不创建**：`-c` / `-r` 对 NotFound 必须报错；`create` 只能由默认启动或 `--root` 走到。
3. **同一会话单 writer**：认领失败不得删锁、不得接管、不得静默换会话。
4. **不猜身份**：会话身份只用官方 `sessionId`；不按 cwd 名、标题或文件路径推断。
5. **子代理排除**：`-c` 不得把 `origin: 'subagent'` / `delegationDepth > 0` / `parentSession != null` 的会话当成主会话。
6. **提示不阻塞**：`last-session.json` 损坏或写入失败只降级为官方列表排序，不影响启动。
7. **跨窗口隔离**：一个窗口的切换/退出不得影响另一个窗口的 writer、草稿、队列、审批、终端、Monitor 与调度。
8. **帮助与文档一致**：`nano --help`、README 与本文的启动矩阵一致；不再出现「默认沿用上一次的根」。
9. **跨目录恢复的 cwd 一致**：恢复后窗口的 `context.cwd` 必须是会话的 effective working directory；不得继续用启动 cwd，否则 `!` 与附件/文件引用会跑错目录。

## 5. 验收

- [ ] 同一仓库开两个 `nano`：生成两个不同会话 id；两个窗口都启动；`mount/` 下有两个锁；关闭 A 不终止 B。
- [ ] 不同 worktree 各开一个 `nano`：各自独立会话与 cwd；互不阻塞。
- [ ] `nano -c` 在当前 cwd：恢复该目录最近使用的顶层会话；历史、标题、cwd 与官方一致；没有新建会话文件。
- [ ] `nano -c` 在无会话的 cwd：报错并退出非 0；不创建会话。
- [ ] `nano -r`：先建新会话并打开会话面板；只列当前 cwd 顶层会话；`a` 切全部；选择后经受控重启进入；Esc 关闭面板并留在新会话（不额外创建第二个会话）。
- [ ] `nano -r` 空列表：显示「没有可恢复的会话…」，不崩溃、不额外 create。
- [ ] `--root` 与 `-c` / `-r` 同时出现：启动报互斥错误，不进入 TUI。
- [ ] `nano -r <id>` NotFound：报错，不创建同 id 空会话。
- [ ] 启动 / 受控重启成功后：`last-session.json` 的当前 cwd 记录更新为最新会话。
- [ ] `nano -r <id>`：精确恢复；NotFound 报错；被占用显示 pid 与出路。
- [ ] `nano --root <existing>`：恢复；`--root <new>`：创建；返回 id 不一致硬失败。
- [ ] 同一会话第二窗口：在进备用屏前拒绝；不删锁；第一窗口不受影响。
- [ ] `-c` 不选子代理会话；构造一个 `origin: 'subagent'` 的会话验证。
- [ ] `last-session.json` 损坏 / 只读：`-c` 仍能按官方 `createdAt` 回退，启动不失败。
- [ ] `last-root` 存在但被忽略：删除或篡改 `last-root` 不改变默认启动目标。
- [ ] `nano --help` 显示新的启动矩阵；不再出现「默认沿用上一次的根」。
- [ ] `-r <id>` 跨目录：窗口的 `!` / 文件引用使用会话的 effective working directory；若实现选择拒绝，错误文案明确且不创建会话。
- [ ] 真实 PTY 证据：两个窗口的会话 id、锁文件、`-c` 命中结果、占用文案。

## 6. 机制清单

| 机制 | 解决什么 / 没有会怎样 | 确认与代价 |
| --- | --- | --- |
| M1 默认新会话 | 每次 `nano` 得到独立上下文；没有则所有窗口撞同一个 `last-root` | 用户 2026-11-02 明确「默认打开 nano 应该是新的上下文」；代价是续接要显式 `-c` / `-r` |
| M2 `-c` 按 cwd 续最近 | 一个目录一条连续工作线；没有则只能手工 `--root` | 与 Claude Code `-c` 对齐；只做当前目录，不跨目录 |
| M3 `-r` 会话面板 / 精确 id | 显式挑选已有会话；没有则只能翻 `Ctrl+L` 或记 id | 复用官方 `sessionQuery` 与现有 `SessionsPanel`；`-r` 先建默认新会话再开面板，不额外 create |
| M4 每 cwd 的 last-session 提示 | 让 `-c` 选「最近使用」而不是「最近创建」；没有则重开旧会话后 `-c` 会选错 | nano 自有导航提示，不是官方历史副本；损坏可回退 |
| M5 resume-only | 防止 `-c` / `-r` 目标不存在时偷偷开空会话；没有则用户以为历史回来了 | 复用现有 resume-first 规则；NotFound 必须是硬错误 |
| M6 一窗一会话 + 占用出路 | 多窗口可并存，同一会话不双写；没有则第二个窗口只能看死错误 | 保留挂载锁与 S07 的拒绝路径；只改文案与默认目标 |
| M7 跨目录 cwd 一致 | 恢复后 UI 用会话 effective cwd，避免 `!` / 文件引用跑错目录 | 与 S07 的 live 切换拒绝区分：`-r` 是新启动，不是在线切换；首版可拒绝跨目录 |

## 7. 自定细节

- 新会话 id 继续用 `<UTC 时间戳>-<8 hex>`；不改成 UUID，避免无收益的迁移。
- `last-session.json` 放在数据根下，格式 `{ version: 1, byCwd: { <cwd>: { sessionId, lastUsedAt } } }`；只保留最近使用的 N 条（N 由实现定，建议 100），避免无限增长。
- `-c` 的 cwd 比较同时接受 `process.cwd()` 与 `realpathSync.native(process.cwd())`；两者任一匹配即可。
- `-c` 的排序回退是 `header.createdAt` 倒序 + id 升序；不使用官方 `.jsonl` 的 mtime（Claude Code 的 mtime 会被元数据写入污染，nano 不复制这个问题）。
- `-r` 复用默认新会话 + 现有 `SessionsPanel`；不做启动前的一次性选择器，不写 `/dev/tty`。
- `-r` 默认只列当前 cwd；`a` 切换全部目录；排序沿用官方 `sessionQuery` 的新优先，`last-session.json` 只在 `-c` 里用。
- 跨目录恢复的 UI cwd 用 `ctx.workingDirectory.get(session)`；首版若无法在启动前切换，按 §3.4 拒绝，不静默用启动 cwd。
- `--root` 保留 resume-or-create；这是唯一会在 NotFound 时创建的低级入口。
- `last-root` 停止读写但不删除；`nano purge` 仍会删除整个数据根。
- `-c` / `-r` 的占用判定以挂载认领为准；不用官方 `live` 标志猜跨进程状态。
- 不新增 `--fork-session`；需要时另立 spec。
- 错误文案不出现「根」「sessionId」等内部词；用户侧统一说「会话」。

## 8. 审核修订记录

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 阻断 | `-r`「core 已 boot、尚未创建 agent」与启动顺序不符，storage-json 根在选前无 rootId | 已改：`-r` 改为「先建默认新会话 + 打开现有 SessionsPanel」，删除启动前选择器与 `/dev/tty` |
| 2 | 重要 | 跨目录 cwd 处理是新机制，§6 未收录，且未说明与 S07 的关系 | 已改：新增 M7；明确 `-r` 是新启动、不是 S07 的 live 切换；首版可拒绝 |
| 3 | 重要 | 候选条件「可恢复」无数据源，S07 明确列表不推断 | 已改：候选只要求官方列表存在；能否恢复由认领/resume 决定 |
| 4 | 重要 | 验收缺 `-r` 空列表、`--root` 互斥、`-r <id>` NotFound、last-session 更新 | 已改：§5 已补 4 项 |
| 5 | 重要 | 新 ADR 未处理 ADR-20261029 的「否决每次启动生成新 id」 | 已改：spec 头部与 ADR 明确「局部取代」该否决条，resume-first 继续有效 |
| 6 | 轻微 | 回退排序用 id 倒序，官方是 id 升序 | 已改：§3.3 / §7 改为 id 升序 |
| 7 | 轻微 | 会话面板读取 cwd 但渲染不显示；入口引用错 | 已改：§2 改为「读取标题/cwd、渲染只显示标题」并补 `feature-keys.ts:33` |
| 8 | 轻微 | root.ts / types.d.ts / main.tsx 行号范围偏差 | 已改：57-70、59-88、3101-3117 |
| 9 | 轻微 | 外部证据无链接 | 已改：补 sessions 文档与 issue 链接 |
| 10 | 轻微 | `-r <id>` 文案未提跨目录需按 `a` | 已改：文案补「跨目录先按 a 看全部目录」 |
| 11 | 轻微 | `-r` 选择器按 lastUsedAt 排序，与 S07 官方新优先冲突 | 已改：面板沿用官方新优先；`last-session.json` 只服务 `-c` |
| 12 | 重要 | §3.4 要求面板显示「最近使用时间」，但官方 header 只有 `createdAt`；实现显示创建时间，spec 未留例外 | 已改：§3.4 改为「创建时间（官方 `header.createdAt`；不伪造 lastUsedAt）」 |
